// Incumbent intelligence — product-gap axis for the Research Agent (v3).
// Mines Etsy listing reviews + extracts structured product features from
// incumbent listings already fetched by computeCompetitiveLandscape.
//
// COPYRIGHT: verbatim review text never enters the brief. Haiku paraphrases
// recurring themes only; raw reviews live in raw_research for audit, not in
// the published brief JSON.

import Anthropic from '@anthropic-ai/sdk';
import {
  getListingReviews,
  type EtsyListingDetails,
  type EtsyListingReview
} from '../../lib/etsy-search.js';
import { mapWithLimit } from '../../lib/concurrency.js';
import { log } from '../../lib/log.js';
import type {
  BuyerPainSignal,
  IncumbentOffering,
  ProductFeatures
} from './types.js';
import type {
  CompetitiveLandscapeEntry,
  CompetitiveTopIncumbent
} from './competitive.js';
import type { EtsySearchResult } from './types.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const REVIEWS_PER_INCUMBENT = 50;
const HAIKU_PRODUCT_FEATURES_COST = 0.004;
const HAIKU_PARAPHRASE_COST = 0.006;

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

export function selectTopIncumbentsForMining(
  landscape: CompetitiveLandscapeEntry[],
  preferredKeyword?: string
): CompetitiveTopIncumbent[] {
  if (landscape.length === 0) return [];

  let entry = preferredKeyword
    ? landscape.find(
        l => l.keyword.toLowerCase() === preferredKeyword.toLowerCase()
      )
    : undefined;

  if (!entry) {
    entry = landscape.reduce((best, cur) =>
      cur.median_favorers > best.median_favorers ? cur : best
    );
  }

  return entry.top_incumbents.slice(0, 3);
}

function photoCountFromListing(details: EtsyListingDetails): number | null {
  const raw = details.raw;
  if (Array.isArray(raw['images'])) return raw['images'].length;
  if (typeof raw['image_count'] === 'number') return raw['image_count'];
  return null;
}

function formatPrice(
  details: EtsyListingDetails,
  searchResult?: EtsySearchResult
): string {
  if (details.price_cents != null) {
    const ccy = details.currency_code ?? 'USD';
    return `${ccy} ${(details.price_cents / 100).toFixed(2)}`;
  }
  if (searchResult?.price != null) {
    return `USD ${searchResult.price.toFixed(2)}`;
  }
  return 'unknown';
}

async function extractProductFeatures(
  incumbent: CompetitiveTopIncumbent,
  details: EtsyListingDetails,
  searchResult?: EtsySearchResult
): Promise<ProductFeatures> {
  const anthropic = getAnthropic();
  const photoCount = photoCountFromListing(details);
  const desc = details.description.slice(0, 4000);
  const tags = details.tags.slice(0, 20).join(', ');

  const prompt = `You extract structured PRODUCT features from an Etsy digital-product listing. Focus on what the buyer receives — sections, sizes, formats, bundle composition — NOT SEO tags or marketing fluff.

== LISTING ==
listing_id: ${incumbent.listing_id}
title: ${incumbent.title}
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
    description: `Haiku product feature extraction for listing ${incumbent.listing_id}`,
    metadata: {
      provider: 'anthropic',
      model: HAIKU_MODEL,
      step: 'product_features',
      listing_id: incumbent.listing_id,
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
Identify recurring themes: unmet needs, missing features, format/size complaints, usability wishes. Merge duplicates.

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

export interface IncumbentIntelInput {
  landscape: CompetitiveLandscapeEntry[];
  listingDetailsCache: Map<number, EtsyListingDetails>;
  resultsByKeyword: Map<string, EtsySearchResult[]>;
  preferredKeyword?: string;
}

export interface IncumbentIntelResult {
  offerings: IncumbentOffering[];
  buyer_pain_signals: BuyerPainSignal[];
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
    haiku_cost_usd: number;
    duration_ms: number;
  };
}

export async function runIncumbentIntel(
  input: IncumbentIntelInput
): Promise<IncumbentIntelResult> {
  const started = Date.now();
  const incumbents = selectTopIncumbentsForMining(
    input.landscape,
    input.preferredKeyword
  );

  if (incumbents.length === 0) {
    return {
      offerings: [],
      buyer_pain_signals: [],
      raw_signal_reviews: [],
      stats: {
        review_api_calls: 0,
        rate_limited_429: 0,
        incumbents_zero_reviews: [],
        incumbents_insufficient_reviews: [],
        haiku_cost_usd: 0,
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

  let reviewApiCalls = 0;
  let rateLimited429 = 0;
  const incumbentsZeroReviews: string[] = [];
  const incumbentsInsufficientReviews: string[] = [];
  const allSignalReviews: SignalReviewPayload[] = [];
  const reviewStatsByIncumbent = new Map<
    string,
    { total_fetched: number; signal_count: number; note?: string }
  >();

  const reviewResults = await mapWithLimit(incumbents, 2, 200, async inc => {
    const listingId = Number(inc.listing_id);
    const fetched = await getListingReviews(listingId, {
      maxReviews: REVIEWS_PER_INCUMBENT
    });
    reviewApiCalls += fetched.api_calls;
    rateLimited429 += fetched.rate_limited_429;

    if (fetched.total_available === 0 && fetched.reviews.length === 0) {
      incumbentsZeroReviews.push(inc.listing_id);
      reviewStatsByIncumbent.set(inc.listing_id, {
        total_fetched: 0,
        signal_count: 0,
        note: 'zero reviews on Etsy — skipped review mining'
      });
      return { inc, reviews: [] as EtsyListingReview[] };
    }

    if (fetched.reviews.length < 5) {
      incumbentsInsufficientReviews.push(inc.listing_id);
    }

    const signals = fetched.reviews.filter(r =>
      isBuyerSignalReview(r.rating, r.review)
    );

    reviewStatsByIncumbent.set(inc.listing_id, {
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
        listing_id: inc.listing_id,
        rating: s.rating,
        review_text: s.review
      });
    }

    return { inc, reviews: fetched.reviews };
  });

  let haikuCost = 0;
  const offerings: IncumbentOffering[] = [];

  for (const { inc } of reviewResults) {
    const listingId = Number(inc.listing_id);
    const details = input.listingDetailsCache.get(listingId);
    if (!details) continue;

    const searchResult = searchByListingId.get(listingId);
    const product_features = await extractProductFeatures(inc, details, searchResult);
    haikuCost += HAIKU_PRODUCT_FEATURES_COST;

    const stats = reviewStatsByIncumbent.get(inc.listing_id) ?? {
      total_fetched: 0,
      signal_count: 0
    };

    offerings.push({
      incumbent_id: inc.listing_id,
      title: inc.title,
      product_features,
      reviews_mined: stats
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
  if (allSignalReviews.length > 0) {
    haikuCost += HAIKU_PARAPHRASE_COST;
  }

  await log({
    agent: 'intel',
    action: 'incumbent_intel.complete',
    description: `Incumbent intel: ${offerings.length} incumbents, ${buyer_pain_signals.length} pain themes, ${allSignalReviews.length} signal reviews`,
    metadata: {
      incumbent_ids: offerings.map(o => o.incumbent_id),
      review_api_calls: reviewApiCalls,
      rate_limited_429: rateLimited429,
      signal_review_count: allSignalReviews.length,
      pain_theme_count: buyer_pain_signals.length,
      haiku_cost_usd: haikuCost
    }
  });

  return {
    offerings,
    buyer_pain_signals,
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
      haiku_cost_usd: haikuCost,
      duration_ms: Date.now() - started
    }
  };
}
