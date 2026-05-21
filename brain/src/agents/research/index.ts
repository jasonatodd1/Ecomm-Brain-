import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { supabase } from '../../lib/supabase.js';
import { log } from '../../lib/log.js';
import { searchEtsy, sanitizeJsonbDeep } from '../../lib/etsy-search.js';
import { mapWithLimit } from '../../lib/concurrency.js';

import {
  buildKeywordExtractionPrompt,
  buildSynthesisPrompt
} from './prompts.js';
import { renderBriefAsMarkdown } from './render-markdown.js';
import { computeAggregates, type MarketAggregates } from './aggregates.js';
import { computeCompetitiveLandscape } from './competitive.js';
import type {
  DecisionRecord,
  EtsySearchResult,
  NicheMemoryRow,
  ProductBrief
} from './types.js';

const OPUS_MODEL = 'claude-opus-4-7';
const KEYWORD_COST_USD = 0.05;
// Tuning Pass 2 enlarges synthesis output substantially: structured
// listing.description, attribute_intent, image_spec, competitive_landscape.
// Budget bumped from $0.20 (v1) to $0.30 (v2) to reflect the larger output.
const SYNTHESIS_COST_USD = 0.3;
const AGENT_VERSION = 'research-v2';

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Missing ANTHROPIC_API_KEY environment variable');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// Strip optional ```json fences Haiku/Opus sometimes wrap output in.
function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function getTextFromResponse(message: Anthropic.Message): string {
  const block = message.content[0];
  if (block && block.type === 'text') return block.text;
  throw new Error('Anthropic response did not contain a text block');
}

interface ResearchResult {
  briefId: string;
  totalCostUsd: number;
}

export async function researchDecision(
  decisionId: string
): Promise<ResearchResult> {
  let totalCostUsd = 0;
  let claimed = false;
  let currentStep = 'init';

  // Step 1 — Create agent_runs row (outside try/catch; if this fails, abort)
  const { data: runRow, error: runErr } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'research',
      status: 'running',
      input_ref: decisionId,
      model_used: OPUS_MODEL,
      cost_usd: 0
    })
    .select('id')
    .single();

  if (runErr || !runRow) {
    throw new Error(
      `Failed to create agent_runs row: ${runErr?.message ?? 'unknown'}`
    );
  }

  const runId = runRow.id as string;

  try {
    // Step 2 — Claim decision atomically
    currentStep = 'claim_decision';
    const { data: claimedRows, error: claimErr } = await supabase
      .from('decisions_needed')
      .update({
        status: 'researching',
        claimed_by: 'research',
        claimed_at: new Date().toISOString()
      })
      .eq('id', decisionId)
      .eq('status', 'open')
      .select('id, title, description, context, urgency, status');

    if (claimErr) {
      throw new Error(`Claim query failed: ${claimErr.message}`);
    }

    if (!claimedRows || claimedRows.length === 0) {
      throw new Error(
        "decision not in 'open' state — already claimed or wrong status"
      );
    }

    claimed = true;
    const decision = claimedRows[0] as DecisionRecord;

    // Step 3 — Identify niche tags & pull memory
    currentStep = 'load_niche_memory';
    const ctx = decision.context;
    const subreddit =
      typeof ctx['subreddit'] === 'string' ? ctx['subreddit'] : '';
    const source = typeof ctx['source'] === 'string' ? ctx['source'] : '';
    const nicheTag =
      source === 'reddit' && subreddit ? subreddit : 'general';

    const { data: nicheData, error: nicheErr } = await supabase
      .from('niche_memory')
      .select(
        'niche_tag, memory_key, memory_value, confidence, source, evidence_count, last_updated_at'
      )
      .eq('niche_tag', nicheTag);

    if (nicheErr) {
      throw new Error(`Failed to load niche_memory: ${nicheErr.message}`);
    }

    const nicheMemory = (nicheData ?? []) as NicheMemoryRow[];

    // Step 4 — Read agent_config (V1: presence only)
    currentStep = 'load_agent_config';
    await supabase
      .from('agent_config')
      .select('config_key, config_value')
      .eq('agent_name', 'research');

    // Step 5 — Extract keywords via Opus
    currentStep = 'extract_keywords';
    const anthropic = getAnthropic();

    const keywordPrompt = buildKeywordExtractionPrompt(decision);
    const keywordResp = await anthropic.messages.create({
      model: OPUS_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: keywordPrompt }]
    });
    totalCostUsd += KEYWORD_COST_USD;

    await log({
      agent: 'intel',
      action: 'cost.api_call',
      description: 'Opus keyword extraction',
      metadata: {
        provider: 'anthropic',
        model: OPUS_MODEL,
        step: 'keyword_extraction',
        estimated_cost_usd: KEYWORD_COST_USD
      }
    });

    const keywordText = stripJsonFences(getTextFromResponse(keywordResp));
    const keywords = JSON.parse(keywordText) as unknown;
    if (
      !Array.isArray(keywords) ||
      !keywords.every((k): k is string => typeof k === 'string')
    ) {
      throw new Error(
        `Keyword extraction did not return string[]: ${keywordText.slice(0, 200)}`
      );
    }

    // Step 6 — Search Etsy per keyword (rate-limited: 2 in-flight, 200ms stagger).
    // Keep BOTH the per-keyword arrays (for competitive scoring in step 6.6) AND
    // the global deduplicated list (for synthesis prompt + market aggregates).
    currentStep = 'search_etsy';
    const searchArrays = await mapWithLimit(keywords, 2, 200, k =>
      searchEtsy(k, { limit: 25 })
    );

    const resultsByKeyword = new Map<string, EtsySearchResult[]>();
    keywords.forEach((k, i) => resultsByKeyword.set(k, searchArrays[i] ?? []));

    const seen = new Set<string>();
    const searchResults: EtsySearchResult[] = [];
    for (const arr of searchArrays) {
      for (const r of arr) {
        const key =
          r.listing_id > 0
            ? `id:${r.listing_id}`
            : r.url || `${r.shop_id}::${r.title}`;
        if (!seen.has(key) && key.length > 0) {
          seen.add(key);
          searchResults.push(r);
        }
      }
    }
    // Etsy Open API is free — no cost accumulation needed here.

    // Step 6.5 — Compute market aggregates in code (LLMs are unreliable at stats).
    // This step also fan-out fetches shop info for the top 5 sellers in parallel.
    const aggregates = await computeAggregates(searchResults);

    // Step 6.6 — Competitive SEO scoring (Tuning Pass 2, COMPETITIVE_SEO_SCORING.md §4).
    // For each keyword, score the top 10 incumbents and emit a structured
    // landscape entry that synthesis cites as evidence for weak-incumbent gaps.
    // Etsy listing fetches are free; ~30-50 unique listings per brief, ~20-30s at
    // mapWithLimit(2, 200ms).
    currentStep = 'competitive_landscape';
    const competitive = await computeCompetitiveLandscape({
      keywords,
      resultsByKeyword,
      topN: 10
    });

    // Step 7 — Synthesize brief via Opus
    currentStep = 'synthesize_brief';
    const synthesisPrompt = buildSynthesisPrompt(
      decision,
      nicheMemory,
      searchResults,
      aggregates,
      competitive.landscape
    );
    const synthesisResp = await anthropic.messages.create({
      model: OPUS_MODEL,
      // Tuning Pass 2 brief is substantially larger than v1: adds structured
      // listing.description (~700-900 output tokens), attribute_intent, image_spec
      // (4+ entries), competitive_landscape (per-keyword incumbents), and the
      // audience persona. Budget headroom at 12000 to be safe; observed actual
      // ~6500-7500 output tokens per v2 brief.
      max_tokens: 12000,
      messages: [{ role: 'user', content: synthesisPrompt }]
    });
    totalCostUsd += SYNTHESIS_COST_USD;

    await log({
      agent: 'intel',
      action: 'cost.api_call',
      description: 'Opus brief synthesis',
      metadata: {
        provider: 'anthropic',
        model: OPUS_MODEL,
        step: 'synthesis',
        estimated_cost_usd: SYNTHESIS_COST_USD
      }
    });

    const synthesisText = stripJsonFences(getTextFromResponse(synthesisResp));
    const briefRaw = JSON.parse(synthesisText) as unknown;
    const brief = validateBrief(briefRaw);

    // Step 7.5 — Drift detection: trust computed aggregates over LLM output
    await reconcileNumericDrift(brief, aggregates, decisionId);

    // Step 9 (numbering follows spec; markdown rendered after we know briefId)
    // Save to product_briefs.
    // sanitizeJsonbDeep guards the inserts against NUL/control bytes that
    // Postgres jsonb rejects ("Empty or invalid json"). Two sources of risk:
    // (1) LLM-synthesized strings sometimes contain stray control chars; and
    // (2) raw_research carries decision context that originates from Reddit
    // comments which historically have control chars from copy-paste tooling.
    currentStep = 'save_brief';
    const sanitizedBrief = sanitizeJsonbDeep(brief) as Record<string, unknown>;
    const sanitizedRawResearch = sanitizeJsonbDeep({
      keywords,
      search_results: searchResults,
      decision_snapshot: decision
    }) as Record<string, unknown>;

    // Diagnostic dump (kept on disk under dist/ for any save_brief failure).
    // Cheap insurance — gives the operator the exact JSON Supabase rejected
    // without having to re-run a $0.30 Opus call to reproduce.
    const distDir = path.resolve(process.cwd(), 'dist');
    await mkdir(distDir, { recursive: true });
    const debugPath = path.join(
      distDir,
      `brief-attempt-${decisionId.slice(0, 8)}-${Date.now()}.json`
    );
    await writeFile(
      debugPath,
      JSON.stringify({ brief: sanitizedBrief, raw_research: sanitizedRawResearch }, null, 2),
      'utf-8'
    );

    const { data: briefRow, error: briefInsErr } = await supabase
      .from('product_briefs')
      .insert({
        decision_id: decisionId,
        brief: sanitizedBrief,
        raw_research: sanitizedRawResearch,
        recommendation: brief.recommendation,
        confidence: brief.confidence,
        cost_usd: totalCostUsd,
        agent_version: AGENT_VERSION
      })
      .select('id')
      .single();

    if (briefInsErr) {
      console.error(
        `  insert failed; debug payload at ${debugPath} (size ${JSON.stringify({ brief: sanitizedBrief, raw_research: sanitizedRawResearch }).length} bytes)`
      );
    }

    if (briefInsErr || !briefRow) {
      throw new Error(
        `Failed to insert product_brief: ${briefInsErr?.message ?? 'unknown'}`
      );
    }

    const briefId = briefRow.id as string;

    // Step 8 — Render markdown (now that briefId exists)
    currentStep = 'render_markdown';
    const markdown = renderBriefAsMarkdown(brief, decision, {
      briefId,
      costUsd: totalCostUsd,
      agentVersion: AGENT_VERSION
    });

    // Update brief row with markdown
    const { error: mdUpdateErr } = await supabase
      .from('product_briefs')
      .update({ markdown })
      .eq('id', briefId);

    if (mdUpdateErr) {
      throw new Error(`Failed to save markdown: ${mdUpdateErr.message}`);
    }

    // Step 10 — Write opportunity gaps to niche_memory
    currentStep = 'write_niche_memory';
    for (const gap of brief.market_summary.opportunity_gaps) {
      const memoryKey = gap.toLowerCase().trim().slice(0, 200);
      if (!memoryKey) continue;

      const { data: existing, error: fetchErr } = await supabase
        .from('niche_memory')
        .select('id, evidence_count')
        .eq('niche_tag', nicheTag)
        .eq('memory_key', memoryKey)
        .maybeSingle();

      if (fetchErr) {
        console.error(`  niche_memory fetch error for "${memoryKey}":`, fetchErr.message);
        continue;
      }

      if (existing) {
        const newCount = (existing.evidence_count ?? 1) + 1;
        const { error: updErr } = await supabase
          .from('niche_memory')
          .update({
            evidence_count: newCount,
            last_updated_at: new Date().toISOString()
          })
          .eq('id', existing.id);
        if (updErr) {
          console.error(`  niche_memory update error:`, updErr.message);
        }
      } else {
        const { error: insErr } = await supabase.from('niche_memory').insert({
          niche_tag: nicheTag,
          memory_key: memoryKey,
          memory_value: {
            observed_in_brief: briefId,
            gap_description: gap
          },
          confidence: 0.5,
          source: 'research_agent',
          evidence_count: 1
        });
        if (insErr) {
          console.error(`  niche_memory insert error:`, insErr.message);
        }
      }
    }

    // Step 11 — Save markdown to disk
    currentStep = 'save_markdown_disk';
    const briefsDir = path.resolve(process.cwd(), 'briefs');
    await mkdir(briefsDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${dateStr}-${decisionId.slice(0, 8)}.md`;
    const filepath = path.join(briefsDir, filename);
    await writeFile(filepath, markdown, 'utf-8');

    console.log(`  brief markdown written to ${filepath}`);

    // Step 12 — Release claim, advance status to brief_ready
    currentStep = 'release_claim';
    const { error: releaseErr } = await supabase
      .from('decisions_needed')
      .update({
        status: 'brief_ready',
        claimed_by: null,
        claimed_at: null
      })
      .eq('id', decisionId);

    if (releaseErr) {
      throw new Error(`Failed to release claim: ${releaseErr.message}`);
    }
    claimed = false; // success path — claim already released

    // Step 13 — Complete agent_runs
    currentStep = 'complete_agent_run';
    const { error: completeErr } = await supabase
      .from('agent_runs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        output_ref: briefId,
        cost_usd: totalCostUsd,
        metadata: {
          keywords_used: keywords,
          num_listings: searchResults.length,
          etsy_searches: keywords.length,
          competitive_landscape: competitive.landscape.map(l => ({
            keyword: l.keyword,
            classification: l.classification,
            median_percent: Math.round(l.median_percent * 100),
            scored_count: l.scored_count
          })),
          competitive_stats: competitive.stats
        }
      })
      .eq('id', runId);

    if (completeErr) {
      throw new Error(`Failed to complete agent_runs: ${completeErr.message}`);
    }

    await log({
      agent: 'intel',
      action: 'research.complete',
      description: `Research brief generated for decision ${decisionId.slice(0, 8)} (${brief.recommendation}, confidence ${brief.confidence.toFixed(2)})`,
      severity: 'success',
      metadata: {
        decision_id: decisionId,
        brief_id: briefId,
        recommendation: brief.recommendation,
        confidence: brief.confidence,
        cost_usd: totalCostUsd,
        markdown_path: filepath
      }
    });

    return { briefId, totalCostUsd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await log({
      agent: 'intel',
      action: 'research.failed',
      description: `Research failed at step "${currentStep}" for decision ${decisionId.slice(0, 8)}`,
      severity: 'error',
      metadata: {
        decision_id: decisionId,
        run_id: runId,
        step: currentStep,
        error: msg
      }
    });

    if (claimed) {
      await supabase
        .from('decisions_needed')
        .update({ status: 'open', claimed_by: null, claimed_at: null })
        .eq('id', decisionId);
    }

    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: msg,
        cost_usd: totalCostUsd
      })
      .eq('id', runId);

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Brief shape validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Drift detection — reconcile LLM numeric output against computed aggregates.
// LLMs are unreliable at statistics. Always trust computed values; log drift
// when the LLM diverges so we can monitor model behaviour.
// ---------------------------------------------------------------------------

const PRICE_EPSILON = 0.01;

function pricesDiffer(a: number | undefined, b: number): boolean {
  if (typeof a !== 'number') return true;
  return Math.abs(a - b) > PRICE_EPSILON;
}

async function reconcileNumericDrift(
  brief: ProductBrief,
  aggregates: MarketAggregates,
  decisionId: string
): Promise<void> {
  const llm = brief.market_summary;

  const drift: Record<string, { llm: unknown; computed: unknown }> = {};

  if (llm.listings_analyzed !== aggregates.listings_analyzed) {
    drift['listings_analyzed'] = {
      llm: llm.listings_analyzed,
      computed: aggregates.listings_analyzed
    };
  }
  if (pricesDiffer(llm.median_price, aggregates.median_price)) {
    drift['median_price'] = {
      llm: llm.median_price,
      computed: aggregates.median_price
    };
  }
  if (
    !llm.price_range ||
    pricesDiffer(llm.price_range.p25, aggregates.price_range.p25) ||
    pricesDiffer(llm.price_range.p50, aggregates.price_range.p50) ||
    pricesDiffer(llm.price_range.p75, aggregates.price_range.p75)
  ) {
    drift['price_range'] = {
      llm: llm.price_range,
      computed: aggregates.price_range
    };
  }
  if (llm.median_favorers !== aggregates.median_favorers) {
    drift['median_favorers'] = {
      llm: llm.median_favorers,
      computed: aggregates.median_favorers
    };
  }

  // Always override with computed values — they are the source of truth.
  brief.market_summary.listings_analyzed = aggregates.listings_analyzed;
  brief.market_summary.median_price = aggregates.median_price;
  brief.market_summary.price_range = aggregates.price_range;
  brief.market_summary.median_favorers = aggregates.median_favorers;

  if (Object.keys(drift).length > 0) {
    await log({
      agent: 'intel',
      action: 'synthesis.numeric_drift',
      description: `LLM market_summary numbers diverged from computed aggregates (${Object.keys(drift).join(', ')})`,
      severity: 'warning',
      metadata: {
        decision_id: decisionId,
        drift
      }
    });
  }
}

function validateBrief(raw: unknown): ProductBrief {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Synthesis output is not an object');
  }
  const r = raw as Record<string, unknown>;

  const required = [
    'recommendation',
    'confidence',
    'reasoning',
    'product',
    'listing',
    'pricing',
    'market_summary',
    'risks'
  ];
  for (const key of required) {
    if (!(key in r)) {
      throw new Error(`Synthesis output missing required field: ${key}`);
    }
  }

  if (!['proceed', 'pivot', 'pass'].includes(r['recommendation'] as string)) {
    throw new Error(`Invalid recommendation value: ${r['recommendation']}`);
  }

  if (typeof r['confidence'] !== 'number') {
    throw new Error('Invalid confidence value');
  }

  return r as unknown as ProductBrief;
}
