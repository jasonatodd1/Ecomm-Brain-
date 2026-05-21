// Shared SEO scoring engine for Etsy listings.
// Spec: brain/COMPETITIVE_SEO_SCORING.md
//
// Consumers: the Research Agent (supply-side gap discovery during market
// analysis, COMPETITIVE_SEO_SCORING.md §4) and the future Listing Agent
// (pre-publish quality gate + post-publish drift monitoring, §5).
//
// Design constraints (from spec §2):
//   - Pure function. No DB, no network, no LLM. Same input → same output.
//   - Versioned. v1 = 10 rules (8 always evaluated, 2 conditional). When the
//     rubric evolves, bump SCORER_VERSION and re-score historical snapshots.
//   - Cheap: callable in bulk (10 results × N keywords per brief).

import type { EtsyListingDetails } from './etsy-search.js';

export const SCORER_VERSION = 'v1';

export interface SeoScoreBreakdownEntry {
  score: number;
  max: number;
  note: string;
}

export interface SeoScore {
  total: number;
  max: number;
  /** Convenience field: `max > 0 ? total / max : 0`. */
  percent: number;
  /**
   * Rule keys where `score < max`, sorted descending by `max - score`.
   * Callers can `weak_areas.slice(0, 3)` to surface the top-3 improvable
   * dimensions in synthesis prompts or operator UIs.
   */
  weak_areas: string[];
  detailed_breakdown: Record<string, SeoScoreBreakdownEntry>;
  version: string;
}

export interface ScoringContext {
  /**
   * The keyword we care about ranking for. Drives title/description keyword
   * placement checks. If absent, those two rules are skipped (their max is
   * not counted toward `SeoScore.max`).
   */
  primary_keyword?: string;
  /** Reserved for future niche-specific weighting. Not used in v1. */
  niche_tag?: string;
  /**
   * Number of attribute slots that exist for this listing's taxonomy, per the
   * live store-schema fetch (`LISTING_AGENT_REQUIREMENTS.md` §3). When
   * provided, the attribute_fill_rate rule is evaluated; when absent, the
   * rule is skipped. v1 callers (Research Agent) do not pass this.
   */
  applicable_attribute_count?: number;
  /**
   * How many attribute slots the listing has actually filled. Required if
   * `applicable_attribute_count` is provided; ignored otherwise.
   */
  filled_attribute_count?: number;
  /**
   * Set to true if the caller has detected an AI signature in any of the
   * listing's images or in its description text. When true, the
   * ai_disclosure_compliance rule checks the disclosure flag; when false (or
   * absent), the rule scores full credit on the "no signature detected" path.
   */
  ai_signature_detected?: boolean;
  /**
   * The listing's AI-disclosure flag as set on Etsy. Only consulted when
   * `ai_signature_detected` is true.
   */
  ai_disclosure_flag?: boolean;
}

// ---------------------------------------------------------------------------
// Tier scoring helper — keeps rule definitions readable.
// Pass an array of [threshold, points] tuples sorted descending; the first
// tuple whose threshold the value clears wins.
// ---------------------------------------------------------------------------
function scoreTier(
  value: number,
  tiers: Array<[number, number]>
): number {
  for (const [threshold, points] of tiers) {
    if (value >= threshold) return points;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// String matching helpers
// ---------------------------------------------------------------------------

function normalizeForCompare(s: string): string {
  return s.toLowerCase().trim();
}

/** Find the keyword phrase in haystack; returns the start index or -1. */
function findKeyword(haystack: string, keyword: string): number {
  return normalizeForCompare(haystack).indexOf(normalizeForCompare(keyword));
}

/** Tokens of length ≥3 (drops articles/connectives and noise). */
function meaningfulTokens(s: string): string[] {
  return normalizeForCompare(s)
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

export function scoreEtsyListingSeo(
  listing: EtsyListingDetails,
  context: ScoringContext = {}
): SeoScore {
  const breakdown: Record<string, SeoScoreBreakdownEntry> = {};
  let total = 0;
  let max = 0;

  const title = listing.title ?? '';
  const description = listing.description ?? '';
  const tags = Array.isArray(listing.tags) ? listing.tags : [];

  // -------------------------------------------------------------------------
  // Rule 1: title_length
  // 10 if 100-140; 7 if 80-99 or 141-155; 4 if 50-79; 0 if <50.
  // -------------------------------------------------------------------------
  {
    const titleLen = title.length;
    let score = 0;
    if (titleLen >= 100 && titleLen <= 140) score = 10;
    else if (
      (titleLen >= 80 && titleLen <= 99) ||
      (titleLen >= 141 && titleLen <= 155)
    )
      score = 7;
    else if (titleLen >= 50 && titleLen <= 79) score = 4;
    breakdown['title_length'] = {
      score,
      max: 10,
      note: `Title ${titleLen} chars (target 100-140)`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 2: title_keyword_placement
  // 10 if front-loaded (idx < 30); 7 if anywhere; 0 if absent.
  // Skipped when no primary_keyword in context.
  // -------------------------------------------------------------------------
  if (context.primary_keyword) {
    const key = context.primary_keyword;
    const idx = findKeyword(title, key);
    let score = 0;
    let note: string;
    if (idx >= 0 && idx < 30) {
      score = 10;
      note = `Keyword front-loaded (idx ${idx})`;
    } else if (idx >= 0) {
      score = 7;
      note = `Keyword present but not front-loaded (idx ${idx})`;
    } else {
      // Fallback: check whether all meaningful tokens of the keyword appear
      // somewhere in the title — partial credit for keyword tokens scattered
      // even when the exact phrase isn't preserved.
      const keyTokens = meaningfulTokens(key);
      const titleNorm = normalizeForCompare(title);
      const matched = keyTokens.filter(t => titleNorm.includes(t));
      if (matched.length === keyTokens.length && keyTokens.length > 0) {
        score = 7;
        note = `Keyword tokens all present but not as exact phrase`;
      } else {
        score = 0;
        note = `Primary keyword absent from title (matched ${matched.length}/${keyTokens.length} tokens)`;
      }
    }
    breakdown['title_keyword_placement'] = { score, max: 10, note };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 3: tag_count
  // 10 if 13; 7 if 11-12; 4 if 8-10; 0 if <8.
  // -------------------------------------------------------------------------
  {
    const n = tags.length;
    const score = n === 13 ? 10 : scoreTier(n, [[11, 7], [8, 4]]);
    breakdown['tag_count'] = {
      score,
      max: 10,
      note: `${n} of 13 tags`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 4: tag_quality
  // Start at 10, subtract 1 per failing tag (length >20 OR substring duplicate
  // of title). Floor 0.
  // -------------------------------------------------------------------------
  {
    const titleNorm = normalizeForCompare(title);
    let bad = 0;
    for (const tag of tags) {
      const tagNorm = normalizeForCompare(tag);
      if (!tagNorm) continue;
      const tooLong = tagNorm.length > 20;
      // Treat as title-duplicate only when the full tag appears as a contiguous
      // substring of the title (lowercased). Single-word overlaps are normal
      // Etsy practice; full-phrase duplication is the wasted slot we penalize.
      const dupOfTitle = tagNorm.length >= 4 && titleNorm.includes(tagNorm);
      if (tooLong || dupOfTitle) bad++;
    }
    const score = Math.max(0, 10 - bad);
    breakdown['tag_quality'] = {
      score,
      max: 10,
      note: `${bad} of ${tags.length} tags fail quality checks (length >20 or full-phrase title duplicate)`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 5: description_length
  // 10 if ≥2000; 7 if 1500-1999; 4 if 1000-1499; 0 if <1000.
  // -------------------------------------------------------------------------
  {
    const n = description.length;
    const score = scoreTier(n, [[2000, 10], [1500, 7], [1000, 4]]);
    breakdown['description_length'] = {
      score,
      max: 10,
      note: `Description ${n} chars (target ≥2000)`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 6: description_keyword_in_preview
  // 10 if keyword in first 160 chars (search-preview window).
  // 5 if elsewhere in description; 0 if absent. Skipped without primary_keyword.
  // -------------------------------------------------------------------------
  if (context.primary_keyword) {
    const key = context.primary_keyword;
    const descNorm = normalizeForCompare(description);
    const preview = descNorm.slice(0, 160);
    const keyNorm = normalizeForCompare(key);
    let score = 0;
    let note: string;
    if (preview.includes(keyNorm)) {
      score = 10;
      note = `Primary keyword in first 160 chars`;
    } else if (descNorm.includes(keyNorm)) {
      score = 5;
      note = `Primary keyword present but not in first 160 chars`;
    } else {
      score = 0;
      note = `Primary keyword absent from description`;
    }
    breakdown['description_keyword_in_preview'] = { score, max: 10, note };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 7: description_scannable_structure
  // Heuristic: ALL-CAPS section headers (≥2), bullet markers (≥3), FAQ
  // markers (≥2). 10 if all 3 present; 7/4/0 for fewer.
  // -------------------------------------------------------------------------
  {
    const lines = description.split('\n');
    const allCapsHeaders = lines.filter(line => {
      const t = line.trim();
      if (t.length < 4 || t.length > 80) return false;
      const letters = t.replace(/[^A-Za-z]/g, '');
      if (letters.length < 3) return false;
      const upperLetters = letters.replace(/[^A-Z]/g, '');
      return upperLetters.length / letters.length >= 0.8;
    }).length;
    const bulletLines = lines.filter(line => /^\s*[-•*]\s+\S/.test(line)).length;
    const faqLines = lines.filter(line => /^\s*Q[.):]?\s/i.test(line)).length;

    let markers = 0;
    if (allCapsHeaders >= 2) markers++;
    if (bulletLines >= 3) markers++;
    if (faqLines >= 2) markers++;

    const score = scoreTier(markers, [[3, 10], [2, 7], [1, 4]]);
    breakdown['description_scannable_structure'] = {
      score,
      max: 10,
      note: `${markers}/3 markers present (caps_headers=${allCapsHeaders}, bullets=${bulletLines}, faq_lines=${faqLines})`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 8: attribute_fill_rate
  // 10 if ≥80% filled; 7 if 60-79%; 4 if 40-59%; 0 if <40%.
  // SKIPPED unless caller passes both applicable_attribute_count AND
  // filled_attribute_count (the Etsy taxonomy properties endpoint provides
  // the denominator — Research Agent does not fetch it; future Listing
  // Agent will). Per spec: blank rule is always better than a fabricated one.
  // -------------------------------------------------------------------------
  if (
    typeof context.applicable_attribute_count === 'number' &&
    typeof context.filled_attribute_count === 'number' &&
    context.applicable_attribute_count > 0
  ) {
    const ratio =
      context.filled_attribute_count / context.applicable_attribute_count;
    const pct = ratio * 100;
    const score = scoreTier(pct, [[80, 10], [60, 7], [40, 4]]);
    breakdown['attribute_fill_rate'] = {
      score,
      max: 10,
      note: `${context.filled_attribute_count}/${context.applicable_attribute_count} attribute slots filled (${pct.toFixed(0)}%)`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 9: shop_section_assigned
  // 10 if non-null; 0 if not. (Etsy uses shop sections as a category signal
  // and as cross-listing navigation.)
  // -------------------------------------------------------------------------
  {
    const assigned =
      typeof listing.shop_section_id === 'number' && listing.shop_section_id > 0;
    const score = assigned ? 10 : 0;
    breakdown['shop_section_assigned'] = {
      score,
      max: 10,
      note: assigned
        ? `Shop section ${listing.shop_section_id} assigned`
        : `No shop section assigned`
    };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Rule 10: ai_disclosure_compliance
  // Compliance check, not aesthetic. If caller flagged ai_signature_detected,
  // require the disclosure flag; otherwise full credit. SKIPPED when caller
  // doesn't pass `ai_signature_detected` (v1 callers do not — there's no
  // signature-detection infrastructure yet).
  // -------------------------------------------------------------------------
  if (typeof context.ai_signature_detected === 'boolean') {
    let score: number;
    let note: string;
    if (!context.ai_signature_detected) {
      score = 10;
      note = `No AI signature detected — compliance not required`;
    } else if (context.ai_disclosure_flag === true) {
      score = 10;
      note = `AI signature detected AND disclosure flag set`;
    } else {
      score = 0;
      note = `AI signature detected but disclosure flag NOT set — Etsy policy violation risk`;
    }
    breakdown['ai_disclosure_compliance'] = { score, max: 10, note };
    total += score;
    max += 10;
  }

  // -------------------------------------------------------------------------
  // Build weak_areas: rules where score < max, sorted descending by gap.
  // -------------------------------------------------------------------------
  const weak_areas = Object.entries(breakdown)
    .filter(([, e]) => e.score < e.max)
    .sort(([, a], [, b]) => b.max - b.score - (a.max - a.score))
    .map(([k]) => k);

  return {
    total,
    max,
    percent: max > 0 ? total / max : 0,
    weak_areas,
    detailed_breakdown: breakdown,
    version: SCORER_VERSION
  };
}
