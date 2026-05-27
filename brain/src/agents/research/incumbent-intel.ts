// Incumbent intelligence — product-gap axis for the Research Agent (v3+).
// Mines Etsy listing reviews + extracts structured product features from
// incumbent listings selected via a relevance filter (research-v3.1).
//
// SEPARATION FROM SEO-GAP: this module operates on a relevance-filtered set
// (Haiku-classified same-niche competitors). The SEO-gap axis owned by
// computeCompetitiveLandscape continues to use top-by-favorers without
// filtering — different question, different right answer.
//
// COPYRIGHT: verbatim review text never enters the brief. Haiku paraphrases
// recurring themes only; raw reviews live in raw_research for audit, not in
// the published brief JSON.

import Anthropic from '@anthropic-ai/sdk';
import {
  getListingReviews,
  getListing,
  type EtsyListingDetails,
  type EtsyListingReview
} from '../../lib/etsy-search.js';
import { mapWithLimit } from '../../lib/concurrency.js';
import { log } from '../../lib/log.js';
import type {
  BuyerPainSignal,
  DecisionRecord,
  EtsySearchResult,
  IncumbentOffering,
  ProductFeatures,
  RelevanceClassification,
  RelevanceFilterReport
} from './types.js';
import type { CompetitiveLandscapeEntry } from './competitive.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const REVIEWS_PER_INCUMBENT = 50;
const HAIKU_PRODUCT_FEATURES_COST = 0.004;
const HAIKU_PARAPHRASE_COST = 0.006;
const HAIKU_RELEVANCE_COST = 0.0005;

// Relevance-filter tuning. Pool sizes are conservative — Haiku is cheap but
// not free, and most useful relevance signal sits in the top-15 by favorers
// across the keyword set.
const TARGET_RELEVANT_INCUMBENTS = 3;
const INITIAL_CANDIDATE_POOL_SIZE = 20;
const MAX_CANDIDATE_POOL_SIZE = 40;
const RELEVANCE_CONCURRENCY = 4;

const WISHLIST_RE =
  /\b(wish it had|would love|missing|needed|if only|should have|lacks|wanted|would be nice|hope for|add a|needs a)\b/i;

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

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function isBuyerSignalReview(rating: number, text: string): boolean {
  if (rating <= 3) return true;
  return WISHLIST_RE.test(text);
}

function photoCountFromListing(details: EtsyListingDetails): number | null {
  const raw = details.raw;
  if (Array.isArray(raw['images'])) return raw['images'].length;
  if (typeof raw['image_count'] === 'number') return raw['image_count'];
  return null;
}

function formatPrice(
  details: EtsyListingDetails | undefined,
  searchResult?: EtsySearchResult
): string {
  if (details && details.price_cents != null) {
    const ccy = details.currency_code ?? 'USD';
    return `${ccy} ${(details.price_cents / 100).toFixed(2)}`;
  }
  if (searchResult?.price != null) {
    return `USD ${searchResult.price.toFixed(2)}`;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Relevance filter (research-v3.1).
//
// The classifier takes a niche definition (primary keyword + decision context)
// and asks: "Would a buyer searching this keyword expect to land on this
// listing?" — with explicit INCLUDE/EXCLUDE patterns so the model generalizes
// to niches it has not seen. Returns a boolean + short reason for operator
// transparency.
// ---------------------------------------------------------------------------

interface CandidateForClassification {
  listing_id: number;
  title: string;
  description_preview: string;
  num_favorers: number | null;
  tags?: string[];
}

interface NicheDefinition {
  primary_keyword: string;
  decision_title: string;
  decision_description: string;
}

async function classifyIncumbentRelevance(
  candidate: CandidateForClassification,
  niche: NicheDefinition
): Promise<RelevanceClassification> {
  const anthropic = getAnthropic();
  const tagsLine = candidate.tags?.length
    ? candidate.tags.slice(0, 15).join(', ')
    : '(tags not fetched)';

  const prompt = `You determine whether an Etsy listing matches a specific product niche for competitive research.

== NICHE DEFINITION ==
Primary buyer search: "${niche.primary_keyword}"
Decision title: ${niche.decision_title}
Decision context: ${niche.decision_description.slice(0, 500)}

== HOW TO DECIDE ==
INCLUDE listings that ARE the same kind of product a buyer searching "${niche.primary_keyword}" would expect — including sub-audiences, style variants, or feature variations of that product. Example for "meal planner printable": weekly/monthly/family/keto/diabetic meal planner printables all count.

EXCLUDE listings that share keywords but are a different product category — even if Etsy ranks them for the search. Example for "meal planner printable": symptom trackers that happen to log meals, food charts (anti-inflammatory food list, FODMAP chart), recipe books/templates without a planning grid, standalone grocery lists with no meal plan, fitness journals.

A listing is RELEVANT only if its core product is the same category, not a tangential one.

== LISTING ==
title: ${candidate.title}
favorers: ${candidate.num_favorers ?? 'unknown'}
tags: ${tagsLine}
description preview: ${candidate.description_preview.slice(0, 600).replace(/\s+/g, ' ').trim()}

== OUTPUT ==
Return ONLY raw JSON (no markdown fences, no preamble):
{ "relevant": true|false, "reason": "<one short sentence — name the product category, not 'related' or 'similar'>" }`;

  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw =
    resp.content[0]?.type === 'text' ? stripJsonFences(resp.content[0].text) : '';

  let parsed: { relevant?: unknown; reason?: unknown } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // Fail-safe: when the classifier output is unparseable, drop the candidate
    // rather than admit it. Better to under-include than to poison the set.
  }

  return {
    listing_id: String(candidate.listing_id),
    title: candidate.title,
    num_favorers: candidate.num_favorers,
    relevant: parsed.relevant === true,
    reason:
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : 'classification missing — defaulted to drop'
  };
}

interface PoolEntry {
  listing_id: number;
  title: string;
  description_preview: string;
  num_favorers: number | null;
  source_keyword: string;
}

function buildCandidatePool(
  resultsByKeyword: Map<string, EtsySearchResult[]>,
  primaryKeyword: string
): PoolEntry[] {
  const seen = new Set<number>();
  const pool: PoolEntry[] = [];

  const primaryResults = resultsByKeyword.get(primaryKeyword) ?? [];
  for (const r of primaryResults) {
    if (r.listing_id <= 0 || seen.has(r.listing_id)) continue;
    seen.add(r.listing_id);
    pool.push({
      listing_id: r.listing_id,
      title: r.title,
      description_preview: r.description_preview,
      num_favorers: r.num_favorers,
      source_keyword: primaryKeyword
    });
  }

  for (const [keyword, results] of resultsByKeyword.entries()) {
    if (keyword === primaryKeyword) continue;
    for (const r of results) {
      if (r.listing_id <= 0 || seen.has(r.listing_id)) continue;
      seen.add(r.listing_id);
      pool.push({
        listing_id: r.listing_id,
        title: r.title,
        description_preview: r.description_preview,
        num_favorers: r.num_favorers,
        source_keyword: keyword
      });
    }
  }

  // Order by favorers desc — cross-keyword pooling that pulls the heavyweights
  // (e.g. MyLifePlans) to the top even when they don't dominate the primary
  // SERP. Listings without favorers fall to the back.
  pool.sort((a, b) => (b.num_favorers ?? 0) - (a.num_favorers ?? 0));
  return pool;
}

interface RelevanceSelectionResult {
  relevant_pool_entries: PoolEntry[];
  report: RelevanceFilterReport;
  haiku_cost_usd: number;
}

async function selectRelevantIncumbents(
  resultsByKeyword: Map<string, EtsySearchResult[]>,
  primaryKeyword: string,
  decision: DecisionRecord,
  listingDetailsCache: Map<number, EtsyListingDetails>
): Promise<RelevanceSelectionResult> {
  const niche: NicheDefinition = {
    primary_keyword: primaryKeyword,
    decision_title: decision.title,
    decision_description: decision.description
  };

  const fullPool = buildCandidatePool(resultsByKeyword, primaryKeyword);
  const cappedPool = fullPool.slice(0, MAX_CANDIDATE_POOL_SIZE);
  const classifications: RelevanceClassification[] = [];
  let classifiedCount = 0;
  let haikuCost = 0;
  let poolExhausted = false;
  let relevantSelected: PoolEntry[] = [];

  // Incremental expansion: start with INITIAL_CANDIDATE_POOL_SIZE, then expand
  // in steps until we hit TARGET_RELEVANT_INCUMBENTS or exhaust the pool.
  let cursor = 0;
  const expansionStops = Array.from(
    new Set([INITIAL_CANDIDATE_POOL_SIZE, 30, MAX_CANDIDATE_POOL_SIZE])
  ).sort((a, b) => a - b);

  for (const stopAt of expansionStops) {
    const batchEnd = Math.min(stopAt, cappedPool.length);
    if (batchEnd <= cursor) continue;
    const batch = cappedPool.slice(cursor, batchEnd);
    cursor = batchEnd;

    const batchClassifications = await mapWithLimit(
      batch,
      RELEVANCE_CONCURRENCY,
      0,
      async entry => {
        const cached = listingDetailsCache.get(entry.listing_id);
        const tags = cached?.tags;
        return classifyIncumbentRelevance(
          {
            listing_id: entry.listing_id,
            title: entry.title,
            description_preview: entry.description_preview,
            num_favorers: entry.num_favorers,
            tags
          },
          niche
        );
      }
    );

    classifications.push(...batchClassifications);
    classifiedCount += batch.length;
    haikuCost += batch.length * HAIKU_RELEVANCE_COST;

    const relevantIds = new Set(
      classifications.filter(c => c.relevant).map(c => Number(c.listing_id))
    );
    relevantSelected = cappedPool.filter(p => relevantIds.has(p.listing_id));

    if (relevantSelected.length >= TARGET_RELEVANT_INCUMBENTS) break;
    if (batchEnd >= cappedPool.length) {
      poolExhausted = true;
      break;
    }
  }

  if (
    relevantSelected.length < TARGET_RELEVANT_INCUMBENTS &&
    cursor >= cappedPool.length
  ) {
    poolExhausted = true;
  }

  // Keep top-N relevant by favorers (already favorer-ordered).
  const finalSelection = relevantSelected.slice(0, TARGET_RELEVANT_INCUMBENTS);
  const keptCount = finalSelection.length;
  const droppedCount = classifications.filter(c => !c.relevant).length;

  // data_thinness will be refined later once we know review counts; placeholder.
  const report: RelevanceFilterReport = {
    candidate_pool_size: cappedPool.length,
    classified_count: classifiedCount,
    kept_count: keptCount,
    dropped_count: droppedCount,
    pool_exhausted: poolExhausted,
    data_thinness: 'low',
    classifications
  };

  await log({
    agent: 'intel',
    action: 'incumbent_intel.relevance_filtered',
    description: `Relevance filter: ${classifiedCount} classified, ${keptCount} kept, ${droppedCount} dropped (pool ${cappedPool.length}${poolExhausted ? ', exhausted' : ''})`,
    metadata: {
      primary_keyword: primaryKeyword,
      candidate_pool_size: cappedPool.length,
      classified_count: classifiedCount,
      kept_count: keptCount,
      dropped_count: droppedCount,
      pool_exhausted: poolExhausted,
      relevance_haiku_cost_usd: haikuCost,
      kept_ids: finalSelection.map(s => String(s.listing_id))
    }
  });

  return {
    relevant_pool_entries: finalSelection,
    report,
    haiku_cost_usd: haikuCost
  };
}

// ---------------------------------------------------------------------------
// Product-feature extraction (Haiku) — operates on relevance-filtered set.
// ---------------------------------------------------------------------------

async function extractProductFeatures(
  listingId: number,
  title: string,
  details: EtsyListingDetails,
  searchResult?: EtsySearchResult
): Promise<ProductFeatures> {
  const anthropic = getAnthropic();
  const photoCount = photoCountFromListing(details);
  const desc = details.description.slice(0, 4000);
  const tags = details.tags.slice(0, 20).join(', ');

  const prompt = `You extract structured PRODUCT features from an Etsy digital-product listing. Focus on what the buyer receives — sections, sizes, formats, bundle composition — NOT SEO tags or marketing fluff.

== LISTING ==
listing_id: ${listingId}
title: ${title}
price: ${formatPrice(details, searchResult)}
photo_count: ${photoCount ?? 'unknown'}
tags: ${tags || '(none)'}
description:
${desc}

== TASK ==
Return ONLY raw JSON (no markdown fences) matching this schema:
{
  "sections": ["<product areas included, e.g. weekly meal grid, grocery list>"],
  "sizes": ["<US Letter / A4 / A5 / etc.>"],
  "formats": ["<PDF / JPG / editable Canva / etc.>"],
  "style_angle": "<one phrase: minimalist / boho / vintage / etc.>",
  "bundle_composition": "<single sheet vs multi-page bundle; lifetime updates; page count if stated>",
  "price_point": "<price tier phrase with number, e.g. budget $1.99 or mid-tier $4.99>",
  "distinguishing_features": ["<niche angle, special functionality, anything that stands out>"]
}

Use "unknown" or empty arrays when the listing does not state a field. Do not invent features not implied by the listing text.`;

  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: `Haiku product feature extraction for listing ${listingId}`,
    metadata: {
      provider: 'anthropic',
      model: HAIKU_MODEL,
      step: 'product_features',
      listing_id: listingId,
      estimated_cost_usd: HAIKU_PRODUCT_FEATURES_COST
    }
  });

  const text =
    resp.content[0]?.type === 'text' ? stripJsonFences(resp.content[0].text) : '';
  const parsed = JSON.parse(text) as Record<string, unknown>;

  return {
    sections: Array.isArray(parsed['sections'])
      ? (parsed['sections'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    sizes: Array.isArray(parsed['sizes'])
      ? (parsed['sizes'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    formats: Array.isArray(parsed['formats'])
      ? (parsed['formats'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    style_angle:
      typeof parsed['style_angle'] === 'string' ? parsed['style_angle'] : 'unknown',
    bundle_composition:
      typeof parsed['bundle_composition'] === 'string'
        ? parsed['bundle_composition']
        : 'unknown',
    price_point:
      typeof parsed['price_point'] === 'string'
        ? parsed['price_point']
        : formatPrice(details, searchResult),
    distinguishing_features: Array.isArray(parsed['distinguishing_features'])
      ? (parsed['distinguishing_features'] as unknown[]).filter(
          (s): s is string => typeof s === 'string'
        )
      : []
  };
}

interface SignalReviewPayload {
  listing_id: string;
  rating: number;
  /** Internal only — never copied to brief. */
  review_text: string;
}

async function paraphraseBuyerPainSignals(
  signalReviews: SignalReviewPayload[],
  incumbentSummaries: Array<{ listing_id: string; title: string; signal_count: number }>
): Promise<BuyerPainSignal[]> {
  if (signalReviews.length === 0) {
    return [];
  }

  const anthropic = getAnthropic();
  const reviewLines = signalReviews
    .slice(0, 80)
    .map(
      (r, i) =>
        `[${i + 1}] listing=${r.listing_id} rating=${r.rating}/5: ${r.review_text.slice(0, 400)}`
    )
    .join('\n');

  const prompt = `You synthesize recurring buyer pain themes from Etsy product reviews for competitive research.

== CRITICAL COPYRIGHT RULE ==
You MUST NOT quote or closely reproduce any review text in your output. Every example must be a fresh paraphrase in your own words. No quotation marks around buyer language. No verbatim phrases from the input.

== INCUMBENT REVIEW COVERAGE ==
${incumbentSummaries.map(s => `- ${s.listing_id}: "${s.title}" (${s.signal_count} signal reviews)`).join('\n')}

== FILTERED REVIEWS (3-star-and-below OR wishlist/complaint language) ==
${reviewLines}

== TASK ==
Identify recurring themes: unmet needs, missing features, format/size complaints, usability wishes. Merge duplicates. Note signal strength honestly — single-mention themes are weak.

Return ONLY raw JSON (no markdown fences):
{
  "buyer_pain_signals": [
    {
      "theme": "<short theme label>",
      "frequency_indicator": "<e.g. 'mentioned in ~4 reviews across 2 incumbents' or 'single mention — weak signal'>",
      "paraphrased_examples": ["<1-3 paraphrased buyer-voice examples — NEVER verbatim from input>"]
    }
  ]
}

If no meaningful patterns exist, return {"buyer_pain_signals": []}. Do not fabricate themes.`;

  const resp = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }]
  });

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: 'Haiku buyer pain signal paraphrase',
    metadata: {
      provider: 'anthropic',
      model: HAIKU_MODEL,
      step: 'review_paraphrase',
      signal_review_count: signalReviews.length,
      estimated_cost_usd: HAIKU_PARAPHRASE_COST
    }
  });

  const text =
    resp.content[0]?.type === 'text' ? stripJsonFences(resp.content[0].text) : '';
  const parsed = JSON.parse(text) as { buyer_pain_signals?: unknown };
  const raw = parsed.buyer_pain_signals;
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      theme: typeof item['theme'] === 'string' ? item['theme'] : 'unspecified',
      frequency_indicator:
        typeof item['frequency_indicator'] === 'string'
          ? item['frequency_indicator']
          : 'unknown frequency',
      paraphrased_examples: Array.isArray(item['paraphrased_examples'])
        ? (item['paraphrased_examples'] as unknown[]).filter(
            (s): s is string => typeof s === 'string'
          )
        : []
    }));
}

// ---------------------------------------------------------------------------
// Orchestrator entry — relevance filter → review mining → feature extraction.
// ---------------------------------------------------------------------------

export interface IncumbentIntelInput {
  /** Used only to surface SEO-gap context to logs; not for incumbent selection. */
  landscape: CompetitiveLandscapeEntry[];
  listingDetailsCache: Map<number, EtsyListingDetails>;
  resultsByKeyword: Map<string, EtsySearchResult[]>;
  /** Primary keyword for niche definition + pool ordering. */
  primaryKeyword: string;
  /** Decision context feeds the relevance classifier. */
  decision: DecisionRecord;
}

export interface IncumbentIntelResult {
  offerings: IncumbentOffering[];
  buyer_pain_signals: BuyerPainSignal[];
  relevance_filter: RelevanceFilterReport;
  /** Raw signal reviews for raw_research audit — NOT for brief publication. */
  raw_signal_reviews: Array<{
    listing_id: string;
    rating: number;
    create_timestamp: number;
  }>;
  stats: {
    review_api_calls: number;
    rate_limited_429: number;
    incumbents_zero_reviews: string[];
    incumbents_insufficient_reviews: string[];
    additional_listing_fetches: number;
    haiku_cost_usd: number;
    haiku_relevance_cost_usd: number;
    duration_ms: number;
  };
}

function classifyDataThinness(
  totalReviewsFetched: number,
  signalReviewCount: number
): 'high' | 'medium' | 'low' {
  if (signalReviewCount >= 20 && totalReviewsFetched >= 50) return 'high';
  if (signalReviewCount >= 8 && totalReviewsFetched >= 20) return 'medium';
  return 'low';
}

export async function runIncumbentIntel(
  input: IncumbentIntelInput
): Promise<IncumbentIntelResult> {
  const started = Date.now();

  // Step 1 — Relevance filter. Replaces the previous top-3-by-favorers
  // selection from the SEO landscape. SEO-gap output is untouched.
  const selection = await selectRelevantIncumbents(
    input.resultsByKeyword,
    input.primaryKeyword,
    input.decision,
    input.listingDetailsCache
  );

  if (selection.relevant_pool_entries.length === 0) {
    selection.report.data_thinness = 'low';
    return {
      offerings: [],
      buyer_pain_signals: [],
      relevance_filter: selection.report,
      raw_signal_reviews: [],
      stats: {
        review_api_calls: 0,
        rate_limited_429: 0,
        incumbents_zero_reviews: [],
        incumbents_insufficient_reviews: [],
        additional_listing_fetches: 0,
        haiku_cost_usd: selection.haiku_cost_usd,
        haiku_relevance_cost_usd: selection.haiku_cost_usd,
        duration_ms: Date.now() - started
      }
    };
  }

  const searchByListingId = new Map<number, EtsySearchResult>();
  for (const results of input.resultsByKeyword.values()) {
    for (const r of results) {
      if (r.listing_id > 0) searchByListingId.set(r.listing_id, r);
    }
  }

  // Step 2 — Fetch full listing details for any relevant incumbent not in
  // the SEO-landscape cache (bounded — at most TARGET_RELEVANT_INCUMBENTS).
  const missingDetailIds = selection.relevant_pool_entries
    .map(e => e.listing_id)
    .filter(id => !input.listingDetailsCache.has(id));
  const additionalFetched = await mapWithLimit(missingDetailIds, 2, 200, id =>
    getListing(id)
  );
  const augmentedCache = new Map(input.listingDetailsCache);
  additionalFetched.forEach((details, i) => {
    if (details) augmentedCache.set(missingDetailIds[i], details);
  });

  // Build classification-reason lookup once.
  const reasonByListingId = new Map<string, string>(
    selection.report.classifications.map(c => [c.listing_id, c.reason])
  );

  // Step 3 — Review mining.
  let reviewApiCalls = 0;
  let rateLimited429 = 0;
  const incumbentsZeroReviews: string[] = [];
  const incumbentsInsufficientReviews: string[] = [];
  const allSignalReviews: SignalReviewPayload[] = [];
  let totalReviewsFetched = 0;
  const reviewStatsByIncumbent = new Map<
    string,
    { total_fetched: number; signal_count: number; note?: string }
  >();

  const reviewResults = await mapWithLimit(
    selection.relevant_pool_entries,
    2,
    200,
    async entry => {
      const listingId = entry.listing_id;
      const idStr = String(listingId);
      const fetched = await getListingReviews(listingId, {
        maxReviews: REVIEWS_PER_INCUMBENT
      });
      reviewApiCalls += fetched.api_calls;
      rateLimited429 += fetched.rate_limited_429;
      totalReviewsFetched += fetched.reviews.length;

      if (fetched.total_available === 0 && fetched.reviews.length === 0) {
        incumbentsZeroReviews.push(idStr);
        reviewStatsByIncumbent.set(idStr, {
          total_fetched: 0,
          signal_count: 0,
          note: 'zero reviews on Etsy — skipped review mining'
        });
        return { entry, reviews: [] as EtsyListingReview[] };
      }

      if (fetched.reviews.length < 5) {
        incumbentsInsufficientReviews.push(idStr);
      }

      const signals = fetched.reviews.filter(r =>
        isBuyerSignalReview(r.rating, r.review)
      );

      reviewStatsByIncumbent.set(idStr, {
        total_fetched: fetched.reviews.length,
        signal_count: signals.length,
        note:
          fetched.rate_limited_429 > 0
            ? 'review fetch hit 429 — partial sample'
            : fetched.reviews.length < 5
              ? 'few reviews available — weak buyer-voice signal'
              : undefined
      });

      for (const s of signals) {
        allSignalReviews.push({
          listing_id: idStr,
          rating: s.rating,
          review_text: s.review
        });
      }

      return { entry, reviews: fetched.reviews };
    }
  );

  // Step 4 — Product feature extraction per relevant incumbent.
  let productFeatureHaikuCost = 0;
  const offerings: IncumbentOffering[] = [];

  for (const { entry } of reviewResults) {
    const listingId = entry.listing_id;
    const idStr = String(listingId);
    const details = augmentedCache.get(listingId);
    if (!details) continue;

    const searchResult = searchByListingId.get(listingId);
    const product_features = await extractProductFeatures(
      listingId,
      entry.title,
      details,
      searchResult
    );
    productFeatureHaikuCost += HAIKU_PRODUCT_FEATURES_COST;

    const stats = reviewStatsByIncumbent.get(idStr) ?? {
      total_fetched: 0,
      signal_count: 0
    };

    offerings.push({
      incumbent_id: idStr,
      title: entry.title,
      product_features,
      reviews_mined: stats,
      relevance_reason: reasonByListingId.get(idStr)
    });
  }

  const incumbentSummaries = offerings.map(o => ({
    listing_id: o.incumbent_id,
    title: o.title,
    signal_count: o.reviews_mined?.signal_count ?? 0
  }));

  const buyer_pain_signals = await paraphraseBuyerPainSignals(
    allSignalReviews,
    incumbentSummaries
  );
  const paraphraseCost = allSignalReviews.length > 0 ? HAIKU_PARAPHRASE_COST : 0;
  const haikuCost =
    selection.haiku_cost_usd + productFeatureHaikuCost + paraphraseCost;

  selection.report.data_thinness = classifyDataThinness(
    totalReviewsFetched,
    allSignalReviews.length
  );

  await log({
    agent: 'intel',
    action: 'incumbent_intel.complete',
    description: `Incumbent intel: ${offerings.length} relevant incumbents, ${buyer_pain_signals.length} pain themes, ${allSignalReviews.length} signal reviews (data thinness: ${selection.report.data_thinness})`,
    metadata: {
      incumbent_ids: offerings.map(o => o.incumbent_id),
      review_api_calls: reviewApiCalls,
      rate_limited_429: rateLimited429,
      signal_review_count: allSignalReviews.length,
      pain_theme_count: buyer_pain_signals.length,
      data_thinness: selection.report.data_thinness,
      pool_exhausted: selection.report.pool_exhausted,
      haiku_cost_usd: haikuCost
    }
  });

  return {
    offerings,
    buyer_pain_signals,
    relevance_filter: selection.report,
    raw_signal_reviews: allSignalReviews.map(r => ({
      listing_id: r.listing_id,
      rating: r.rating,
      create_timestamp: 0
    })),
    stats: {
      review_api_calls: reviewApiCalls,
      rate_limited_429: rateLimited429,
      incumbents_zero_reviews: incumbentsZeroReviews,
      incumbents_insufficient_reviews: incumbentsInsufficientReviews,
      additional_listing_fetches: missingDetailIds.length,
      haiku_cost_usd: haikuCost,
      haiku_relevance_cost_usd: selection.haiku_cost_usd,
      duration_ms: Date.now() - started
    }
  };
}
