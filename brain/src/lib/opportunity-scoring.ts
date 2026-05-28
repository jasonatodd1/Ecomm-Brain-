// Opportunity scoring engine — the "is this niche beatable for us" composite.
//
// This extends the competitive SEO scoring engine (etsy-seo-scoring.ts): that
// engine scores individual incumbents on a keyword; here we turn the incumbent
// signals for a keyword into three pillars (Demand, Attackability, AI-fit) and
// a single Opportunity Score that ranks Etsy niches by where a zero-review,
// AI-pipeline shop can realistically win.
//
// Design constraints (mirrors whitespace-scoring.ts / etsy-seo-scoring.ts):
//   - Pure functions. No DB, no network, no LLM. Same input -> same output.
//     The orchestrating job (scan-opportunities.ts) does all I/O + LLM calls
//     and feeds the results in here.
//   - Every magic number is a NAMED CONFIG CONSTANT below, commented with its
//     intent. Almost all are FIRST-PASS and need tuning/validation against the
//     known fortress-vs-open results from real scan runs.

export const OPPORTUNITY_SCORER_VERSION = 'v1';

// ===========================================================================
// CONFIG CONSTANTS — first-pass, need tuning/validation.
// ===========================================================================

// --- Sales model (Etsy does not expose sales; we model it) ---------------
// FIRST-PASS, needs tuning/validation: assume ~1 public review per ~30 sales.
// Real review rates for digital goods are often lower (1 per 40-100), so this
// likely UNDER-counts sales; tune against any niche where we later learn true
// volume.
export const REVIEW_TO_SALES_MULTIPLIER = 30;

// --- Demand pillar -------------------------------------------------------
// demand_pool = sum(est_monthly_sales) across analyzed listings (modeled).
// Banded 0-100 map. FIRST-PASS thresholds, need tuning/validation.
export const DEMAND_POOL_LOW = 50; // < this/mo across the niche = low (maps 0..40)
export const DEMAND_POOL_STRONG = 300; // >= this = strong (maps 75..100)
export const DEMAND_POOL_CEILING = 1500; // demand_pool at/above this = full 100
// HARD GATE: niches whose modeled monthly demand pool is below this are
// EXCLUDED ("insufficient demand"). Set below DEMAND_POOL_LOW so genuinely
// low-but-alive niches still score (just low) rather than being culled.
// FIRST-PASS, needs tuning/validation.
export const MIN_DEMAND_POOL = 25;

// --- Attackability pillar (higher = more beatable) -----------------------
// Inverted median-review tiers. FIRST-PASS, need tuning/validation.
export const REVIEW_TIER_1 = 200; // < 200 median reviews -> very soft
export const REVIEW_TIER_2 = 1000; // 200-1000 -> moderate
export const REVIEW_TIER_3 = 5000; // 1000-5000 -> hard; > 5000 -> fortress
export const INVERT_REVIEWS_T1 = 90; // score when median < REVIEW_TIER_1
export const INVERT_REVIEWS_T2 = 70; // REVIEW_TIER_1..REVIEW_TIER_2
export const INVERT_REVIEWS_T3 = 40; // REVIEW_TIER_2..REVIEW_TIER_3
export const INVERT_REVIEWS_T4 = 10; // > REVIEW_TIER_3 (fortress)

// soft_ratio: share of top 10 with review_count below this ceiling.
export const SOFT_REVIEW_CEILING = 500; // FIRST-PASS, needs tuning/validation

// youth_signal: a listing counts as "surging / rankings not locked" if it has
// real modeled traction but is young and/or low-review.
export const YOUTH_MIN_MONTHLY_SALES = 20; // modeled est_monthly_sales >= this
export const YOUTH_MAX_REVIEWS = 100; // AND review_count < this ...
export const YOUTH_MAX_AGE_MONTHS = 12; // ... OR age_months <= this
// (All three FIRST-PASS, need tuning/validation.)

// Attackability component weights (must sum to 1.0). FIRST-PASS.
export const W_MEDIAN_REVIEWS = 0.4;
export const W_SOFT_RATIO = 0.15;
export const W_YOUTH_SIGNAL = 0.15;
export const W_SEO_GAP = 0.15;
export const W_SPECIFICITY_GAP = 0.15;

// --- AI-fit pillar (higher = our AI pipeline is a real edge) -------------
// Product-type bands. Haiku classifies the dominant product type and places a
// score; we clamp to the band to keep the classification disciplined.
// FIRST-PASS bands, need tuning/validation.
export const AI_FIT_CONTENT_MIN = 80; // content/structure-heavy (templates, planners, trackers, docs)
export const AI_FIT_CONTENT_MAX = 100;
export const AI_FIT_MIXED_MIN = 40; // mixed (~50)
export const AI_FIT_MIXED_MAX = 60;
export const AI_FIT_CRAFT_MIN = 0; // taste/craft-heavy (illustration, presets, photography, fonts)
export const AI_FIT_CRAFT_MAX = 30;
// When the niche is AI-art-generation-heavy, cap AI-fit and flag it: Etsy's
// 2026 AI-art enforcement makes these high-takedown-risk regardless of how
// "AI-able" they are.
export const AI_FIT_COMPLIANCE_CAP = 20;
// HARD GATE: AI-fit below this is EXCLUDED ("low AI leverage / craft-moated /
// AI-compliance risk"). Set so craft-heavy (0-30) is culled but mixed (~50)
// survives. FIRST-PASS, needs tuning/validation.
export const AI_FIT_FLOOR = 40;

// --- Composite weights (must sum to 1.0). FIRST-PASS. --------------------
export const W_ATTACKABILITY = 0.45;
export const W_DEMAND = 0.3;
export const W_AI_FIT = 0.25;

// ===========================================================================
// Types
// ===========================================================================

export type ProductType = 'content_structure' | 'mixed' | 'craft_taste';

/** One analyzed incumbent listing for a keyword. */
export interface AnalyzedListing {
  listing_id: number;
  shop_id: number;
  /** 0-based search rank (organic position before dedup gaps). */
  rank: number;
  title: string;
  tags: string[];
  review_count: number;
  /** Months since listing creation; null if Etsy didn't return a timestamp. */
  age_months: number | null;
  age_missing: boolean;
  price: number | null;
  image_count: number | null;
  // Modeled (not actual) — flagged everywhere they surface.
  est_lifetime_sales: number;
  est_monthly_sales: number;
}

/** The single Haiku assessment per keyword (classification + SEO + specificity). */
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

export interface OpportunitySubScores {
  invert_median_reviews: number;
  soft_ratio: number; // 0-100 (share *100)
  youth_signal: number; // 0-100 (share *100)
  seo_gap: number; // 0-100
  specificity_gap: number; // 0-100
}

export interface OpportunitySignals {
  analyzed_count: number;
  top10_count: number;
  median_reviews: number;
  demand_pool: number;
  soft_share: number; // 0-1
  youth_share: number; // 0-1
  product_type: ProductType;
  ai_art_generation_heavy: boolean;
  /** True if ANY analyzed listing is missing a creation timestamp. */
  any_age_missing: boolean;
}

export interface OpportunityScoreResult {
  version: string;
  status: 'scored' | 'excluded';
  reasons: string[];
  opportunity_score: number;
  demand: number;
  attackability: number;
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
// Sales model (modeled, NOT actual)
// ===========================================================================

/**
 * First-pass modeled sales from public review count. Returns NaN-safe figures.
 * est_lifetime_sales = review_count * REVIEW_TO_SALES_MULTIPLIER
 * est_monthly_sales  = est_lifetime_sales / max(age_months, 1)
 */
export function modelSales(
  reviewCount: number,
  ageMonths: number | null
): { est_lifetime_sales: number; est_monthly_sales: number } {
  const reviews = Number.isFinite(reviewCount) && reviewCount > 0 ? reviewCount : 0;
  const lifetime = reviews * REVIEW_TO_SALES_MULTIPLIER;
  const months = ageMonths != null && ageMonths > 1 ? ageMonths : 1;
  return {
    est_lifetime_sales: lifetime,
    est_monthly_sales: lifetime / months
  };
}

// ===========================================================================
// Pillar: Demand
// ===========================================================================

export function scoreDemandPool(pool: number): number {
  if (!Number.isFinite(pool) || pool <= 0) return 0;
  if (pool < DEMAND_POOL_LOW) {
    return round1((pool / DEMAND_POOL_LOW) * 40); // 0..40
  }
  if (pool < DEMAND_POOL_STRONG) {
    const t = (pool - DEMAND_POOL_LOW) / (DEMAND_POOL_STRONG - DEMAND_POOL_LOW);
    return round1(40 + t * 35); // 40..75
  }
  const t = (pool - DEMAND_POOL_STRONG) / (DEMAND_POOL_CEILING - DEMAND_POOL_STRONG);
  return round1(clamp(75 + t * 25, 75, 100)); // 75..100
}

// ===========================================================================
// Pillar: Attackability
// ===========================================================================

export function invertMedianReviews(medianReviews: number): number {
  if (medianReviews < REVIEW_TIER_1) return INVERT_REVIEWS_T1;
  if (medianReviews < REVIEW_TIER_2) return INVERT_REVIEWS_T2;
  if (medianReviews < REVIEW_TIER_3) return INVERT_REVIEWS_T3;
  return INVERT_REVIEWS_T4;
}

/** Share (0-1) of top 10 with review_count < SOFT_REVIEW_CEILING. */
export function computeSoftShare(top10: AnalyzedListing[]): number {
  if (top10.length === 0) return 0;
  const soft = top10.filter(l => l.review_count < SOFT_REVIEW_CEILING).length;
  return soft / top10.length;
}

/** Share (0-1) of analyzed listings that look like surging/unlocked rankings. */
export function computeYouthShare(listings: AnalyzedListing[]): number {
  if (listings.length === 0) return 0;
  const young = listings.filter(l => {
    if (l.est_monthly_sales < YOUTH_MIN_MONTHLY_SALES) return false;
    const lowReviews = l.review_count < YOUTH_MAX_REVIEWS;
    const youngAge = l.age_months != null && l.age_months <= YOUTH_MAX_AGE_MONTHS;
    return lowReviews || youngAge;
  }).length;
  return young / listings.length;
}

export function computeAttackability(args: {
  median_reviews: number;
  soft_share: number; // 0-1
  youth_share: number; // 0-1
  seo_gap: number; // 0-100
  specificity_gap: number; // 0-100
}): { attackability: number; sub_scores: OpportunitySubScores } {
  const invMed = invertMedianReviews(args.median_reviews);
  const soft = clamp(args.soft_share, 0, 1) * 100;
  const youth = clamp(args.youth_share, 0, 1) * 100;
  const seoGap = clamp(args.seo_gap, 0, 100);
  const specGap = clamp(args.specificity_gap, 0, 100);

  const attackability = clamp(
    W_MEDIAN_REVIEWS * invMed +
      W_SOFT_RATIO * soft +
      W_YOUTH_SIGNAL * youth +
      W_SEO_GAP * seoGap +
      W_SPECIFICITY_GAP * specGap,
    0,
    100
  );

  return {
    attackability: round1(attackability),
    sub_scores: {
      invert_median_reviews: round1(invMed),
      soft_ratio: round1(soft),
      youth_signal: round1(youth),
      seo_gap: round1(seoGap),
      specificity_gap: round1(specGap)
    }
  };
}

// ===========================================================================
// Pillar: AI-fit
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
    return { ai_fit: round1(Math.min(banded, AI_FIT_COMPLIANCE_CAP)), compliance_risk: true };
  }
  return { ai_fit: round1(banded), compliance_risk: false };
}

// ===========================================================================
// Top-level scorer
// ===========================================================================

export function scoreOpportunity(
  listings: AnalyzedListing[],
  llm: IncumbentLlmAssessment
): OpportunityScoreResult {
  const analyzed = listings;
  const top10 = [...analyzed].sort((a, b) => a.rank - b.rank).slice(0, 10);

  const median_reviews = median(top10.map(l => l.review_count));
  const demand_pool = analyzed.reduce((sum, l) => sum + l.est_monthly_sales, 0);
  const soft_share = computeSoftShare(top10);
  const youth_share = computeYouthShare(analyzed);
  const any_age_missing = analyzed.some(l => l.age_missing);

  const demand = scoreDemandPool(demand_pool);
  const { attackability, sub_scores } = computeAttackability({
    median_reviews,
    soft_share,
    youth_share,
    seo_gap: clamp(100 - llm.seo_quality, 0, 100), // invert: sloppy incumbents = bigger gap
    specificity_gap: llm.specificity_gap
  });
  const { ai_fit, compliance_risk } = computeAiFit(llm);

  const signals: OpportunitySignals = {
    analyzed_count: analyzed.length,
    top10_count: top10.length,
    median_reviews: round1(median_reviews),
    demand_pool: round1(demand_pool),
    soft_share: round1(soft_share * 100) / 100,
    youth_share: round1(youth_share * 100) / 100,
    product_type: llm.product_type,
    ai_art_generation_heavy: llm.ai_art_generation_heavy,
    any_age_missing
  };

  // --- Hard gates ---
  const reasons: string[] = [];
  if (demand_pool < MIN_DEMAND_POOL) {
    reasons.push(
      `insufficient demand (modeled demand_pool ${round1(demand_pool)} < MIN_DEMAND_POOL ${MIN_DEMAND_POOL}/mo)`
    );
  }
  if (ai_fit < AI_FIT_FLOOR) {
    reasons.push(
      compliance_risk
        ? `AI-compliance risk (AI-art-generation-heavy; ai_fit capped at ${AI_FIT_COMPLIANCE_CAP}, < floor ${AI_FIT_FLOOR})`
        : `low AI leverage / craft-moated (ai_fit ${ai_fit} < floor ${AI_FIT_FLOOR})`
    );
  }

  if (reasons.length > 0) {
    return {
      version: OPPORTUNITY_SCORER_VERSION,
      status: 'excluded',
      reasons,
      opportunity_score: 0,
      demand,
      attackability,
      ai_fit,
      compliance_risk,
      sub_scores,
      signals
    };
  }

  const opportunity_score = round1(
    W_ATTACKABILITY * attackability + W_DEMAND * demand + W_AI_FIT * ai_fit
  );

  return {
    version: OPPORTUNITY_SCORER_VERSION,
    status: 'scored',
    reasons: [],
    opportunity_score,
    demand,
    attackability,
    ai_fit,
    compliance_risk,
    sub_scores,
    signals
  };
}
