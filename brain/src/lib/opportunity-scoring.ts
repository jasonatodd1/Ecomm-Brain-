// Opportunity scoring engine v2 — eRank-in-the-loop.
//
// "Is this niche beatable for us?" → three pillars (Demand / Attackability /
// AI-fit) + two hard gates + a composite, ranking Etsy niches by where a
// zero-review, AI-pipeline shop can realistically win.
//
// WHY v2 changed the data source: we verified the Etsy official API cannot
// reproduce on-site organic ranking and never surfaces a niche's true
// high-review incumbents, so API-derived median_reviews / demand were a biased
// proxy (it wrongly scored "budget planner printable" as attackable). v2 sources
// the two broken signals — real demand and real top-10 incumbent strength — from
// a manual eRank pull (a ToS-clean licensed tool) via a CSV worksheet. The
// estimated-sales demand model and the API review-count attackability are GONE.
//
// Design constraints (mirrors whitespace-scoring.ts):
//   - Pure functions. No DB, no network, no LLM. Same input -> same output.
//     Phase C (score-opportunities-from-erank.ts) does all I/O and feeds the
//     parsed worksheet + carried-forward AI-fit results in here.
//   - Every magic number is a NAMED CONFIG CONSTANT below, FIRST-PASS, commented
//     with intent and "needs tuning/validation" where applicable.

export const OPPORTUNITY_SCORER_VERSION = 'v2-erank';

// ===========================================================================
// CONFIG CONSTANTS — first-pass, need tuning/validation against real runs.
// ===========================================================================

// --- Demand pillar (REAL: eRank "Etsy avg searches", monthly) ------------
// Banded 0-100 map of monthly search volume. FIRST-PASS thresholds.
export const DEMAND_SEARCHES_LOW = 100; // < this/mo = low (maps 0..40)
export const DEMAND_SEARCHES_STRONG = 1000; // >= this = strong (maps 75..100)
export const DEMAND_SEARCHES_CEILING = 10000; // at/above = full 100
// HARD GATE: niches whose eRank avg monthly searches are below this are
// EXCLUDED ("insufficient demand"). Replaces the obsolete MIN_DEMAND_POOL
// (which gated on modeled sales). FIRST-PASS, tune against this run.
export const MIN_AVG_SEARCHES = 50;
// Saturation = avg_searches / competition. Reported for tuning. NOT folded
// into the demand score yet (set weight > 0 to enable). FIRST-PASS.
export const SATURATION_ADJUST_WEIGHT = 0;

// --- Attackability pillar (REAL: eRank top-10 organic review counts) ------
// Inverted median-review tiers. FIRST-PASS, need tuning/validation.
export const REVIEW_TIER_1 = 200; // < 200 median reviews -> very soft
export const REVIEW_TIER_2 = 1000; // 200-1000 -> moderate
export const REVIEW_TIER_3 = 5000; // 1000-5000 -> hard; > 5000 -> fortress
export const INVERT_REVIEWS_T1 = 90; // score when median < REVIEW_TIER_1
export const INVERT_REVIEWS_T2 = 70; // REVIEW_TIER_1..REVIEW_TIER_2
export const INVERT_REVIEWS_T3 = 40; // REVIEW_TIER_2..REVIEW_TIER_3
export const INVERT_REVIEWS_T4 = 10; // > REVIEW_TIER_3 (fortress)

// soft_ratio: share of the top 10 with review_count below this ceiling.
export const SOFT_REVIEW_CEILING = 500; // FIRST-PASS, needs tuning/validation

// When one shop dominates the top 3 (a "fortress"), rankings are locked even
// if a few soft listings exist below — cap attackability hard. FIRST-PASS.
export const FORTRESS_ATTACK_CAP = 35;

// Attackability component weights (the ORIGINAL v1 weights, unchanged). The
// youth_signal component (0.15) depended on the now-removed estimated-sales
// model, so in the eRank flow it is always UNKNOWN and excluded; the remaining
// components are renormalized over the weights actually present (consistent
// with the "UNKNOWN excluded from math" rule). FIRST-PASS.
export const W_MEDIAN_REVIEWS = 0.4;
export const W_SOFT_RATIO = 0.15;
export const W_YOUTH_SIGNAL = 0.15; // retained for reference; UNKNOWN in eRank flow
export const W_SEO_GAP = 0.15;
export const W_SPECIFICITY_GAP = 0.15;

// --- AI-fit pillar (Haiku, carried forward from Phase A) -----------------
// Product-type bands. FIRST-PASS bands, need tuning/validation.
export const AI_FIT_CONTENT_MIN = 80; // content/structure-heavy
export const AI_FIT_CONTENT_MAX = 100;
export const AI_FIT_MIXED_MIN = 40; // mixed (~50)
export const AI_FIT_MIXED_MAX = 60;
export const AI_FIT_CRAFT_MIN = 0; // taste/craft-heavy
export const AI_FIT_CRAFT_MAX = 30;
export const AI_FIT_COMPLIANCE_CAP = 20; // AI-art-generation-heavy -> capped + flagged
// HARD GATE: AI-fit below this is EXCLUDED. Applied at Phase A (the AI-fit gate)
// and re-asserted in Phase C. FIRST-PASS, needs tuning/validation.
export const AI_FIT_FLOOR = 40;

// --- Composite weights (must sum to 1.0). FIRST-PASS. --------------------
export const W_ATTACKABILITY = 0.45;
export const W_DEMAND = 0.3;
export const W_AI_FIT = 0.25;

// ===========================================================================
// Types
// ===========================================================================

export type ProductType = 'content_structure' | 'mixed' | 'craft_taste';

/** The single Haiku assessment per keyword (Phase A classification + SEO). */
export interface IncumbentLlmAssessment {
  /** 0-100: how good the top-10 titles/tags are (higher = stronger incumbents). */
  seo_quality: number;
  /** 0-100: how underserved a more specific sub-niche is (higher = bigger gap). */
  specificity_gap: number;
  product_type: ProductType;
  /** 0-100 Haiku placement within the product-type band. */
  ai_fit_raw: number;
  /** True if the niche is AI-art-GENERATION-heavy (compliance risk). */
  ai_art_generation_heavy: boolean;
  dominant_product_summary: string;
}

/** Phase C scoring input: real eRank numbers + carried-forward Phase A AI-fit. */
export interface OpportunityErankInput {
  /** eRank "Etsy avg searches" (monthly). null = blank/unknown. */
  avg_searches: number | null;
  /** eRank "Competition" (# competing listings). null = blank/unknown. */
  competition: number | null;
  /** eRank top-10 organic review counts. null/empty = blank/unknown. */
  top10_review_counts: number[] | null;
  /** One shop dominates the top 3 (from the notes column). */
  fortress: boolean;
  // Carried forward from Phase A (Haiku). Not re-run in Phase C.
  ai_fit: number; // already banded + compliance-capped
  compliance_risk: boolean;
  product_type: ProductType;
  /** seo_gap = 100 - seo_quality (already inverted). 0-100. */
  seo_gap: number;
  specificity_gap: number;
  /** True if excluded at the Phase A AI-fit/compliance gate. */
  ai_excluded: boolean;
  ai_exclude_reason?: string;
}

export interface OpportunitySubScores {
  invert_median_reviews: number | null;
  soft_ratio: number | null; // 0-100
  seo_gap: number;
  specificity_gap: number;
}

export interface OpportunitySignals {
  demand_known: boolean;
  attack_known: boolean;
  avg_searches: number | null;
  competition: number | null;
  saturation_ratio: number | null;
  median_reviews: number | null;
  soft_share: number | null; // 0-1
  fortress: boolean;
  top10_count: number;
  product_type: ProductType;
  compliance_risk: boolean;
}

export type OpportunityStatus = 'scored' | 'excluded' | 'incomplete';
export type DataSource = 'erank_verified' | 'api_preliminary' | 'incomplete';

export interface OpportunityScoreResult {
  version: string;
  status: OpportunityStatus;
  data_source: DataSource;
  reasons: string[];
  /** null when the composite can't be computed (incomplete / excluded). */
  opportunity_score: number | null;
  demand: number | null;
  attackability: number | null;
  ai_fit: number;
  compliance_risk: boolean;
  sub_scores: OpportunitySubScores;
  signals: OpportunitySignals;
}

// ===========================================================================
// Helpers
// ===========================================================================

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ===========================================================================
// Pillar: Demand (eRank avg searches)
// ===========================================================================

export function scoreAvgSearches(avgSearches: number): number {
  if (!Number.isFinite(avgSearches) || avgSearches <= 0) return 0;
  if (avgSearches < DEMAND_SEARCHES_LOW) {
    return round1((avgSearches / DEMAND_SEARCHES_LOW) * 40); // 0..40
  }
  if (avgSearches < DEMAND_SEARCHES_STRONG) {
    const t =
      (avgSearches - DEMAND_SEARCHES_LOW) /
      (DEMAND_SEARCHES_STRONG - DEMAND_SEARCHES_LOW);
    return round1(40 + t * 35); // 40..75
  }
  const t =
    (avgSearches - DEMAND_SEARCHES_STRONG) /
    (DEMAND_SEARCHES_CEILING - DEMAND_SEARCHES_STRONG);
  return round1(clamp(75 + t * 25, 75, 100)); // 75..100
}

// ===========================================================================
// Pillar: Attackability (eRank top-10 review counts)
// ===========================================================================

export function invertMedianReviews(medianReviews: number): number {
  if (medianReviews < REVIEW_TIER_1) return INVERT_REVIEWS_T1;
  if (medianReviews < REVIEW_TIER_2) return INVERT_REVIEWS_T2;
  if (medianReviews < REVIEW_TIER_3) return INVERT_REVIEWS_T3;
  return INVERT_REVIEWS_T4;
}

/** Share (0-1) of the given review counts below SOFT_REVIEW_CEILING. */
export function computeSoftShare(reviewCounts: number[]): number {
  if (reviewCounts.length === 0) return 0;
  const soft = reviewCounts.filter(c => c < SOFT_REVIEW_CEILING).length;
  return soft / reviewCounts.length;
}

export interface AttackabilityResult {
  attackability: number;
  median_reviews: number;
  soft_share: number;
  invert_median_reviews: number;
  soft_ratio: number;
}

/**
 * Real attackability from eRank top-10 review counts + carried-forward Haiku
 * seo_gap/specificity_gap. youth_signal is UNKNOWN in the eRank flow (its input
 * — the estimated-sales model — was removed), so it is excluded and the
 * remaining ORIGINAL weights are renormalized over what's present. A fortress
 * (one shop dominating the top 3) caps the result hard.
 */
export function computeAttackabilityErank(args: {
  review_counts: number[];
  seo_gap: number; // 0-100
  specificity_gap: number; // 0-100
  fortress: boolean;
}): AttackabilityResult {
  const med = median(args.review_counts);
  const invMed = invertMedianReviews(med);
  const softShare = computeSoftShare(args.review_counts);
  const soft = softShare * 100;
  const seoGap = clamp(args.seo_gap, 0, 100);
  const specGap = clamp(args.specificity_gap, 0, 100);

  // Weighted average over the components actually present (youth excluded).
  const components: Array<[number, number]> = [
    [W_MEDIAN_REVIEWS, invMed],
    [W_SOFT_RATIO, soft],
    [W_SEO_GAP, seoGap],
    [W_SPECIFICITY_GAP, specGap]
  ];
  const weightSum = components.reduce((s, [w]) => s + w, 0);
  const weighted = components.reduce((s, [w, v]) => s + w * v, 0) / weightSum;

  let attackability = clamp(weighted, 0, 100);
  if (args.fortress) {
    attackability = Math.min(attackability, FORTRESS_ATTACK_CAP);
  }

  return {
    attackability: round1(attackability),
    median_reviews: round1(med),
    soft_share: round1(softShare * 100) / 100,
    invert_median_reviews: round1(invMed),
    soft_ratio: round1(soft)
  };
}

// ===========================================================================
// Pillar: AI-fit (Haiku — same as v1; banded + compliance cap)
// ===========================================================================

export function computeAiFit(llm: IncumbentLlmAssessment): {
  ai_fit: number;
  compliance_risk: boolean;
} {
  let banded: number;
  switch (llm.product_type) {
    case 'content_structure':
      banded = clamp(llm.ai_fit_raw, AI_FIT_CONTENT_MIN, AI_FIT_CONTENT_MAX);
      break;
    case 'mixed':
      banded = clamp(llm.ai_fit_raw, AI_FIT_MIXED_MIN, AI_FIT_MIXED_MAX);
      break;
    case 'craft_taste':
    default:
      banded = clamp(llm.ai_fit_raw, AI_FIT_CRAFT_MIN, AI_FIT_CRAFT_MAX);
      break;
  }
  if (llm.ai_art_generation_heavy) {
    return {
      ai_fit: round1(Math.min(banded, AI_FIT_COMPLIANCE_CAP)),
      compliance_risk: true
    };
  }
  return { ai_fit: round1(banded), compliance_risk: false };
}

/** The AI-fit hard gate, used at Phase A. Returns the exclusion reason or null. */
export function aiFitExclusionReason(
  ai_fit: number,
  compliance_risk: boolean
): string | null {
  if (ai_fit >= AI_FIT_FLOOR) return null;
  return compliance_risk
    ? `AI-compliance risk (AI-art-generation-heavy; ai_fit capped at ${AI_FIT_COMPLIANCE_CAP}, < floor ${AI_FIT_FLOOR})`
    : `low AI leverage / craft-moated (ai_fit ${ai_fit} < floor ${AI_FIT_FLOOR})`;
}

// ===========================================================================
// Top-level Phase C scorer
// ===========================================================================

export function scoreOpportunityErank(
  input: OpportunityErankInput
): OpportunityScoreResult {
  const baseSignals: OpportunitySignals = {
    demand_known: input.avg_searches != null,
    attack_known: input.top10_review_counts != null && input.top10_review_counts.length > 0,
    avg_searches: input.avg_searches,
    competition: input.competition,
    saturation_ratio:
      input.avg_searches != null && input.competition != null && input.competition > 0
        ? Math.round((input.avg_searches / input.competition) * 100000) / 100000
        : null,
    median_reviews: null,
    soft_share: null,
    fortress: input.fortress,
    top10_count: input.top10_review_counts?.length ?? 0,
    product_type: input.product_type,
    compliance_risk: input.compliance_risk
  };

  const baseSub: OpportunitySubScores = {
    invert_median_reviews: null,
    soft_ratio: null,
    seo_gap: clamp(input.seo_gap, 0, 100),
    specificity_gap: clamp(input.specificity_gap, 0, 100)
  };

  // --- Carried-forward AI-fit exclusion from Phase A (no eRank involved) ---
  if (input.ai_excluded) {
    return {
      version: OPPORTUNITY_SCORER_VERSION,
      status: 'excluded',
      data_source: 'api_preliminary',
      reasons: [input.ai_exclude_reason ?? 'excluded at AI-fit gate (Phase A)'],
      opportunity_score: 0,
      demand: null,
      attackability: null,
      ai_fit: input.ai_fit,
      compliance_risk: input.compliance_risk,
      sub_scores: baseSub,
      signals: baseSignals
    };
  }

  // --- Compute pillars from whatever real data is present ---
  const demand = baseSignals.demand_known
    ? scoreAvgSearches(input.avg_searches as number)
    : null;

  let attackability: number | null = null;
  if (baseSignals.attack_known) {
    const a = computeAttackabilityErank({
      review_counts: input.top10_review_counts as number[],
      seo_gap: baseSub.seo_gap,
      specificity_gap: baseSub.specificity_gap,
      fortress: input.fortress
    });
    attackability = a.attackability;
    baseSignals.median_reviews = a.median_reviews;
    baseSignals.soft_share = a.soft_share;
    baseSub.invert_median_reviews = a.invert_median_reviews;
    baseSub.soft_ratio = a.soft_ratio;
  }

  // --- Demand hard gate (search-volume units) ---
  if (baseSignals.demand_known && (input.avg_searches as number) < MIN_AVG_SEARCHES) {
    return {
      version: OPPORTUNITY_SCORER_VERSION,
      status: 'excluded',
      data_source: 'erank_verified',
      reasons: [
        `insufficient demand (eRank avg searches ${input.avg_searches} < MIN_AVG_SEARCHES ${MIN_AVG_SEARCHES}/mo)`
      ],
      opportunity_score: 0,
      demand,
      attackability,
      ai_fit: input.ai_fit,
      compliance_risk: input.compliance_risk,
      sub_scores: baseSub,
      signals: baseSignals
    };
  }

  // --- Defensive re-assertion of the AI-fit floor (Phase A already gated) ---
  if (input.ai_fit < AI_FIT_FLOOR) {
    return {
      version: OPPORTUNITY_SCORER_VERSION,
      status: 'excluded',
      data_source: 'erank_verified',
      reasons: [
        aiFitExclusionReason(input.ai_fit, input.compliance_risk) ??
          `ai_fit ${input.ai_fit} < floor ${AI_FIT_FLOOR}`
      ],
      opportunity_score: 0,
      demand,
      attackability,
      ai_fit: input.ai_fit,
      compliance_risk: input.compliance_risk,
      sub_scores: baseSub,
      signals: baseSignals
    };
  }

  // --- UNKNOWN pillar(s): cannot compute composite -> incomplete ---
  if (!baseSignals.demand_known || !baseSignals.attack_known) {
    const unknown: string[] = [];
    if (!baseSignals.demand_known) unknown.push('demand (eRank avg searches blank)');
    if (!baseSignals.attack_known) unknown.push('attackability (top-10 review counts blank)');
    return {
      version: OPPORTUNITY_SCORER_VERSION,
      status: 'incomplete',
      data_source: 'incomplete',
      reasons: [`UNKNOWN: ${unknown.join('; ')} — excluded from composite, awaiting eRank data`],
      opportunity_score: null,
      demand,
      attackability,
      ai_fit: input.ai_fit,
      compliance_risk: input.compliance_risk,
      sub_scores: baseSub,
      signals: baseSignals
    };
  }

  // --- Full composite ---
  const opportunity_score = round1(
    W_ATTACKABILITY * (attackability as number) +
      W_DEMAND * (demand as number) +
      W_AI_FIT * input.ai_fit
  );

  return {
    version: OPPORTUNITY_SCORER_VERSION,
    status: 'scored',
    data_source: 'erank_verified',
    reasons: [],
    opportunity_score,
    demand,
    attackability,
    ai_fit: input.ai_fit,
    compliance_risk: input.compliance_risk,
    sub_scores: baseSub,
    signals: baseSignals
  };
}
