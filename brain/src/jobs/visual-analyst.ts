// Visual Competitive Analyst — standalone agent job.
//
//   npm run visual:analyze -- --decision-id=<uuid>
//
// Fetches competitor listing IMAGES (not just text) from the Etsy API, analyzes
// them with Claude Vision (Sonnet), and synthesizes visual competitive
// positioning into niche_memory + a markdown report. Runs INDEPENDENTLY of the
// research agent — it does NOT claim the decision, does NOT advance its status,
// and does NOT re-run the research pipeline. Output is niche_memory
// (key=visual_competitive_intel) + a markdown brief only.
//
// Model: claude-sonnet-4-6 for every vision + synthesis call (NOT Opus) — image
// analysis is high-volume "routine perception" work where Sonnet's price/quality
// is the right tradeoff; Opus is reserved for load-bearing strategy synthesis.
//
// niche_tag is set EXPLICITLY by slugifying the decision's keyword field — it does
// NOT use the research agent's context.subreddit resolver. This guarantees the
// output lands under the same tag operator-seeded intel uses.
//
// Constraints (hard): max 40 images total across the run; per-image-fetch
// failures log + skip (never crash, never counted as a zero); max 3 concurrent
// image downloads; Etsy API calls stay at the project's 2-in-flight/200ms posture.

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { searchEtsy, getShop, sanitizeJsonbDeep } from '../lib/etsy-search.js';
import { mapWithLimit } from '../lib/concurrency.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const VISION_MODEL = 'claude-sonnet-4-6';
// Approximate Sonnet 4.6 list pricing (USD per million tokens) — matches refine-graphic.ts.
const INPUT_USD_PER_M = 3.0;
const OUTPUT_USD_PER_M = 15.0;

const SEARCH_KEYWORDS = [
  'wedding day timeline template',
  'wedding vendor timeline',
  'wedding day schedule template'
];
const TOP_LISTINGS_POOL = 20; // dedupe target before image fetch
const TARGET_LISTINGS = 13; // aim for 10–15 listings with image data
const IMAGES_PER_LISTING = 3; // top N by rank per listing (3 keeps us under the cap with broad coverage)
const MAX_IMAGES_TOTAL = 40; // hard cap across the whole run
const IMAGE_DOWNLOAD_CONCURRENCY = 3; // hard cap on concurrent CDN downloads
const ETSY_API_CONCURRENCY = 2; // listing/shop API posture (≈5 req/s with stagger)
const ETSY_API_STAGGER_MS = 350; // a touch wider than the project default to absorb the 2-call-per-listing fan-out
const VISION_CONCURRENCY = 2; // gentle parallelism on the Anthropic side

const ETSY_KEY = `${process.env.ETSY_API_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`;
const ETSY_IMG_HEADERS = { 'x-api-key': ETSY_KEY, Accept: 'application/json' };

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY environment variable');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_M
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function getText(resp: Anthropic.Message): string {
  const block = resp.content[0];
  if (block && block.type === 'text') return block.text;
  throw new Error('Anthropic response did not contain a text block');
}

function parseArg(name: string): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (a?.startsWith(`--${name}=`)) return a.slice(`--${name}=`.length);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Etsy image + video helpers (fail soft, never throw)
// ---------------------------------------------------------------------------
interface EtsyImageMeta {
  rank: number;
  url: string;
  width: number | null;
  height: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Single-endpoint GET with bounded retry on 429 (Etsy's 10 req/s ceiling is
// easy to brush against when fanning out per-listing). Honors Retry-After.
async function etsyGetWithRetry(url: string, maxRetries = 2): Promise<Response | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: ETSY_IMG_HEADERS });
    if (res.status !== 429) return res;
    if (attempt === maxRetries) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * (attempt + 1);
    await sleep(backoff);
  }
  return null;
}

async function fetchListingImageMeta(listingId: number): Promise<EtsyImageMeta[]> {
  try {
    const res = await etsyGetWithRetry(
      `https://openapi.etsy.com/v3/application/listings/${listingId}/images`
    );
    if (!res || !res.ok) {
      await log({
        agent: 'intel',
        action: 'visual_analyst.images_fetch_failed',
        description: `Etsy images HTTP ${res?.status ?? 'no-response'} for listing ${listingId}`,
        severity: 'warning',
        metadata: { listing_id: listingId, status_code: res?.status ?? null }
      });
      return [];
    }
    const data = (await res.json()) as {
      results?: Array<{
        rank?: number;
        url_fullxfull?: string;
        full_width?: number;
        full_height?: number;
      }>;
    };
    const results = data.results ?? [];
    return results
      .filter(r => typeof r.url_fullxfull === 'string' && r.url_fullxfull.length > 0)
      .map(r => ({
        rank: typeof r.rank === 'number' ? r.rank : 999,
        url: r.url_fullxfull as string,
        width: typeof r.full_width === 'number' ? r.full_width : null,
        height: typeof r.full_height === 'number' ? r.full_height : null
      }))
      .sort((a, b) => a.rank - b.rank);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'visual_analyst.images_fetch_failed',
      description: `Network error fetching images for listing ${listingId}`,
      severity: 'warning',
      metadata: { listing_id: listingId, error: msg }
    });
    return [];
  }
}

// has_video is taken STRICTLY from the API, never inferred from images.
async function fetchHasVideo(listingId: number): Promise<boolean> {
  try {
    const res = await etsyGetWithRetry(
      `https://openapi.etsy.com/v3/application/listings/${listingId}/videos`
    );
    // Etsy returns 200 with empty results when there's no video; some tiers 404.
    if (!res || !res.ok) return false;
    const data = (await res.json()) as {
      count?: number;
      results?: unknown[];
    };
    if (typeof data.count === 'number') return data.count > 0;
    return Array.isArray(data.results) && data.results.length > 0;
  } catch {
    return false;
  }
}

const MEDIA_TYPE_BY_EXT: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function mediaTypeFor(url: string, contentType: string | null): Anthropic.Base64ImageSource['media_type'] {
  if (contentType && /^image\/(jpeg|png|webp|gif)$/.test(contentType)) {
    return contentType as Anthropic.Base64ImageSource['media_type'];
  }
  const lower = url.toLowerCase();
  for (const [ext, mt] of Object.entries(MEDIA_TYPE_BY_EXT)) {
    if (lower.includes(ext)) return mt;
  }
  return 'image/jpeg';
}

interface DownloadedImage {
  base64: string;
  media_type: Anthropic.Base64ImageSource['media_type'];
}

async function downloadImage(url: string): Promise<DownloadedImage | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      await log({
        agent: 'intel',
        action: 'visual_analyst.download_failed',
        description: `Image download HTTP ${res.status}`,
        severity: 'warning',
        metadata: { url: url.slice(0, 200), status_code: res.status }
      });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return {
      base64: buf.toString('base64'),
      media_type: mediaTypeFor(url, res.headers.get('content-type'))
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'visual_analyst.download_failed',
      description: `Network error downloading image`,
      severity: 'warning',
      metadata: { url: url.slice(0, 200), error: msg }
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Candidate {
  listing_id: number;
  shop_id: number;
  title: string;
}

interface ListingImagery {
  listing_id: number;
  shop_id: number;
  title: string;
  shop_name: string | null;
  total_photo_count: number; // from the API (full image set size)
  has_video: boolean; // from the API
  imageUrls: string[]; // top-N selected for analysis
  images: DownloadedImage[]; // successfully downloaded subset
}

interface PerListingAnalysis {
  listing_id: number;
  title: string;
  shop_name: string | null;
  mockup_style: string | null;
  aesthetic: string | null;
  color_palette: string[] | null;
  pages_shown: string[] | null;
  featured_prominently: string | null;
  photo_count: number | null;
  has_video: boolean;
}

// ---------------------------------------------------------------------------
// Vision: per-listing analysis
// ---------------------------------------------------------------------------
const PER_LISTING_SYSTEM =
  'You are a visual merchandising analyst for Etsy digital-product listings. ' +
  'You receive the listing photos for ONE listing and output a single JSON object describing how the seller visually presents the product. ' +
  'Respond with JSON ONLY — no preamble, no markdown fences, no commentary.';

function buildPerListingPrompt(listing: ListingImagery): string {
  return [
    `Listing title: "${listing.title}"`,
    `Images attached: ${listing.images.length} (of ${listing.total_photo_count} total in the listing set).`,
    '',
    'Analyze the attached images and output exactly this JSON shape:',
    '{',
    '  "mockup_style": "phone frame | flat lay | lifestyle | screenshot | hand-held | combination | <short phrase>",',
    '  "aesthetic": "minimal | boho | rustic | modern script | colorful | <short phrase>",',
    '  "color_palette": ["color1", "color2", "color3"],',
    '  "pages_shown": ["main timeline", "vendor tabs", "checklist", "contact sheet", "..."],',
    '  "featured_prominently": "<what the seller chose to lead with in the first/hero image>",',
    '  "pages_shown_notes": "<optional one-line clarification>"',
    '}',
    '',
    'Rules: use null for any field you cannot determine from the images. ' +
      'color_palette = 2–3 dominant colors. pages_shown = which template sections are visibly shown. ' +
      'Do NOT guess at sections that are not visible. JSON only.'
  ].join('\n');
}

interface VisionCallResult<T> {
  parsed: T | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  parseError?: string;
}

async function analyzeListing(
  listing: ListingImagery
): Promise<VisionCallResult<Record<string, unknown>>> {
  const anthropic = getAnthropic();
  const content: Anthropic.ContentBlockParam[] = listing.images.map(img => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: img.media_type,
      data: img.base64
    }
  }));
  content.push({ type: 'text', text: buildPerListingPrompt(listing) });

  const resp = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1024,
    system: PER_LISTING_SYSTEM,
    messages: [{ role: 'user', content }]
  });

  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const costUsd = estimateCostUsd(inputTokens, outputTokens);

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | undefined;
  try {
    parsed = JSON.parse(stripJsonFences(getText(resp))) as Record<string, unknown>;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: `Sonnet vision analysis listing ${listing.listing_id}`,
    metadata: {
      provider: 'anthropic',
      model: VISION_MODEL,
      step: 'per_listing_vision',
      listing_id: listing.listing_id,
      images_sent: listing.images.length,
      estimated_cost_usd: costUsd
    }
  });

  return { parsed, costUsd, inputTokens, outputTokens, parseError };
}

function coerceStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return arr.length > 0 ? arr : null;
}

function coerceString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Vision: cross-listing synthesis
// ---------------------------------------------------------------------------
const SYNTHESIS_SYSTEM =
  'You are a visual competitive strategist for an Etsy digital-product shop. ' +
  'You receive per-listing visual analyses for a single niche and synthesize the category visual playbook plus a concrete differentiated photo + video plan. ' +
  'Respond with JSON ONLY — no preamble, no markdown fences, no commentary.';

function buildSynthesisPrompt(
  analyses: PerListingAnalysis[],
  wedge: string,
  videoPresenceRate: number
): string {
  return [
    'NICHE: wedding day timeline template (digital Etsy product).',
    '',
    'OUR DIFFERENTIATION WEDGE (must be reflected in recommended_photo_set, recommended_video_concept, and visual_gaps):',
    wedge,
    '',
    `VIDEO PRESENCE (computed from Etsy API across analyzed listings): ${videoPresenceRate}% have a video. Use this exact number for video_presence_rate.`,
    '',
    'PER-LISTING VISUAL ANALYSES (JSON):',
    JSON.stringify(
      analyses.map(a => ({
        listing_id: a.listing_id,
        mockup_style: a.mockup_style,
        aesthetic: a.aesthetic,
        color_palette: a.color_palette,
        pages_shown: a.pages_shown,
        featured_prominently: a.featured_prominently,
        photo_count: a.photo_count,
        has_video: a.has_video
      })),
      null,
      2
    ),
    '',
    'Output exactly this JSON shape:',
    '{',
    '  "dominant_mockup_style": "...",',
    '  "dominant_aesthetic": "...",',
    '  "dominant_color_palette": ["c1", "c2", "c3"],',
    '  "standard_photo_set_structure": "hero mockup -> detail pages -> lifestyle -> close-up (describe the typical sequence)",',
    '  "most_shown_sections": ["section1", "section2", "..."],',
    `  "video_presence_rate": ${videoPresenceRate},`,
    '  "visual_gaps": "what is NOT shown anywhere that our vendor-specific cue sheet wedge (photographer tab, caterer tab, DJ tab) could uniquely demonstrate",',
    '  "recommended_photo_set": [',
    '    {"photo": 1, "shows": "...", "why": "..."},',
    '    ... exactly 7 entries, and at least one MUST explicitly demonstrate the per-vendor (photographer/caterer/DJ) cue-sheet split ...',
    '  ],',
    '  "recommended_video_concept": {"duration_seconds": "10-20", "scenes": [{"t": "0-3s", "show": "..."}, ...], "summary": "demonstrates the three-tab differentiator"},',
    `  "listings_analyzed": ${analyses.length}`,
    '}',
    '',
    'JSON only. Be concrete and specific to this niche and wedge.'
  ].join('\n');
}

async function synthesize(
  analyses: PerListingAnalysis[],
  wedge: string,
  videoPresenceRate: number
): Promise<VisionCallResult<Record<string, unknown>>> {
  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 4096,
    system: SYNTHESIS_SYSTEM,
    messages: [
      { role: 'user', content: buildSynthesisPrompt(analyses, wedge, videoPresenceRate) }
    ]
  });

  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const costUsd = estimateCostUsd(inputTokens, outputTokens);

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | undefined;
  try {
    parsed = JSON.parse(stripJsonFences(getText(resp))) as Record<string, unknown>;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: 'Sonnet visual cross-listing synthesis',
    metadata: {
      provider: 'anthropic',
      model: VISION_MODEL,
      step: 'visual_synthesis',
      listings_analyzed: analyses.length,
      estimated_cost_usd: costUsd
    }
  });

  return { parsed, costUsd, inputTokens, outputTokens, parseError };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtList(v: string[] | null | undefined): string {
  if (!v || v.length === 0) return '—';
  return v.join(', ');
}

function buildReport(args: {
  niche_tag: string;
  decisionTitle: string;
  wedge: string;
  synthesis: Record<string, unknown>;
  perListing: PerListingAnalysis[];
  listingsAnalyzed: number;
  imagesAnalyzed: number;
  totalCostUsd: number;
  durationSec: number;
  videoPresenceRate: number;
}): string {
  const s = args.synthesis;
  const lines: string[] = [];
  lines.push(`# Visual Competitive Analysis — ${args.decisionTitle}`);
  lines.push('');
  lines.push(
    `> Generated ${new Date().toISOString().slice(0, 10)} | niche_tag: \`${args.niche_tag}\` | model: ${VISION_MODEL} | listings analyzed: ${args.listingsAnalyzed} | images analyzed: ${args.imagesAnalyzed}`
  );
  lines.push('');
  lines.push(`**Wedge under test:** ${args.wedge}`);
  lines.push('');

  lines.push('## Synthesis — category visual playbook');
  lines.push('');
  lines.push(`- **Dominant mockup style:** ${coerceString(s['dominant_mockup_style']) ?? '—'}`);
  lines.push(`- **Dominant aesthetic:** ${coerceString(s['dominant_aesthetic']) ?? '—'}`);
  lines.push(`- **Dominant color palette:** ${fmtList(coerceStringArray(s['dominant_color_palette']))}`);
  lines.push(`- **Standard photo-set structure:** ${coerceString(s['standard_photo_set_structure']) ?? '—'}`);
  lines.push(`- **Most-shown sections:** ${fmtList(coerceStringArray(s['most_shown_sections']))}`);
  lines.push(`- **Video presence rate (API-confirmed):** ${args.videoPresenceRate}%`);
  lines.push('');
  lines.push('### Visual gaps (our opening)');
  lines.push('');
  lines.push(coerceString(s['visual_gaps']) ?? '—');
  lines.push('');

  lines.push('### Recommended 7-photo set');
  lines.push('');
  const photoSet = Array.isArray(s['recommended_photo_set']) ? (s['recommended_photo_set'] as unknown[]) : [];
  if (photoSet.length === 0) {
    lines.push('_Not produced._');
  } else {
    lines.push('| # | Shows | Why |');
    lines.push('| ---: | --- | --- |');
    photoSet.forEach((p, i) => {
      const obj = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const num = coerceString(String(obj['photo'] ?? '')) ?? String(i + 1);
      lines.push(`| ${num} | ${coerceString(obj['shows']) ?? '—'} | ${coerceString(obj['why']) ?? '—'} |`);
    });
  }
  lines.push('');

  lines.push('### Recommended video concept');
  lines.push('');
  const video = (s['recommended_video_concept'] && typeof s['recommended_video_concept'] === 'object'
    ? s['recommended_video_concept']
    : {}) as Record<string, unknown>;
  lines.push(`- **Duration:** ${coerceString(String(video['duration_seconds'] ?? '')) ?? '10–20s'}`);
  lines.push(`- **Summary:** ${coerceString(video['summary']) ?? '—'}`);
  const scenes = Array.isArray(video['scenes']) ? (video['scenes'] as unknown[]) : [];
  if (scenes.length > 0) {
    lines.push('');
    lines.push('| Time | Scene |');
    lines.push('| --- | --- |');
    for (const sc of scenes) {
      const obj = (sc && typeof sc === 'object' ? sc : {}) as Record<string, unknown>;
      lines.push(`| ${coerceString(String(obj['t'] ?? '')) ?? '—'} | ${coerceString(obj['show']) ?? '—'} |`);
    }
  }
  lines.push('');

  lines.push('## Per-listing analyses');
  lines.push('');
  lines.push('| Listing | Shop | Mockup style | Aesthetic | Pages shown | Video |');
  lines.push('| --- | --- | --- | --- | --- | :---: |');
  for (const a of args.perListing) {
    lines.push(
      `| ${truncate(a.title, 48)} | ${a.shop_name ?? '—'} | ${a.mockup_style ?? '—'} | ${a.aesthetic ?? '—'} | ${fmtList(a.pages_shown)} | ${a.has_video ? '✅' : '—'} |`
    );
  }
  lines.push('');

  lines.push('## Run stats');
  lines.push('');
  lines.push(`- Listings analyzed: ${args.listingsAnalyzed}`);
  lines.push(`- Images analyzed: ${args.imagesAnalyzed}`);
  lines.push(`- Total cost: $${args.totalCostUsd.toFixed(4)}`);
  lines.push(`- Duration: ${args.durationSec}s`);
  lines.push(`- Video presence rate (API-confirmed): ${args.videoPresenceRate}%`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const startedAt = Date.now();
  const decisionId = parseArg('decision-id');
  if (!decisionId) {
    console.error('Missing --decision-id=<uuid>');
    process.exit(1);
  }

  // Load decision row (read-only — we never claim or advance it).
  const { data: decision, error: decisionErr } = await supabase
    .from('decisions_needed')
    .select('id, title, context')
    .eq('id', decisionId)
    .maybeSingle();

  if (decisionErr || !decision) {
    console.error(`Decision ${decisionId} not found: ${decisionErr?.message ?? 'no row'}`);
    process.exit(1);
  }

  const ctx = (decision.context ?? {}) as Record<string, unknown>;
  const keyword =
    (typeof ctx['primary_keyword'] === 'string' ? ctx['primary_keyword'] : '') ||
    (typeof ctx['seed_key'] === 'string' ? (ctx['seed_key'] as string).replace(/_/g, ' ') : '') ||
    decision.title;
  // niche_tag is set EXPLICITLY here — NOT via the subreddit resolver.
  const nicheTag = slugify(keyword);
  const wedge =
    typeof ctx['wedge'] === 'string'
      ? ctx['wedge']
      : 'vendor-specific coordinator bundle — photographer, caterer, and DJ each get their own auto-calculating cue sheet; incumbents are generic all-day timelines';

  console.log(`> visual analyst for decision ${decisionId}`);
  console.log(`  keyword: "${keyword}" → niche_tag: ${nicheTag}`);

  // agent_runs row (visual_analyst). Schema has no run_type/decision_id columns,
  // so those live in metadata; agent_name + input_ref carry the identity.
  const { data: runRow, error: runErr } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'visual_analyst',
      status: 'running',
      input_ref: decisionId,
      model_used: VISION_MODEL,
      cost_usd: 0,
      metadata: { run_type: 'visual_analyst', decision_id: decisionId, niche_tag: nicheTag }
    })
    .select('id')
    .single();

  if (runErr || !runRow) {
    throw new Error(`Failed to create agent_runs row: ${runErr?.message ?? 'unknown'}`);
  }
  const runId = runRow.id as string;
  let totalCostUsd = 0;

  try {
    await log({
      agent: 'intel',
      action: 'visual_analyst.start',
      description: `Visual analyst starting for "${keyword}" (decision ${decisionId.slice(0, 8)})`,
      metadata: { decision_id: decisionId, niche_tag: nicheTag, keywords: SEARCH_KEYWORDS }
    });

    // ----- STEP 1: search + dedupe -----
    const searchArrays = await mapWithLimit(
      SEARCH_KEYWORDS,
      ETSY_API_CONCURRENCY,
      ETSY_API_STAGGER_MS,
      k => searchEtsy(k, { limit: 25, sortOn: 'score' })
    );
    const seen = new Set<number>();
    const candidates: Candidate[] = [];
    for (const arr of searchArrays) {
      for (const r of arr) {
        if (r.listing_id <= 0 || seen.has(r.listing_id)) continue;
        seen.add(r.listing_id);
        candidates.push({ listing_id: r.listing_id, shop_id: r.shop_id, title: r.title });
        if (candidates.length >= TOP_LISTINGS_POOL) break;
      }
      if (candidates.length >= TOP_LISTINGS_POOL) break;
    }
    console.log(`  deduped candidate pool: ${candidates.length} listings`);

    // ----- STEP 1b: fetch image metadata + has_video per candidate -----
    const withImagery = await mapWithLimit(
      candidates,
      ETSY_API_CONCURRENCY,
      ETSY_API_STAGGER_MS,
      async (c): Promise<ListingImagery | null> => {
        // Sequenced (not Promise.all): firing both per listing under 2 workers
        // put ~4 calls in flight and tripped Etsy's 429 ceiling.
        const imgMeta = await fetchListingImageMeta(c.listing_id);
        if (imgMeta.length === 0) return null;
        const hasVideo = await fetchHasVideo(c.listing_id);
        return {
          listing_id: c.listing_id,
          shop_id: c.shop_id,
          title: c.title,
          shop_name: null,
          total_photo_count: imgMeta.length,
          has_video: hasVideo,
          imageUrls: imgMeta.slice(0, IMAGES_PER_LISTING).map(m => m.url),
          images: []
        };
      }
    );

    // ----- STEP 2: select listings under the global image cap, then download -----
    const selected: ListingImagery[] = [];
    let plannedImages = 0;
    for (const li of withImagery) {
      if (!li) continue;
      if (selected.length >= TARGET_LISTINGS) break;
      const take = Math.min(li.imageUrls.length, MAX_IMAGES_TOTAL - plannedImages);
      if (take <= 0) break;
      li.imageUrls = li.imageUrls.slice(0, take);
      plannedImages += take;
      selected.push(li);
      if (plannedImages >= MAX_IMAGES_TOTAL) break;
    }
    console.log(
      `  selected ${selected.length} listings, ${plannedImages} images planned (cap ${MAX_IMAGES_TOTAL})`
    );

    // Flat download queue (cap 3 concurrent). Failures log + skip.
    const downloadTasks: Array<{ idx: number; url: string }> = [];
    selected.forEach((li, idx) => li.imageUrls.forEach(url => downloadTasks.push({ idx, url })));
    const downloaded = await mapWithLimit(
      downloadTasks,
      IMAGE_DOWNLOAD_CONCURRENCY,
      0,
      t => downloadImage(t.url)
    );
    downloaded.forEach((d, i) => {
      if (d) selected[downloadTasks[i].idx].images.push(d);
    });

    // Drop listings that ended with zero successfully-downloaded images.
    const analyzable = selected.filter(li => li.images.length > 0);
    const imagesAnalyzed = analyzable.reduce((n, li) => n + li.images.length, 0);
    console.log(`  downloaded ${imagesAnalyzed} images across ${analyzable.length} listings`);

    if (analyzable.length === 0) {
      throw new Error('No listings with downloadable images — aborting before vision calls.');
    }

    // ----- STEP 1c: shop names for the analyzable set -----
    const shops = await mapWithLimit(
      analyzable,
      ETSY_API_CONCURRENCY,
      ETSY_API_STAGGER_MS,
      li => getShop(li.shop_id)
    );
    shops.forEach((sh, i) => {
      analyzable[i].shop_name = sh?.shop_name ?? null;
    });

    // ----- STEP 3: per-listing vision (Sonnet) -----
    const visionResults = await mapWithLimit(
      analyzable,
      VISION_CONCURRENCY,
      0,
      li => analyzeListing(li)
    );

    const perListing: PerListingAnalysis[] = analyzable.map((li, i) => {
      const r = visionResults[i];
      totalCostUsd += r.costUsd;
      const p = r.parsed ?? {};
      return {
        listing_id: li.listing_id,
        title: li.title,
        shop_name: li.shop_name,
        mockup_style: coerceString(p['mockup_style']),
        aesthetic: coerceString(p['aesthetic']),
        color_palette: coerceStringArray(p['color_palette']),
        pages_shown: coerceStringArray(p['pages_shown']),
        featured_prominently: coerceString(p['featured_prominently']),
        // photo_count + has_video are GROUND TRUTH from the API, not the model.
        photo_count: li.total_photo_count,
        has_video: li.has_video
      };
    });

    // Video presence rate computed from API data only.
    const videoCount = perListing.filter(a => a.has_video).length;
    const videoPresenceRate = Math.round((videoCount / perListing.length) * 100);

    // ----- STEP 4: cross-listing synthesis (Sonnet) -----
    const synthRes = await synthesize(perListing, wedge, videoPresenceRate);
    totalCostUsd += synthRes.costUsd;
    if (!synthRes.parsed) {
      throw new Error(`Synthesis JSON parse failed: ${synthRes.parseError ?? 'unknown'}`);
    }
    const synthesis = synthRes.parsed;
    // Force the API-derived rate regardless of what the model emitted.
    synthesis['video_presence_rate'] = videoPresenceRate;
    synthesis['listings_analyzed'] = perListing.length;

    // ----- STEP 5: write niche_memory (explicit niche_tag) -----
    const memoryValue = sanitizeJsonbDeep({
      ...synthesis,
      analyzed_at: new Date().toISOString(),
      decision_id: decisionId,
      images_analyzed: imagesAnalyzed,
      per_listing: perListing.map(a => ({
        listing_id: a.listing_id,
        shop_name: a.shop_name,
        mockup_style: a.mockup_style,
        aesthetic: a.aesthetic,
        color_palette: a.color_palette,
        pages_shown: a.pages_shown,
        featured_prominently: a.featured_prominently,
        photo_count: a.photo_count,
        has_video: a.has_video
      }))
    });

    const MEMORY_KEY = 'visual_competitive_intel';
    const { data: existing, error: fetchErr } = await supabase
      .from('niche_memory')
      .select('id, evidence_count')
      .eq('niche_tag', nicheTag)
      .eq('memory_key', MEMORY_KEY)
      .maybeSingle();

    if (fetchErr) {
      console.error(`  niche_memory fetch error: ${fetchErr.message}`);
    }

    if (existing) {
      const { error: updErr } = await supabase
        .from('niche_memory')
        .update({
          memory_value: memoryValue,
          confidence: 0.85,
          source: 'visual_analyst',
          evidence_count: (existing.evidence_count ?? 1) + 1,
          last_updated_at: new Date().toISOString()
        })
        .eq('id', existing.id);
      if (updErr) console.error(`  niche_memory update error: ${updErr.message}`);
    } else {
      const { error: insErr } = await supabase.from('niche_memory').insert({
        niche_tag: nicheTag,
        memory_key: MEMORY_KEY,
        memory_value: memoryValue,
        confidence: 0.85,
        source: 'visual_analyst',
        evidence_count: 1
      });
      if (insErr) console.error(`  niche_memory insert error: ${insErr.message}`);
    }

    // ----- STEP 5b: markdown report -----
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    const briefsDir = path.resolve(process.cwd(), 'briefs');
    await mkdir(briefsDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(briefsDir, `visual-${dateStr}-${nicheTag}.md`);
    const report = buildReport({
      niche_tag: nicheTag,
      decisionTitle: decision.title as string,
      wedge,
      synthesis,
      perListing,
      listingsAnalyzed: perListing.length,
      imagesAnalyzed,
      totalCostUsd,
      durationSec,
      videoPresenceRate
    });
    await writeFile(reportPath, report, 'utf-8');
    console.log(`  report written to ${reportPath}`);

    // ----- STEP 5c: complete agent_runs -----
    const { error: completeErr } = await supabase
      .from('agent_runs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        output_ref: reportPath,
        cost_usd: totalCostUsd,
        metadata: {
          run_type: 'visual_analyst',
          decision_id: decisionId,
          niche_tag: nicheTag,
          listings_analyzed: perListing.length,
          images_analyzed: imagesAnalyzed,
          video_presence_rate: videoPresenceRate,
          duration_sec: durationSec
        }
      })
      .eq('id', runId);
    if (completeErr) console.error(`  agent_runs complete error: ${completeErr.message}`);

    await log({
      agent: 'intel',
      action: 'visual_analyst.complete',
      description: `Visual analyst done: ${perListing.length} listings, ${imagesAnalyzed} images, video rate ${videoPresenceRate}% in ${durationSec}s`,
      severity: 'success',
      metadata: {
        decision_id: decisionId,
        niche_tag: nicheTag,
        listings_analyzed: perListing.length,
        images_analyzed: imagesAnalyzed,
        video_presence_rate: videoPresenceRate,
        cost_usd: totalCostUsd,
        report_path: reportPath
      }
    });

    console.log('');
    console.log(`✓ visual analysis complete (${durationSec}s)`);
    console.log(`  listings analyzed: ${perListing.length}`);
    console.log(`  images analyzed:   ${imagesAnalyzed}`);
    console.log(`  video presence:    ${videoPresenceRate}%`);
    console.log(`  total cost:        $${totalCostUsd.toFixed(4)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: msg,
        cost_usd: totalCostUsd
      })
      .eq('id', runId);
    await log({
      agent: 'intel',
      action: 'visual_analyst.failed',
      description: `Visual analyst failed for decision ${decisionId.slice(0, 8)}`,
      severity: 'error',
      metadata: { decision_id: decisionId, error: msg }
    });
    throw err;
  }
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('visual analyst job crashed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
