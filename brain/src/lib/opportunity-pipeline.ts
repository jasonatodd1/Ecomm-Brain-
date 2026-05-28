// Shared plumbing for the two-phase opportunity scanner.
//
// Phase A (shortlist-opportunities.ts) and Phase C (score-opportunities-from-
// erank.ts) both reuse: the Anthropic client + cost tracker, the Haiku
// incumbent classifier, the Sonnet wedge writer, a light Etsy gather (titles +
// tags only — NO review counts; those are now eRank-sourced), the eRank CSV
// worksheet read/write, and the Phase A -> Phase C sidecar handoff.
//
// NO new HTTP fetchers / auth: reuses etsy-search.ts + @anthropic-ai/sdk.

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from './log.js';
import { searchEtsy, getListing } from './etsy-search.js';
import { mapWithLimit } from './concurrency.js';
import type { IncumbentLlmAssessment, ProductType } from './opportunity-scoring.js';

// ===========================================================================
// Models + run config
// ===========================================================================
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-6';

// Approximate list prices (USD per 1M tokens) for RUN-COST REPORTING ONLY.
// FIRST-PASS, verify against current Anthropic pricing.
const HAIKU_PRICE_IN = 1.0;
const HAIKU_PRICE_OUT = 5.0;
const SONNET_PRICE_IN = 3.0;
const SONNET_PRICE_OUT = 15.0;

const SEARCH_FETCH = 24; // top organic listings to pull per keyword (for the wedge)
const TOP_POSITIONS = 10; // top-N titles/tags fed to Haiku
const ENRICH_CONCURRENCY = 1; // Etsy rate-limits; 1-in-flight + stagger is safe
const ENRICH_STAGGER_MS = 250;
const RETRY_BACKOFF_MS = 1000;
const LISTING_RETRIES = 3;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ===========================================================================
// Anthropic client (lazy) + cost tracker
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

export const cost = {
  haiku_in: 0,
  haiku_out: 0,
  sonnet_in: 0,
  sonnet_out: 0,
  haiku_calls: 0,
  sonnet_calls: 0
};

export function totalCostUsd(): number {
  return (
    (cost.haiku_in * HAIKU_PRICE_IN) / 1_000_000 +
    (cost.haiku_out * HAIKU_PRICE_OUT) / 1_000_000 +
    (cost.sonnet_in * SONNET_PRICE_IN) / 1_000_000 +
    (cost.sonnet_out * SONNET_PRICE_OUT) / 1_000_000
  );
}

export function costLine(): string {
  return (
    `[cost] haiku: ${cost.haiku_calls} calls (${cost.haiku_in} in / ${cost.haiku_out} out tok) · ` +
    `sonnet: ${cost.sonnet_calls} calls (${cost.sonnet_in} in / ${cost.sonnet_out} out tok) · ` +
    `total LLM ≈ $${totalCostUsd().toFixed(4)} (Etsy API calls are free)`
  );
}

function stripJsonFence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ===========================================================================
// Light Etsy gather — titles + tags only (for the Haiku classifier + wedge).
// Review counts are NOT fetched here: they are now sourced from eRank. This
// also sidesteps the worst of Etsy's reviews-endpoint rate limiting. Any
// number derived from this gather is PRELIMINARY/UNTRUSTED and must not feed
// the final demand or attackability score.
// ===========================================================================
export interface PreliminaryListing {
  listing_id: number;
  shop_id: number;
  rank: number;
  title: string;
  tags: string[];
  num_favorers: number | null;
}

async function fetchListingTags(listingId: number): Promise<string[]> {
  for (let attempt = 0; attempt < LISTING_RETRIES; attempt++) {
    const details = await getListing(listingId);
    if (details) return details.tags;
    await sleep(RETRY_BACKOFF_MS * (attempt + 1));
  }
  return [];
}

export async function gatherPreliminary(keyword: string): Promise<PreliminaryListing[]> {
  const search = await searchEtsy(keyword, { limit: SEARCH_FETCH });
  if (search.length === 0) return [];

  // Dedupe lightly (one shop shouldn't fill the sample) and keep the top N
  // titles for the classifier; only fetch tags for those N.
  const perShop = new Map<number, number>();
  const top: typeof search = [];
  for (const r of search) {
    const c = perShop.get(r.shop_id) ?? 0;
    if (r.shop_id > 0 && c >= 3) continue;
    perShop.set(r.shop_id, c + 1);
    top.push(r);
    if (top.length >= TOP_POSITIONS) break;
  }

  const withTags = await mapWithLimit(
    top,
    ENRICH_CONCURRENCY,
    ENRICH_STAGGER_MS,
    async (r, idx): Promise<PreliminaryListing> => ({
      listing_id: r.listing_id,
      shop_id: r.shop_id,
      rank: idx,
      title: r.title,
      tags: await fetchListingTags(r.listing_id),
      num_favorers: r.num_favorers
    })
  );

  return withTags;
}

// ===========================================================================
// Haiku — one structured call per keyword: classification + SEO + specificity.
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

export async function assessIncumbents(
  keyword: string,
  top: PreliminaryListing[]
): Promise<IncumbentLlmAssessment> {
  const sample = top
    .slice(0, TOP_POSITIONS)
    .map((l, i) => {
      const tags = l.tags.length > 0 ? l.tags.join(', ') : '(no tags returned)';
      return `${i + 1}. TITLE: ${l.title}\n   TAGS: ${tags}`;
    })
    .join('\n');

  const userMessage = `Keyword: ${keyword}\n\nTop listings:\n${
    sample || '(no listings returned by the API)'
  }`;

  const message = await getClient().messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    system: HAIKU_SYSTEM,
    messages: [{ role: 'user', content: userMessage }]
  });

  cost.haiku_calls++;
  cost.haiku_in += message.usage?.input_tokens ?? 0;
  cost.haiku_out += message.usage?.output_tokens ?? 0;

  const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';
  const parsed = JSON.parse(stripJsonFence(rawText)) as Record<string, unknown>;
  const product_type = isProductType(parsed['product_type']) ? parsed['product_type'] : 'mixed';

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

// ===========================================================================
// Sonnet — one-line rationale + named wedge (Phase A, from the Haiku read).
// ===========================================================================
const SONNET_SYSTEM = `You name the specific WEDGE for a niche our AI-pipeline Etsy shop should attack, plus a one-line rationale. We are a brand-new shop with zero reviews; our edge is fast, high-quality AI-generated structured digital products (templates, planners, trackers, docs).

Given the niche and what the incumbents look like, return JSON only:
{"wedge":"<the attackable gap + the specific product angle we'd take — concrete, e.g. 'incumbents are generic weekly planners; ship an ADHD-specific time-blocking planner with dopamine-reward tracking'>","rationale":"<one sentence: why this niche is beatable for us right now>"}
Keep wedge under 30 words and rationale under 30 words. No markdown.`;

export async function writeWedge(
  keyword: string,
  llm: IncumbentLlmAssessment,
  preliminaryNote: string
): Promise<{ wedge: string; rationale: string }> {
  const userMessage = `Niche keyword: ${keyword}
Dominant incumbents: ${llm.dominant_product_summary}
product_type: ${llm.product_type}
incumbent SEO quality (0-100, higher=stronger): ${llm.seo_quality}
specificity gap (0-100, higher=more underserved sub-niche): ${llm.specificity_gap}
${preliminaryNote ? `Preliminary/UNTRUSTED API note: ${preliminaryNote}` : ''}`;

  const message = await getClient().messages.create({
    model: SONNET_MODEL,
    max_tokens: 200,
    system: SONNET_SYSTEM,
    messages: [{ role: 'user', content: userMessage }]
  });

  cost.sonnet_calls++;
  cost.sonnet_in += message.usage?.input_tokens ?? 0;
  cost.sonnet_out += message.usage?.output_tokens ?? 0;

  const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';
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
// eRank worksheet CSV (RFC-4180-ish: quoted fields, escaped quotes).
// ===========================================================================
export const ERANK_CSV_HEADER = [
  'keyword',
  'wedge',
  'etsy_avg_searches',
  'etsy_competition',
  'top10_review_counts',
  'notes'
] as const;

function csvEscape(field: string): string {
  if (/[",\n\r]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function toCsvRow(fields: string[]): string {
  return fields.map(csvEscape).join(',');
}

/** Parse CSV text into rows of string fields (handles quoted commas/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

/** Parse a review-count cell: tolerant of comma/semicolon/space/pipe separators. */
export function parseReviewCounts(cell: string): number[] | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  const nums = trimmed
    .split(/[,;|\s]+/)
    .map(s => Number(s.replace(/[^0-9.]/g, '')))
    .filter(n => Number.isFinite(n));
  return nums.length > 0 ? nums : null;
}

/** Parse a single numeric cell (e.g. avg searches / competition); blank -> null. */
export function parseNumberCell(cell: string): number | null {
  const trimmed = (cell ?? '').trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ===========================================================================
// Phase A -> Phase C sidecar (machine state the human worksheet shouldn't hold).
// ===========================================================================
export interface ShortlistEntry {
  keyword: string;
  // Phase A AI-fit results (carried forward, not re-run in Phase C):
  ai_fit: number;
  compliance_risk: boolean;
  product_type: ProductType;
  seo_quality: number;
  seo_gap: number; // 100 - seo_quality
  specificity_gap: number;
  dominant_product_summary: string;
  ai_excluded: boolean;
  ai_exclude_reason: string | null;
  wedge: string;
  rationale: string;
  // Preliminary/UNTRUSTED API signals (for context only; never scored):
  preliminary_listings_seen: number;
}

export interface ShortlistSidecar {
  run_date: string;
  scorer_version: string;
  entries: ShortlistEntry[];
}

export function sidecarPathFor(csvPath: string): string {
  return csvPath.replace(/\.csv$/i, '.shortlist.json');
}

export async function writeSidecar(csvPath: string, sidecar: ShortlistSidecar): Promise<void> {
  const p = sidecarPathFor(csvPath);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(sidecar, null, 2), 'utf-8');
}

export async function readSidecar(csvPath: string): Promise<ShortlistSidecar> {
  const p = sidecarPathFor(csvPath);
  const raw = await readFile(p, 'utf-8');
  return JSON.parse(raw) as ShortlistSidecar;
}

/** Extract the YYYY-MM-DD run date from a pulls path like .../2026-05-28.csv. */
export function runDateFromPath(p: string): string {
  const base = path.basename(p);
  const m = base.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

export async function logSafe(
  action: string,
  description: string,
  severity: 'info' | 'success' | 'warning' | 'error',
  metadata: Record<string, unknown>
): Promise<void> {
  await log({ agent: 'intel', action, description, severity, metadata });
}
