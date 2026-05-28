// Opportunity scanner (MVP) — market-wide attackability scoring engine.
//
// Ranks Etsy niches by where a zero-review, AI-pipeline shop can realistically
// win. For each candidate keyword it: pulls the top organic listings, models
// sales from review counts, scores three pillars (Demand / Attackability /
// AI-fit) via opportunity-scoring.ts, then persists + writes a ranked report.
//
// Data spine (reuses existing clients — NO new HTTP fetchers / auth):
//   - Etsy API (etsy-search.ts): listing facts + ranking + per-listing reviews.
//     searchEtsy() is the Etsy `listings/active` endpoint (relevance-ordered);
//     there is no SerpApi Etsy module in this repo (that wrapper was abandoned).
//   - Our model (opportunity-scoring.ts): sales estimate from review counts.
//   - Anthropic (Haiku): incumbent classification + SEO + specificity judgment.
//   - Anthropic (Sonnet): one-line rationale + named wedge for survivors only.
//
// Error handling matches the pipeline pattern: per-keyword failures log + skip
// + keep going; one bad keyword never crashes the scan or corrupts state.

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import {
  searchEtsy,
  getListing,
  getListingReviews
} from '../lib/etsy-search.js';
import { mapWithLimit } from '../lib/concurrency.js';
import {
  scoreOpportunity,
  modelSales,
  OPPORTUNITY_SCORER_VERSION,
  REVIEW_TO_SALES_MULTIPLIER,
  type AnalyzedListing,
  type IncumbentLlmAssessment,
  type ProductType,
  type OpportunityScoreResult
} from '../lib/opportunity-scoring.js';

// ===========================================================================
// Run config (gather knobs — distinct from the scoring constants, which all
// live in opportunity-scoring.ts).
// ===========================================================================
const SEARCH_FETCH = 24; // top organic listings to pull per keyword
const ANALYZE_LIMIT = 15; // listings to enrich + analyze after dedup (cost knob)
const MAX_PER_SHOP = 3; // dedupe: one shop can't occupy more than this many slots
// Etsy's reviews endpoint rate-limits aggressively; review_count is the single
// most load-bearing signal, so we collect conservatively (1-in-flight) and
// retry on 429 rather than corrupting scores with under-counted reviews.
const ENRICH_CONCURRENCY = 1;
const ENRICH_STAGGER_MS = 250;
const INTRA_LISTING_DELAY_MS = 250; // between getListing and getListingReviews
const RETRY_BACKOFF_MS = 1200; // base backoff; grows linearly per attempt
const LISTING_RETRIES = 3; // getListing attempts before giving up
const REVIEW_RETRIES = 3; // review-count attempts before marking UNKNOWN
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

// Approximate list prices (USD per 1M tokens) for RUN-COST REPORTING ONLY.
// FIRST-PASS, verify against current Anthropic pricing.
const HAIKU_PRICE_IN = 1.0;
const HAIKU_PRICE_OUT = 5.0;
const SONNET_PRICE_IN = 3.0;
const SONNET_PRICE_OUT = 15.0;

const SEED_FILE = path.resolve(process.cwd(), 'config/opportunity-seed-keywords.txt');

// ===========================================================================
// Keyword input — --keywords="a,b,c" overrides the seed file.
// ===========================================================================
async function resolveKeywords(): Promise<string[]> {
  const arg = process.argv.find(a => a.startsWith('--keywords='));
  if (arg) {
    return arg
      .slice('--keywords='.length)
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
  }
  const raw = await readFile(SEED_FILE, 'utf-8');
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

// ===========================================================================
// Anthropic client (lazy, same pattern as classify-trend-relevance.ts).
// ===========================================================================
let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing ANTHROPIC_API_KEY. Add it to .env.local and Railway Variables.'
      );
    }
    anthropic = new Anthropic({ apiKey });
  }
  return anthropic;
}

const cost = {
  haiku_in: 0,
  haiku_out: 0,
  sonnet_in: 0,
  sonnet_out: 0,
  haiku_calls: 0,
  sonnet_calls: 0
};

function totalCostUsd(): number {
  return (
    (cost.haiku_in * HAIKU_PRICE_IN) / 1_000_000 +
    (cost.haiku_out * HAIKU_PRICE_OUT) / 1_000_000 +
    (cost.sonnet_in * SONNET_PRICE_IN) / 1_000_000 +
    (cost.sonnet_out * SONNET_PRICE_OUT) / 1_000_000
  );
}

function stripJsonFence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

// ===========================================================================
// Step 1+ — gather: search, dedupe, enrich.
// ===========================================================================
// A gathered listing carries a NULLABLE review_count: null = "couldn't fetch"
// (e.g. exhausted 429 retries), which is NOT the same as a genuine 0 reviews.
// Unknown-review listings are excluded from the median/demand math downstream
// so rate-limiting can't masquerade as a soft, beatable niche.
interface GatheredListing {
  listing_id: number;
  shop_id: number;
  rank: number;
  title: string;
  tags: string[];
  review_count: number | null;
  review_count_known: boolean;
  age_months: number | null;
  age_missing: boolean;
  price: number | null;
  image_count: number | null;
  url: string;
}

function deriveCreationTs(raw: Record<string, unknown>): number | null {
  for (const key of ['original_creation_timestamp', 'created_timestamp', 'creation_timestamp']) {
    const v = raw[key];
    if (typeof v === 'number' && v > 0) return v;
  }
  return null;
}

function deriveImageCount(raw: Record<string, unknown>): number | null {
  const imgs = raw['images'];
  if (Array.isArray(imgs)) return imgs.length;
  return null;
}

async function fetchListingWithRetry(listingId: number) {
  for (let attempt = 0; attempt < LISTING_RETRIES; attempt++) {
    const details = await getListing(listingId);
    if (details) return details;
    // null can be a genuine 404 or a 429 (getListing logs but doesn't expose
    // which). Backing off + retrying recovers 429s; genuine 404s just retry
    // cheaply and stay null.
    await sleep(RETRY_BACKOFF_MS * (attempt + 1));
  }
  return null;
}

/** Returns the listing's true review count, or null when 429s were never cleared. */
async function fetchReviewCountWithRetry(listingId: number): Promise<number | null> {
  for (let attempt = 0; attempt < REVIEW_RETRIES; attempt++) {
    const r = await getListingReviews(listingId, { maxReviews: 1, pageSize: 1 });
    // rate_limited_429 === 0 means the request completed: total_available is the
    // listing's real review count (0 is a legitimate "brand-new listing" value).
    if (r.rate_limited_429 === 0) return r.total_available;
    await sleep(RETRY_BACKOFF_MS * (attempt + 1));
  }
  return null;
}

interface GatherOutcome {
  listings: GatheredListing[];
  review_coverage: number; // share of analyzed listings with a known review_count
}

async function gatherListings(keyword: string): Promise<GatherOutcome> {
  // NOTE on ranking (KEY LIMITATION): Etsy's public API cannot reproduce the
  // on-site organic/best-match order, and it cannot surface a niche's true
  // high-review incumbents. We tested sort_on='score' (Etsy's relevance score)
  // and it was strictly WORSE here — it returned obscure/near-zero-review
  // listings and collapsed every demand_pool toward 0 (Etsy itself documents
  // that API 'score' != website relevancy). The default (sort_on=created,
  // newest-first) empirically surfaces more real incumbents, so we use it —
  // while accepting that median_reviews/demand_pool are a biased proxy, not a
  // true read of the niche's leaders. This is the #1 thing to fix (e.g. via a
  // paid keyword/volume tool) before trusting the demand pillar.
  const search = await searchEtsy(keyword, { limit: SEARCH_FETCH });
  if (search.length === 0) return { listings: [], review_coverage: 0 };

  // Dedupe: cap MAX_PER_SHOP slots per shop, preserving organic rank order.
  const perShop = new Map<number, number>();
  const deduped = [] as typeof search;
  for (const r of search) {
    const count = perShop.get(r.shop_id) ?? 0;
    if (r.shop_id > 0 && count >= MAX_PER_SHOP) continue;
    perShop.set(r.shop_id, count + 1);
    deduped.push(r);
    if (deduped.length >= ANALYZE_LIMIT) break;
  }

  const enriched = await mapWithLimit(
    deduped,
    ENRICH_CONCURRENCY,
    ENRICH_STAGGER_MS,
    async (r, idx): Promise<GatheredListing> => {
      const details = await fetchListingWithRetry(r.listing_id);
      await sleep(INTRA_LISTING_DELAY_MS);
      const reviewCount = await fetchReviewCountWithRetry(r.listing_id);

      const createdTs = details ? deriveCreationTs(details.raw) : null;
      const ageMonths =
        createdTs != null ? (Date.now() - createdTs * 1000) / MS_PER_MONTH : null;

      return {
        listing_id: r.listing_id,
        shop_id: r.shop_id,
        rank: idx,
        title: details?.title || r.title,
        tags: details?.tags ?? [],
        review_count: reviewCount,
        review_count_known: reviewCount != null,
        age_months: ageMonths != null ? Math.round(ageMonths * 10) / 10 : null,
        age_missing: ageMonths == null,
        price: details?.price_cents != null ? details.price_cents / 100 : r.price,
        image_count: details ? deriveImageCount(details.raw) : null,
        url: r.url
      };
    }
  );

  const knownCount = enriched.filter(e => e.review_count_known).length;
  return {
    listings: enriched,
    review_coverage: enriched.length > 0 ? knownCount / enriched.length : 0
  };
}

/** Project the known-review listings into the pure scorer's input shape. */
function toAnalyzed(listings: GatheredListing[]): AnalyzedListing[] {
  return listings
    .filter(l => l.review_count_known && l.review_count != null)
    .map(l => {
      const { est_lifetime_sales, est_monthly_sales } = modelSales(
        l.review_count as number,
        l.age_months
      );
      return {
        listing_id: l.listing_id,
        shop_id: l.shop_id,
        rank: l.rank,
        title: l.title,
        tags: l.tags,
        review_count: l.review_count as number,
        age_months: l.age_months,
        age_missing: l.age_missing,
        price: l.price,
        image_count: l.image_count,
        est_lifetime_sales,
        est_monthly_sales
      };
    });
}

// ===========================================================================
// Step 3 — Haiku: one structured call per keyword for classification + SEO +
// specificity (cheaper + more coherent than three separate calls).
// ===========================================================================
const HAIKU_SYSTEM = `You analyze the top Etsy listings for a search keyword to assess how beatable the niche is for a new, zero-review shop running an AI content pipeline.

You will receive the keyword and the top ~10 organic listings (title + tags). Judge FOUR things and return JSON only.

1. seo_quality (0-100): How strong/optimized are these incumbents' titles and tags overall? 90+ = polished, keyword-rich, 13 tags, no waste. 40 = sloppy, thin, repetitive, wasted tags, weak titles. Lower = more attackable.

2. specificity_gap (0-100): Are the top listings GENERIC (broad one-size-fits-all) while an obvious more-specific sub-niche or persona is underserved? 80+ = clearly generic, a sharper sub-niche would stand out. 20 = already highly specific/saturated, little room. Higher = bigger opening.

3. product_type: the DOMINANT product type across these listings, one of:
   - "content_structure": templates, planners, trackers, spreadsheets, documents, business systems, checklists, guides — value is in structure/text/logic. (AI pipeline is a strong edge.)
   - "craft_taste": illustration, hand-drawn art, photography, Lightroom presets, fonts, clip art — value is in artistic taste/craft. (AI pipeline is weak / risky.)
   - "mixed": genuinely split between the two.

4. ai_fit_raw (0-100): place a score WITHIN the band for product_type — content_structure 80-100, mixed 40-60, craft_taste 0-30.

5. ai_art_generation_heavy (boolean): true ONLY if the niche is dominated by AI-GENERATED ARTWORK / image generation as the product (high Etsy 2026 takedown risk), e.g. "ai art print", "midjourney wall art". Templates/planners are NOT ai_art_generation_heavy even if we'd build them with AI.

6. dominant_product_summary: one short phrase naming what these listings actually are.

Respond with valid JSON only, no markdown:
{"seo_quality":0-100,"specificity_gap":0-100,"product_type":"content_structure"|"mixed"|"craft_taste","ai_fit_raw":0-100,"ai_art_generation_heavy":true|false,"dominant_product_summary":"..."}`;

function isProductType(s: unknown): s is ProductType {
  return s === 'content_structure' || s === 'mixed' || s === 'craft_taste';
}

async function assessIncumbents(
  keyword: string,
  top: GatheredListing[]
): Promise<IncumbentLlmAssessment> {
  const sample = top
    .slice(0, 10)
    .map((l, i) => {
      const tags = l.tags.length > 0 ? l.tags.join(', ') : '(no tags returned)';
      return `${i + 1}. TITLE: ${l.title}\n   TAGS: ${tags}`;
    })
    .join('\n');

  const userMessage = `Keyword: ${keyword}\n\nTop listings:\n${sample}`;

  const message = await getClient().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: HAIKU_SYSTEM,
    messages: [{ role: 'user', content: userMessage }]
  });

  cost.haiku_calls++;
  cost.haiku_in += message.usage?.input_tokens ?? 0;
  cost.haiku_out += message.usage?.output_tokens ?? 0;

  const rawText =
    message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = JSON.parse(stripJsonFence(rawText)) as Record<string, unknown>;

  const product_type = isProductType(parsed['product_type'])
    ? parsed['product_type']
    : 'mixed';

  return {
    seo_quality: clampNum(parsed['seo_quality'], 0, 100, 60),
    specificity_gap: clampNum(parsed['specificity_gap'], 0, 100, 40),
    product_type,
    ai_fit_raw: clampNum(parsed['ai_fit_raw'], 0, 100, 50),
    ai_art_generation_heavy: parsed['ai_art_generation_heavy'] === true,
    dominant_product_summary:
      typeof parsed['dominant_product_summary'] === 'string'
        ? parsed['dominant_product_summary'].slice(0, 200)
        : keyword
  };
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ===========================================================================
// Step 4 — Sonnet: one-line rationale + named wedge (survivors only).
// ===========================================================================
const SONNET_SYSTEM = `You name the specific WEDGE for a niche our AI-pipeline Etsy shop should attack, plus a one-line rationale. We are a brand-new shop with zero reviews; our edge is fast, high-quality AI-generated structured digital products (templates, planners, trackers, docs).

Given the niche and its scores/signals, return JSON only:
{"wedge":"<the attackable gap + the specific product angle we'd take — concrete, e.g. 'incumbents are generic weekly planners; ship an ADHD-specific time-blocking planner with dopamine-reward tracking'>","rationale":"<one sentence: why this niche is beatable for us right now>"}
Keep wedge under 30 words and rationale under 30 words. No markdown.`;

async function writeWedge(
  keyword: string,
  result: OpportunityScoreResult,
  summary: string
): Promise<{ wedge: string; rationale: string }> {
  const userMessage = `Niche keyword: ${keyword}
Dominant incumbents: ${summary}
opportunity_score: ${result.opportunity_score}
attackability: ${result.attackability} (median_reviews=${result.signals.median_reviews}, soft_share=${result.signals.soft_share}, youth=${result.signals.youth_share}, seo_gap=${result.sub_scores.seo_gap}, specificity_gap=${result.sub_scores.specificity_gap})
demand: ${result.demand} (modeled demand_pool=${result.signals.demand_pool}/mo)
ai_fit: ${result.ai_fit} (product_type=${result.signals.product_type})`;

  const message = await getClient().messages.create({
    model: SONNET_MODEL,
    max_tokens: 200,
    system: SONNET_SYSTEM,
    messages: [{ role: 'user', content: userMessage }]
  });

  cost.sonnet_calls++;
  cost.sonnet_in += message.usage?.input_tokens ?? 0;
  cost.sonnet_out += message.usage?.output_tokens ?? 0;

  const rawText =
    message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = JSON.parse(stripJsonFence(rawText)) as {
    wedge?: string;
    rationale?: string;
  };
  return {
    wedge: typeof parsed.wedge === 'string' ? parsed.wedge.trim() : '',
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : ''
  };
}

// ===========================================================================
// Per-keyword scan result (for report + summary).
// ===========================================================================
interface ScanResult {
  keyword: string;
  result: OpportunityScoreResult;
  wedge: string;
  rationale: string;
  summary: string;
  review_coverage: number;
  analyzed_known: number;
}

// Below this many KNOWN review counts the median/demand math is too thin to
// trust, so we skip scoring (a data-quality skip, not a niche verdict).
const MIN_KNOWN_FOR_SCORE = 5;

async function scanKeyword(keyword: string, runDate: string): Promise<ScanResult | null> {
  const { listings, review_coverage } = await gatherListings(keyword);
  if (listings.length === 0) {
    await log({
      agent: 'intel',
      action: 'opportunity_scan.keyword_skipped',
      description: `No Etsy listings returned for "${keyword}" — skipping`,
      severity: 'warning',
      metadata: { keyword }
    });
    return null;
  }

  const top = [...listings].sort((a, b) => a.rank - b.rank);
  const analyzed = toAnalyzed(listings);
  if (analyzed.length < MIN_KNOWN_FOR_SCORE) {
    await log({
      agent: 'intel',
      action: 'opportunity_scan.low_coverage_skip',
      description: `Only ${analyzed.length} known review counts for "${keyword}" (rate-limited) — skipping to avoid garbage scores`,
      severity: 'warning',
      metadata: { keyword, analyzed_known: analyzed.length, total: listings.length }
    });
    return null;
  }

  const llm = await assessIncumbents(keyword, top);
  const result = scoreOpportunity(analyzed, llm);

  let wedge = '';
  let rationale = '';
  if (result.status === 'scored') {
    try {
      const w = await writeWedge(keyword, result, llm.dominant_product_summary);
      wedge = w.wedge;
      rationale = w.rationale;
    } catch (err) {
      // Rationale is non-critical: keep the score, leave wedge blank.
      const msg = err instanceof Error ? err.message : String(err);
      await log({
        agent: 'intel',
        action: 'opportunity_scan.wedge_failed',
        description: `Sonnet wedge failed for "${keyword}" (kept score)`,
        severity: 'warning',
        metadata: { keyword, error: msg }
      });
    }
  }

  // --- Persist ---
  const reason = result.reasons.length > 0 ? result.reasons.join('; ') : null;
  const { error } = await supabase
    .from('opportunity_scores')
    .upsert(
      {
        run_date: runDate,
        keyword,
        opportunity_score: result.opportunity_score,
        attackability: result.attackability,
        demand: result.demand,
        ai_fit: result.ai_fit,
        demand_pool: result.signals.demand_pool,
        median_reviews: result.signals.median_reviews,
        status: result.status,
        reason,
        wedge: wedge || null,
        rationale: rationale || null,
        sub_scores: result.sub_scores,
        raw_signals: {
          ...result.signals,
          compliance_risk: result.compliance_risk,
          review_coverage: Math.round(review_coverage * 100) / 100,
          analyzed_known: analyzed.length,
          analyzed_total: listings.length,
          estimate_flags: {
            sales_modeled: true,
            review_to_sales_multiplier_used: true,
            any_age_missing: result.signals.any_age_missing,
            unknown_review_listings_excluded: listings.length - analyzed.length
          },
          listings: analyzed.map(l => ({
            listing_id: l.listing_id,
            shop_id: l.shop_id,
            rank: l.rank,
            review_count: l.review_count,
            age_months: l.age_months,
            est_monthly_sales: Math.round(l.est_monthly_sales),
            est_lifetime_sales: Math.round(l.est_lifetime_sales),
            price: l.price
          }))
        },
        model_meta: {
          scorer_version: OPPORTUNITY_SCORER_VERSION,
          haiku_model: HAIKU_MODEL,
          sonnet_model: result.status === 'scored' ? SONNET_MODEL : null,
          dominant_product_summary: llm.dominant_product_summary,
          seo_quality_raw: llm.seo_quality
        }
      },
      { onConflict: 'run_date,keyword' }
    );

  if (error) {
    await log({
      agent: 'intel',
      action: 'opportunity_scan.persist_failed',
      description: `Failed to persist opportunity score for "${keyword}"`,
      severity: 'warning',
      metadata: { keyword, error: error.message }
    });
  }

  return {
    keyword,
    result,
    wedge,
    rationale,
    summary: llm.dominant_product_summary,
    review_coverage,
    analyzed_known: analyzed.length
  };
}

// ===========================================================================
// Step 5 — markdown report.
// ===========================================================================
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function buildReport(runDate: string, results: ScanResult[]): string {
  const scored = results
    .filter(r => r.result.status === 'scored')
    .sort((a, b) => b.result.opportunity_score - a.result.opportunity_score);
  const excluded = results.filter(r => r.result.status === 'excluded');

  const lines: string[] = [];
  lines.push(`# Opportunity scan — ${runDate}`);
  lines.push('');
  lines.push(
    `Scanner ${OPPORTUNITY_SCORER_VERSION}. Ranks Etsy niches by where a zero-review, ` +
      `AI-pipeline shop can win. **Sales figures are MODELED** ` +
      `(review_count × ${REVIEW_TO_SALES_MULTIPLIER}), not actual Etsy data.`
  );
  lines.push('');
  lines.push(
    `Keywords scanned: ${results.length} · surviving: ${scored.length} · excluded: ${excluded.length}`
  );
  lines.push('');

  lines.push('## Surviving candidates (sorted by opportunity_score)');
  lines.push('');
  if (scored.length === 0) {
    lines.push('_None survived the hard gates._');
  } else {
    lines.push(
      '| Keyword | Opp | Attack | Demand | AI-fit | Demand pool/mo | Median reviews | Coverage | Wedge |'
    );
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const r of scored) {
      const s = r.result;
      const cov = `${Math.round(r.review_coverage * 100)}% (${r.analyzed_known})`;
      lines.push(
        `| ${r.keyword} | **${fmt(s.opportunity_score)}** | ${fmt(s.attackability)} | ${fmt(s.demand)} | ${fmt(s.ai_fit)} | ${fmt(s.signals.demand_pool)} | ${fmt(s.signals.median_reviews)} | ${cov} | ${r.wedge || '—'} |`
      );
    }
  }
  lines.push('');

  // Rationales (kept out of the table so they stay readable).
  if (scored.length > 0) {
    lines.push('### Rationales');
    lines.push('');
    for (const r of scored) {
      lines.push(`- **${r.keyword}** (${fmt(r.result.opportunity_score)}): ${r.rationale || '—'}`);
    }
    lines.push('');
  }

  lines.push('## Excluded');
  lines.push('');
  if (excluded.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Keyword | Attack | Demand | AI-fit | Reason |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const r of excluded) {
      const s = r.result;
      lines.push(
        `| ${r.keyword} | ${fmt(s.attackability)} | ${fmt(s.demand)} | ${fmt(s.ai_fit)} | ${s.reasons.join('; ')} |`
      );
    }
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push(
    `- Sales are MODELED: est_lifetime_sales = review_count × ${REVIEW_TO_SALES_MULTIPLIER}; ` +
      `est_monthly_sales = lifetime / max(age_months, 1). Demand pool = Σ est_monthly_sales across analyzed listings.`
  );
  lines.push(
    '- Data spine: Etsy API = listing facts + ranking + per-listing review counts; our model = sales estimate; ' +
      'Haiku = SEO/specificity/product-type classification; Sonnet = wedge + rationale (survivors only).'
  );
  lines.push(
    '- **KEY LIMITATION (ranking):** the Etsy public API cannot reproduce on-site organic order and does not ' +
      'surface a niche\'s true high-review incumbents. sort_on=score was tested and was strictly worse (collapsed ' +
      'demand pools toward 0). We use the default sort and treat median_reviews / demand_pool as a BIASED PROXY, ' +
      'not a true read of the leaders. Fixing the demand signal (likely a paid keyword/volume tool) is the top priority.'
  );
  lines.push(
    '- **Coverage** = share of analyzed listings whose review_count was successfully fetched. Etsy rate-limits ' +
      'the reviews endpoint hard; listings whose count we could not fetch are marked UNKNOWN and excluded from ' +
      'the median/demand math (never counted as 0). Low coverage = treat scores as provisional.'
  );
  lines.push(
    '- Shop-level enrichment (shop total sales / shop age) is DEFERRED: the existing Etsy client does not surface ' +
      'those fields and the MVP avoids new fetchers. Not used by any pillar yet.'
  );
  lines.push(
    '- Almost every threshold/weight is first-pass (see opportunity-scoring.ts) and needs tuning against these results.'
  );
  return lines.join('\n');
}

// ===========================================================================
// Main
// ===========================================================================
async function main(): Promise<void> {
  const startedAt = Date.now();
  const runDate = new Date().toISOString().slice(0, 10);

  const keywords = await resolveKeywords();
  if (keywords.length === 0) {
    console.log('[summary] no keywords (empty seed file and no --keywords=)');
    return;
  }

  await log({
    agent: 'intel',
    action: 'opportunity_scan.start',
    description: `Opportunity scan starting: ${keywords.length} keywords`,
    metadata: { keywords, run_date: runDate }
  });

  console.log(`Opportunity scan ${OPPORTUNITY_SCORER_VERSION} — ${keywords.length} keywords (run ${runDate})\n`);

  const results: ScanResult[] = [];
  for (const keyword of keywords) {
    try {
      const r = await scanKeyword(keyword, runDate);
      if (!r) continue;
      results.push(r);
      const s = r.result;
      const cov = `cov=${Math.round(r.review_coverage * 100)}%(${r.analyzed_known})`;
      if (s.status === 'scored') {
        console.log(
          `  ok   "${keyword}": opp=${fmt(s.opportunity_score)} ` +
            `attack=${fmt(s.attackability)} demand=${fmt(s.demand)} ai_fit=${fmt(s.ai_fit)} ` +
            `(med_reviews=${fmt(s.signals.median_reviews)} pool=${fmt(s.signals.demand_pool)}/mo ${cov})`
        );
      } else {
        console.log(
          `  excl "${keyword}": ${s.reasons.join('; ')} ` +
            `(attack=${fmt(s.attackability)} demand=${fmt(s.demand)} ai_fit=${fmt(s.ai_fit)} ${cov})`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL "${keyword}": ${msg}`);
      await log({
        agent: 'intel',
        action: 'opportunity_scan.keyword_failed',
        description: `Opportunity scan failed for "${keyword}" — skipped`,
        severity: 'warning',
        metadata: { keyword, error: msg }
      });
    }
  }

  // --- Report ---
  const reportDir = path.resolve(process.cwd(), 'opportunities');
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${runDate}.md`);
  const report = buildReport(runDate, results);
  await writeFile(reportPath, report, 'utf-8');

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const runCost = totalCostUsd();

  console.log(`\n--- Report written to ${reportPath} ---`);
  console.log(
    `[cost] haiku: ${cost.haiku_calls} calls (${cost.haiku_in} in / ${cost.haiku_out} out tok) · ` +
      `sonnet: ${cost.sonnet_calls} calls (${cost.sonnet_in} in / ${cost.sonnet_out} out tok)`
  );
  console.log(`[cost] total LLM ≈ $${runCost.toFixed(4)} (Etsy API calls are free)`);
  console.log(
    `[summary] scanned=${results.length} ` +
      `scored=${results.filter(r => r.result.status === 'scored').length} ` +
      `excluded=${results.filter(r => r.result.status === 'excluded').length} ` +
      `duration=${durationSec}s`
  );

  await log({
    agent: 'intel',
    action: 'opportunity_scan.complete',
    description: `Opportunity scan done: ${results.length} keywords in ${durationSec}s`,
    severity: 'success',
    metadata: {
      run_date: runDate,
      scanned: results.length,
      scored: results.filter(r => r.result.status === 'scored').length,
      excluded: results.filter(r => r.result.status === 'excluded').length,
      duration_sec: durationSec,
      llm_cost_usd: Number(runCost.toFixed(4)),
      report_path: reportPath
    }
  });
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
