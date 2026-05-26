// White-space triangulation: demand × supply-quality matrix.
// Spec: brain/COMPETITIVE_SEO_SCORING.md §4 (realized triangulation layer).

import type { CompetitiveClassification } from '../agents/research/competitive.js';

export type WhitespaceQuadrant =
  | 'WHITE_SPACE'
  | 'RED_OCEAN'
  | 'DEAD_ZONE'
  | 'MATURE';

/** Median favorers among top incumbents that normalizes to ~1.0 (printables niche). */
const FAVORERS_REFERENCE = 500;
/** Median shop review count among top incumbents that normalizes to ~1.0. */
const REVIEWS_REFERENCE = 200;

const DEMAND_THRESHOLD = 0.45;
const SUPPLY_WEAK_THRESHOLD = 0.55;

const CLASSIFICATION_SUPPLY_BASE: Record<CompetitiveClassification, number> = {
  open_field: 0.95,
  weak_incumbents: 0.8,
  mixed: 0.5,
  red_ocean: 0.15
};

export interface WhitespaceScoreInput {
  /** External demand from opportunity confidence_score (Trends / Reddit), 0–1. */
  external_demand: number;
  median_favorers: number;
  median_shop_reviews: number | null;
  classification: CompetitiveClassification;
  median_seo_percent: number;
}

export interface WhitespaceScoreResult {
  external_demand: number;
  incumbent_engagement: number;
  demand_combined: number;
  supply_weakness: number;
  white_space_score: number;
  quadrant: WhitespaceQuadrant;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize incumbent engagement from Etsy favorers + shop review counts.
 * Log-scaled so 50 favorers ≠ dead and 5000 favorers ≠ saturated at 1.
 */
export function normalizeIncumbentEngagement(
  medianFavorers: number,
  medianShopReviews: number | null
): number {
  const favorerNorm = clamp(
    Math.log1p(Math.max(0, medianFavorers)) / Math.log1p(FAVORERS_REFERENCE),
    0,
    1
  );
  if (medianShopReviews == null || medianShopReviews <= 0) {
    return favorerNorm;
  }
  const reviewNorm = clamp(
    Math.log1p(medianShopReviews) / Math.log1p(REVIEWS_REFERENCE),
    0,
    1
  );
  return favorerNorm * 0.7 + reviewNorm * 0.3;
}

/**
 * Supply-side weakness from gap classification + incumbent SEO median.
 * open_field / weak_incumbents → high; red_ocean → low; mixed → middle.
 */
export function computeSupplyWeakness(
  classification: CompetitiveClassification,
  medianSeoPercent: number
): number {
  const base = CLASSIFICATION_SUPPLY_BASE[classification];
  const seoWeakness = 1 - clamp(medianSeoPercent, 0, 1);
  return clamp(base * 0.65 + seoWeakness * 0.35, 0, 1);
}

export function classifyWhitespaceQuadrant(
  demandCombined: number,
  supplyWeakness: number
): WhitespaceQuadrant {
  const highDemand = demandCombined >= DEMAND_THRESHOLD;
  const weakSupply = supplyWeakness >= SUPPLY_WEAK_THRESHOLD;
  if (highDemand && weakSupply) return 'WHITE_SPACE';
  if (highDemand && !weakSupply) return 'RED_OCEAN';
  if (!highDemand && weakSupply) return 'DEAD_ZONE';
  return 'MATURE';
}

/**
 * Triangulate white-space score: demand × supply_weakness.
 * Incumbent engagement is weighted heavily in demand_combined so
 * open_field + low favorers → DEAD_ZONE (trap) vs open_field + high favorers → WHITE_SPACE.
 */
export function scoreWhitespace(input: WhitespaceScoreInput): WhitespaceScoreResult {
  const external_demand = clamp(input.external_demand, 0, 1);
  const incumbent_engagement = normalizeIncumbentEngagement(
    input.median_favorers,
    input.median_shop_reviews
  );
  const demand_combined = clamp(
    external_demand * 0.35 + incumbent_engagement * 0.65,
    0,
    1
  );
  const supply_weakness = computeSupplyWeakness(
    input.classification,
    input.median_seo_percent
  );
  const white_space_score = demand_combined * supply_weakness;
  const quadrant = classifyWhitespaceQuadrant(demand_combined, supply_weakness);

  return {
    external_demand,
    incumbent_engagement,
    demand_combined,
    supply_weakness,
    white_space_score,
    quadrant
  };
}
