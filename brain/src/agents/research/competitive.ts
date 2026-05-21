// Competitive landscape analysis — supply-side gap discovery.
// Spec: brain/COMPETITIVE_SEO_SCORING.md §4.
//
// For each extracted keyword, score the top N already-fetched search results
// using the shared SEO scoring engine, classify the keyword by the score
// distribution, and emit a structured `competitive_landscape` entry that
// downstream synthesis (and later the Listing Agent) consume.
//
// This module owns the classification thresholds (which differ from the
// markdown spec's defaults — see classifyKeyword). It does NOT own scoring
// rules; those live in src/lib/etsy-seo-scoring.ts.

import { getListing } from '../../lib/etsy-search.js';
import {
  scoreEtsyListingSeo,
  type SeoScore
} from '../../lib/etsy-seo-scoring.js';
import { mapWithLimit } from '../../lib/concurrency.js';
import { log } from '../../lib/log.js';
import type { EtsySearchResult } from './types.js';

export type CompetitiveClassification =
  | 'red_ocean'
  | 'mixed'
  | 'weak_incumbents'
  | 'open_field';

export interface CompetitiveTopIncumbent {
  listing_id: string;
  title: string;
  score: number;
  max: number;
  percent: number;
  weak_areas: string[];
}

export interface CompetitiveLandscapeEntry {
  keyword: string;
  classification: CompetitiveClassification;
  /** Top 3 by num_favorers, with their SEO scores. */
  top_incumbents: CompetitiveTopIncumbent[];
  /**
   * Synthesis-ready prose for use in brief.reasoning. E.g. "10 of top results
   * for 'minimalist a5 inserts' average 52% SEO score (classification:
   * weak_incumbents). Common weak areas: description_length,
   * description_scannable_structure, shop_section_assigned."
   */
  gap_summary: string;
  /** How many of the top N were actually scored (some getListing() calls may fail). */
  scored_count: number;
  /** Median SEO percent across the scored top N (0..1). */
  median_percent: number;
}

// ---------------------------------------------------------------------------
// Classification thresholds.
//
// Per the task spec (PART D of the Tuning Pass 2 prompt):
//   - 3+ results above 80% of max  → red_ocean
//   - all top results below 50%    → open_field
//   - 3+ results below 60% of max  → weak_incumbents
//   - otherwise                    → mixed
//
// Evaluation order matters: open_field (the strongest opportunity signal) is
// checked first, then weak_incumbents, then red_ocean, then mixed as the
// catch-all. This biases the classifier toward surfacing opportunities when
// the distribution is ambiguous.
// ---------------------------------------------------------------------------
const STRONG_THRESHOLD = 0.8;
const WEAK_THRESHOLD = 0.6;
const OPEN_FIELD_THRESHOLD = 0.5;
const STRONG_OR_WEAK_COUNT = 3;

export function classifyKeyword(
  percents: number[]
): CompetitiveClassification {
  if (percents.length === 0) return 'mixed';
  const above80 = percents.filter(p => p >= STRONG_THRESHOLD).length;
  const below60 = percents.filter(p => p < WEAK_THRESHOLD).length;
  const allBelow50 = percents.every(p => p < OPEN_FIELD_THRESHOLD);
  if (allBelow50) return 'open_field';
  if (below60 >= STRONG_OR_WEAK_COUNT) return 'weak_incumbents';
  if (above80 >= STRONG_OR_WEAK_COUNT) return 'red_ocean';
  return 'mixed';
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function topNCommonWeakAreas(allWeakAreas: string[][], n: number): string[] {
  const counts = new Map<string, number>();
  for (const arr of allWeakAreas) {
    for (const area of arr) {
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([area]) => area);
}

// ---------------------------------------------------------------------------
// Main entrypoint. Caller passes per-keyword search results (already fetched
// by the existing market-analysis step in the agent), gets back the landscape
// entry per keyword PLUS the listing-details cache (so callers can re-use
// EtsyListingDetails for any other purpose without re-fetching).
// ---------------------------------------------------------------------------
export interface CompetitiveLandscapeInput {
  keywords: string[];
  /** Per-keyword search results from searchEtsy(). Order matters within values. */
  resultsByKeyword: Map<string, EtsySearchResult[]>;
  /** Top-N results per keyword to score. Defaults to 10 per the spec. */
  topN?: number;
}

export interface CompetitiveLandscapeResult {
  landscape: CompetitiveLandscapeEntry[];
  /** All listing details fetched during scoring, keyed by Etsy listing_id. */
  listingDetailsCache: Map<number, NonNullable<Awaited<ReturnType<typeof getListing>>>>;
  /** Operational stats for logging. */
  stats: {
    unique_listings_fetched: number;
    successful_fetches: number;
    failed_fetches: number;
    duration_ms: number;
  };
}

export async function computeCompetitiveLandscape(
  input: CompetitiveLandscapeInput
): Promise<CompetitiveLandscapeResult> {
  const started = Date.now();
  const topN = input.topN ?? 10;

  // 1. Per keyword, take top N by num_favorers (best proxy for visibility on
  //    the search results page, given we don't have rank data).
  const topPerKeyword = new Map<string, EtsySearchResult[]>();
  const allListingIds = new Set<number>();
  for (const k of input.keywords) {
    const results = input.resultsByKeyword.get(k) ?? [];
    const top = [...results]
      .filter(r => r.listing_id > 0)
      .sort((a, b) => (b.num_favorers ?? 0) - (a.num_favorers ?? 0))
      .slice(0, topN);
    topPerKeyword.set(k, top);
    for (const r of top) allListingIds.add(r.listing_id);
  }

  // 2. Fetch full details (deduped across keywords — the same listing can
  //    rank in multiple keyword searches). Concurrency-limited to match the
  //    existing Etsy traffic posture (mapWithLimit(2, 200ms)).
  const uniqueIds = [...allListingIds];
  const fetched = await mapWithLimit(uniqueIds, 2, 200, id => getListing(id));

  type ListingDetails = NonNullable<Awaited<ReturnType<typeof getListing>>>;
  const detailsByIid = new Map<number, ListingDetails>();
  let successful = 0;
  fetched.forEach((details, i) => {
    if (details) {
      detailsByIid.set(uniqueIds[i], details);
      successful++;
    }
  });
  const failed = uniqueIds.length - successful;

  // 3. Score per keyword (using the keyword itself as primary_keyword context).
  const landscape: CompetitiveLandscapeEntry[] = [];
  for (const k of input.keywords) {
    const top = topPerKeyword.get(k) ?? [];
    type Scored = {
      result: EtsySearchResult;
      details: ListingDetails;
      score: SeoScore;
    };
    const scored: Scored[] = [];
    for (const r of top) {
      const details = detailsByIid.get(r.listing_id);
      if (!details) continue;
      const score = scoreEtsyListingSeo(details, { primary_keyword: k });
      scored.push({ result: r, details, score });
    }

    if (scored.length === 0) {
      landscape.push({
        keyword: k,
        classification: 'mixed',
        top_incumbents: [],
        gap_summary: `No incumbents could be scored for "${k}" (0 of ${top.length} listing fetches succeeded). Treat as data-unavailable rather than a real signal.`,
        scored_count: 0,
        median_percent: 0
      });
      continue;
    }

    const percents = scored.map(s => s.score.percent);
    const classification = classifyKeyword(percents);
    const medPercent = median(percents);
    const commonWeak = topNCommonWeakAreas(
      scored.map(s => s.score.weak_areas),
      3
    );

    // Top 3 incumbents by num_favorers (the proxy for "visibly ranked").
    const top3: CompetitiveTopIncumbent[] = [...scored]
      .sort(
        (a, b) =>
          (b.result.num_favorers ?? 0) - (a.result.num_favorers ?? 0)
      )
      .slice(0, 3)
      .map(s => ({
        listing_id: String(s.result.listing_id),
        title: s.details.title,
        score: s.score.total,
        max: s.score.max,
        percent: s.score.percent,
        weak_areas: s.score.weak_areas
      }));

    const gap_summary =
      `Top ${scored.length} for "${k}" median SEO ${(medPercent * 100).toFixed(0)}% — classification: ${classification}. ` +
      `Common weak areas: ${commonWeak.length > 0 ? commonWeak.join(', ') : 'none'}.`;

    landscape.push({
      keyword: k,
      classification,
      top_incumbents: top3,
      gap_summary,
      scored_count: scored.length,
      median_percent: medPercent
    });
  }

  const duration_ms = Date.now() - started;

  await log({
    agent: 'intel',
    action: 'competitive.landscape_computed',
    description: `Competitive landscape: ${landscape.length} keywords scored, ${successful}/${uniqueIds.length} listing fetches succeeded`,
    metadata: {
      keywords: input.keywords,
      classifications: landscape.map(l => ({
        keyword: l.keyword,
        classification: l.classification,
        median_percent: l.median_percent,
        scored_count: l.scored_count
      })),
      unique_listings_fetched: uniqueIds.length,
      successful_fetches: successful,
      failed_fetches: failed,
      duration_ms
    }
  });

  return {
    landscape,
    listingDetailsCache: detailsByIid,
    stats: {
      unique_listings_fetched: uniqueIds.length,
      successful_fetches: successful,
      failed_fetches: failed,
      duration_ms
    }
  };
}
