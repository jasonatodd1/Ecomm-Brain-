// One-shot resynthesis: meal planner v4 → v5.
//
// PURPOSE: re-synthesize the differentiation_thesis as a multi-wedge structure
// (research-v3.2) using ONLY v4's already-collected data. No new Etsy calls,
// no new Haiku classification — Opus synthesis pass only.
//
// PRESERVES: product spec (product.design.required_elements + product.format)
// and the asset-design fields exactly as v4 shipped them. Only updates the
// fields tied to the differentiation thesis.

import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { sanitizeJsonbDeep } from '../lib/etsy-search.js';
import type {
  DifferentiationThesis,
  DifferentiationWedge,
  ProductBrief
} from '../agents/research/types.js';
import { renderBriefAsMarkdown } from '../agents/research/render-markdown.js';

const SOURCE_BRIEF_ID = '9b20cba6-776f-43f9-a21e-a4bdf30774f2'; // v4
const OPUS_MODEL = 'claude-opus-4-7';
const RESYNTH_COST_USD = 0.18; // smaller than full synthesis — partial update
const AGENT_VERSION = 'research-v3.2';

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

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

// ---------------------------------------------------------------------------
// Resynthesis prompt — partial update. Asks Opus for ONLY the fields tied to
// the differentiation thesis; the rest of the brief is patched programmatically.
// ---------------------------------------------------------------------------

function buildResynthesisPrompt(brief: ProductBrief): string {
  const v4 = brief.differentiation_thesis;
  if (!v4) throw new Error('Source brief has no differentiation_thesis');

  const offerings = v4.competitor_offerings
    .map(
      (o, i) =>
        `[${i + 1}] ${o.incumbent_id}${o.relevance_reason ? ` — ${o.relevance_reason}` : ''}\n` +
        `    sections: ${o.product_features.sections.join('; ') || '(none)'}\n` +
        `    bundle: ${o.product_features.bundle_composition}\n` +
        `    formats: ${o.product_features.formats.join(', ') || 'unknown'}\n` +
        `    distinguishing: ${o.product_features.distinguishing_features.join('; ') || '(none)'}`
    )
    .join('\n\n');

  const pains = v4.buyer_pain_signals
    .map(
      (s, i) =>
        `[${i + 1}] "${s.theme}" (${s.frequency_indicator})\n` +
        s.paraphrased_examples.map(e => `    - ${e}`).join('\n')
    )
    .join('\n\n');

  const v4Hook = brief.listing.description?.hook ?? '';
  const v4Why = brief.listing.description?.why_this_one ?? '';
  const v4Angle = brief.listing.differentiation_angle ?? '';
  const v4Spec = (brief.listing.image_spec ?? [])
    .map(
      (s, i) =>
        `${i + 1}. kind=${s.kind} | purpose=${s.purpose} | style_notes=${s.style_notes}`
    )
    .join('\n');
  const v4Required = brief.product.design.required_elements.join('\n  - ');

  return `You are re-synthesizing a differentiation thesis for an EXISTING product brief into a multi-wedge structure (research-v3.2). NO new data is being collected. NO asset-spec changes are permitted. This is a synthesis-discipline upgrade only.

== SOURCE BRIEF (v4 / research-v3.1) ==
Decision: meal planner printable (Google Trends seed anchor, weak_incumbents SEO classification)
Recommendation: ${brief.recommendation} (confidence ${brief.confidence})

== v4 RELEVANCE-FILTERED COMPETITOR OFFERINGS (same-niche, kept verbatim) ==
${offerings}

== v4 BUYER PAIN SIGNALS (paraphrased themes — copy verbatim into v5) ==
${pains}

== v4 EXISTING POSITIONING (the input you are refining) ==
positioning: ${v4.positioning}
one_line_claim: ${v4.one_line_claim}
our_differentiation: ${v4.our_differentiation}
listing.differentiation_angle: ${v4Angle}
listing.description.hook: ${v4Hook}
listing.description.why_this_one: ${v4Why}

== v4 IMAGE SPEC (slot list — LOCKED; you may only refine style_notes, never kind/purpose/dims) ==
${v4Spec}

== LOCKED ASSET SPEC — DO NOT CHANGE ==
The product design and what's-included list are LOCKED. The whole point of this exercise is to refine the THESIS, not the asset. Specifically:
- product.format.includes — unchanged from v4
- product.design.required_elements — unchanged from v4:
  - ${v4Required}

== TASK ==
Produce a multi-wedge differentiation thesis with HONEST per-wedge grounding tags, plus refined listing-copy fields that articulate both wedges where they cohere.

WEDGE STRUCTURE — 2 wedges, lead first:

(1) WORKFLOW WEDGE — "single-page meal grid + aisle-grouped grocery on one tear-off page, plan and shop without flipping". Grounded primarily in incumbent structural gaps:
- 1386590527 ships meal grid and grocery as separate sections
- 1292678192 splits them across spreadsheet tabs
- 1572689473 splits them across hyperlinked PDF pages
- No incumbent uses aisle-grouped grocery sections (Produce/Proteins/Dairy/Pantry/Freezer/Other)
This wedge's grounding tag should be "incumbent-inferred" — no buyer-voice pain theme directly demands single-page integration.

(2) CUSTOMIZATION WEDGE — "print-and-pen freedom from digital lock-in (no passwords, no locked cells, write what you want)". Grounded in buyer voice with caveats:
- STRONG support: "Password protection limits customization" (1 mention) — paper has no locks
- PARTIAL support: "Inflexible recipe entry system" (1 mention) — paper lets you write any combination, but the modular-component framing could also read as "want better digital UX"
- COUNTER-EVIDENCE that MUST be acknowledged: "Limited tracking/analytics" (1 mention) — paper has LESS tracking than digital. Buyers who want analytics are NOT our audience. List this in counter_evidence.
- NEUTRAL: "Basic/generic template design" — about aesthetic, not modality
Honest grounding tag: "partial-buyer-voice-backed" — 1 strong + 1 partial + 1 counter + 1 neutral. NOT "buyer-voice-backed".

LEAD WEDGE: workflow. Reasoning: (a) thumbnail-scannable, (b) buyers searching "meal planner printable" have already self-selected for paper (customization is validation, not persuasion).

ONE-LINE CLAIM: focus on the workflow wedge only. Forcing both into one sentence dilutes. Customization gets its own paragraph in why_this_one.

HOOK: workflow-focused. ~130-160 chars. Primary keyword "meal planner printable" inside.

WHY_THIS_ONE: 3-4 sentences. Lead with workflow + name the page-flipping foil (spreadsheet tabs / hyperlinked PDFs / separate sections). Then add a paragraph mentioning the customization wedge — name the spreadsheet-rigidity foil specifically (locked cells, passwords). Match v4's calm-confident tone.

DIFFERENTIATION_ANGLE: single sentence integrating both wedges where they cohere (a print-and-pen single-page tear-off — both wedges, but workflow-led).

IMAGE_SPEC: keep all 4 slots' kind/purpose/dims_recommended VERBATIM from v4. You may refine style_notes on the hero to add a subtle pen-on-paper cue (e.g., "with a pen resting on the page") IF it strengthens the customization-wedge visual without becoming a gimmick — but only on the hero. Other slots' style_notes stay verbatim. If pen-on-paper would be a gimmick, leave hero unchanged too — honesty over decoration.

OUR_DIFFERENTIATION: ≤3 sentences, unified summary. Free-form (v3.2+ does not require inline prefix tags; per-wedge grounding lives in wedges[]).

POSITIONING: drawn from the LEAD (workflow) wedge for thumbnail coherence. May reference paper-and-pen as secondary.

== OUTPUT FORMAT ==
Return ONLY raw JSON (no markdown fences, no preamble). The first character must be "{".

{
  "differentiation_thesis": {
    "wedges": [
      {
        "type": "workflow" | "customization" | "aesthetic" | "audience" | "pricing" | "other",
        "grounding": "buyer-voice-backed" | "partial-buyer-voice-backed" | "incumbent-inferred" | "speculative",
        "claim": "<single concrete sentence>",
        "supporting_evidence": ["<pain theme labels OR incumbent_id+gap>"],
        "counter_evidence": ["<REQUIRED for the customization wedge per the analytics theme>"]
      }
    ],
    "our_differentiation": "<unified summary; ≤3 sentences>",
    "positioning": "<workflow-led, may reference paper-and-pen secondary>",
    "one_line_claim": "<single sentence focused on workflow wedge>"
  },
  "listing": {
    "differentiation_angle": "<single sentence integrating both wedges>",
    "description": {
      "hook": "<130-160 chars, workflow-focused, primary keyword inside>",
      "why_this_one": "<3-4 sentences: workflow paragraph THEN customization paragraph naming both foils>"
    },
    "image_spec_style_notes_patch": {
      "hero_style_notes": "<refined v4 hero style_notes OR null to keep v4 verbatim>"
    }
  }
}

Do NOT echo any other brief fields. Do NOT regenerate the whole brief. Return only the patch.`;
}

// ---------------------------------------------------------------------------
// Patch validation + application
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

interface ResynthPatch {
  differentiation_thesis: {
    wedges: DifferentiationWedge[];
    our_differentiation: string;
    positioning: string;
    one_line_claim: string;
  };
  listing: {
    differentiation_angle: string;
    description: { hook: string; why_this_one: string };
    image_spec_style_notes_patch: { hero_style_notes: string | null };
  };
}

function parsePatch(raw: unknown): ResynthPatch {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Patch is not an object');
  }
  const r = raw as Record<string, unknown>;
  const dt = r['differentiation_thesis'] as Record<string, unknown> | undefined;
  if (!dt) throw new Error('Patch missing differentiation_thesis');
  const wedgesRaw = dt['wedges'];
  if (!Array.isArray(wedgesRaw) || wedgesRaw.length < 1 || wedgesRaw.length > 3) {
    throw new Error('Patch wedges must be 1-3 entries');
  }
  const wedges: DifferentiationWedge[] = wedgesRaw.map((w: unknown, i: number) => {
    if (!w || typeof w !== 'object') throw new Error(`Wedge ${i} not an object`);
    const wo = w as Record<string, unknown>;
    const type = asString(wo['type']);
    const grounding = asString(wo['grounding']);
    const claim = asString(wo['claim']);
    if (!type || !grounding || !claim) {
      throw new Error(`Wedge ${i} missing required fields`);
    }
    const allowedTypes = [
      'workflow',
      'customization',
      'aesthetic',
      'audience',
      'pricing',
      'other'
    ];
    const allowedGroundings = [
      'buyer-voice-backed',
      'partial-buyer-voice-backed',
      'incumbent-inferred',
      'speculative'
    ];
    if (!allowedTypes.includes(type)) throw new Error(`Wedge ${i} invalid type: ${type}`);
    if (!allowedGroundings.includes(grounding))
      throw new Error(`Wedge ${i} invalid grounding: ${grounding}`);
    const counter = asStringArray(wo['counter_evidence']);
    return {
      type: type as DifferentiationWedge['type'],
      grounding: grounding as DifferentiationWedge['grounding'],
      claim,
      supporting_evidence: asStringArray(wo['supporting_evidence']),
      ...(counter.length > 0 ? { counter_evidence: counter } : {})
    };
  });

  const listing = r['listing'] as Record<string, unknown> | undefined;
  if (!listing) throw new Error('Patch missing listing');
  const desc = listing['description'] as Record<string, unknown> | undefined;
  if (!desc) throw new Error('Patch missing listing.description');
  const styleNotesPatch = listing['image_spec_style_notes_patch'] as
    | Record<string, unknown>
    | undefined;

  return {
    differentiation_thesis: {
      wedges,
      our_differentiation: asString(dt['our_differentiation']) ?? '',
      positioning: asString(dt['positioning']) ?? '',
      one_line_claim: asString(dt['one_line_claim']) ?? ''
    },
    listing: {
      differentiation_angle: asString(listing['differentiation_angle']) ?? '',
      description: {
        hook: asString(desc['hook']) ?? '',
        why_this_one: asString(desc['why_this_one']) ?? ''
      },
      image_spec_style_notes_patch: {
        hero_style_notes: styleNotesPatch
          ? asString(styleNotesPatch['hero_style_notes'])
          : null
      }
    }
  };
}

function applyPatch(v4: ProductBrief, patch: ResynthPatch): ProductBrief {
  const v5: ProductBrief = JSON.parse(JSON.stringify(v4));

  // Thesis — keep competitor_offerings + buyer_pain_signals + relevance_filter verbatim
  const v5Thesis: DifferentiationThesis = {
    competitor_offerings: v4.differentiation_thesis!.competitor_offerings,
    buyer_pain_signals: v4.differentiation_thesis!.buyer_pain_signals,
    relevance_filter: v4.differentiation_thesis!.relevance_filter,
    wedges: patch.differentiation_thesis.wedges,
    our_differentiation: patch.differentiation_thesis.our_differentiation,
    positioning: patch.differentiation_thesis.positioning,
    one_line_claim: patch.differentiation_thesis.one_line_claim
  };
  v5.differentiation_thesis = v5Thesis;

  // Listing copy patches
  v5.listing.differentiation_angle = patch.listing.differentiation_angle;
  if (v5.listing.description) {
    v5.listing.description.hook = patch.listing.description.hook;
    v5.listing.description.why_this_one = patch.listing.description.why_this_one;
  }

  // Hero image_spec style_notes (subtle pen-on-paper refinement allowed)
  if (
    v5.listing.image_spec &&
    v5.listing.image_spec.length > 0 &&
    patch.listing.image_spec_style_notes_patch.hero_style_notes
  ) {
    const heroIdx = v5.listing.image_spec.findIndex(s => s.kind === 'hero');
    if (heroIdx >= 0) {
      v5.listing.image_spec[heroIdx].style_notes =
        patch.listing.image_spec_style_notes_patch.hero_style_notes;
    }
  }

  return v5;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`> loading v4 brief ${SOURCE_BRIEF_ID}`);

  const { data: srcRow, error: loadErr } = await supabase
    .from('product_briefs')
    .select('id, decision_id, brief, raw_research, recommendation, confidence, agent_version')
    .eq('id', SOURCE_BRIEF_ID)
    .single();
  if (loadErr || !srcRow) {
    throw new Error(`Failed to load source brief: ${loadErr?.message ?? 'not found'}`);
  }

  const v4Brief = srcRow.brief as ProductBrief;
  if (!v4Brief.differentiation_thesis) {
    throw new Error('Source brief has no differentiation_thesis — cannot resynthesize');
  }

  console.log(`  v4 confidence: ${srcRow.confidence}`);
  console.log(`  v4 thesis grounding: single-tag inline (v3.1 style)`);

  const prompt = buildResynthesisPrompt(v4Brief);

  console.log(`> calling Opus for v5 thesis resynthesis (partial update)`);
  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: 'Opus v5 thesis resynthesis (partial update)',
    metadata: {
      provider: 'anthropic',
      model: OPUS_MODEL,
      step: 'resynthesis_v5',
      source_brief_id: SOURCE_BRIEF_ID,
      estimated_cost_usd: RESYNTH_COST_USD
    }
  });

  const text = stripJsonFences(getTextFromResponse(resp));
  const patch = parsePatch(JSON.parse(text));

  const v5Brief = applyPatch(v4Brief, patch);

  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  // Persist as new brief row, agent_version=research-v3.2
  console.log(`> persisting v5 brief`);
  const sanitizedBrief = sanitizeJsonbDeep(v5Brief) as Record<string, unknown>;
  const sanitizedRaw = sanitizeJsonbDeep({
    ...((srcRow.raw_research as Record<string, unknown>) ?? {}),
    resynthesis_v5: {
      source_brief_id: SOURCE_BRIEF_ID,
      resynth_cost_usd: RESYNTH_COST_USD,
      resynth_runtime_sec: Number(elapsedSec)
    }
  }) as Record<string, unknown>;

  const { data: v5Row, error: insErr } = await supabase
    .from('product_briefs')
    .insert({
      decision_id: srcRow.decision_id,
      brief: sanitizedBrief,
      raw_research: sanitizedRaw,
      recommendation: v5Brief.recommendation,
      confidence: v5Brief.confidence,
      cost_usd: RESYNTH_COST_USD,
      agent_version: AGENT_VERSION
    })
    .select('id')
    .single();

  if (insErr || !v5Row) {
    throw new Error(`Failed to insert v5 brief: ${insErr?.message ?? 'unknown'}`);
  }

  const v5BriefId = v5Row.id as string;

  // Render markdown (operator review)
  const decisionForRender = {
    id: srcRow.decision_id as string,
    title:
      'Meal planner printable — Google Trends seed anchor (bake-off #2, WS 0.644)',
    description: '',
    context: {},
    urgency: 'high',
    status: 'brief_ready'
  };
  const markdown = renderBriefAsMarkdown(v5Brief, decisionForRender, {
    briefId: v5BriefId,
    costUsd: RESYNTH_COST_USD,
    agentVersion: AGENT_VERSION
  });
  await supabase
    .from('product_briefs')
    .update({ markdown })
    .eq('id', v5BriefId);

  const briefsDir = path.resolve(process.cwd(), 'briefs');
  await mkdir(briefsDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${dateStr}-${(srcRow.decision_id as string).slice(0, 8)}-v5.md`;
  const filepath = path.join(briefsDir, filename);
  await writeFile(filepath, markdown, 'utf-8');

  await log({
    agent: 'intel',
    action: 'research.resynthesized',
    description: `v5 brief resynthesized from v4 ${SOURCE_BRIEF_ID.slice(0, 8)}`,
    severity: 'success',
    metadata: {
      source_brief_id: SOURCE_BRIEF_ID,
      v5_brief_id: v5BriefId,
      cost_usd: RESYNTH_COST_USD,
      runtime_sec: Number(elapsedSec),
      agent_version: AGENT_VERSION
    }
  });

  console.log('');
  console.log(`✓ v5 brief written (${elapsedSec}s)`);
  console.log(`  v5_brief_id:    ${v5BriefId}`);
  console.log(`  v4 source:      ${SOURCE_BRIEF_ID}`);
  console.log(`  cost:           $${RESYNTH_COST_USD.toFixed(4)}`);
  console.log(`  markdown:       ${filepath}`);
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('v5 resynthesis failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
