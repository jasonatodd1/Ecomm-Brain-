/**
 * Composable demand inputs for niche bake-off (baseline vs Pinterest treatment).
 * Scoring math lives in whitespace-scoring.ts — this module only assembles external demand.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface BakeoffDemandInputs {
  /** Google product-term demand (Trends seeds / Trending Now), 0–1. */
  google_demand: number;
  /**
   * Pinterest demand proxy — BASELINE: null (unused).
   * TREATMENT: populate from Pinterest collector; blend below.
   */
  pinterest_demand: number | null;
}

/** Log-scaled volume normalization (Trending Now absolute search_volume). */
export function normalizeTrendingVolume(searchVolume: number): number {
  const ref = 100_000;
  return clamp(Math.log1p(Math.max(0, searchVolume)) / Math.log1p(ref), 0, 1);
}

/** Velocity from Google Trends increase_percentage or seed velocity. */
export function normalizeTrendingVelocity(increasePct: number): number {
  return clamp(increasePct / 500, 0, 1);
}

/** Seed-keyword demand from interest_score (0–100) + velocity (%). */
export function googleDemandFromSeedSignals(
  interestScore: number,
  velocityPct: number
): number {
  const velocityCapped = clamp(velocityPct, -100, 100);
  return clamp(interestScore / 100 + velocityCapped / 200, 0, 1);
}

/**
 * Combine composable demand sources into external_demand for whitespace scoring.
 *
 * BASELINE (pinterest_demand = null): external = google_demand
 * TREATMENT (future): external = 0.45×google + 0.55×pinterest — tune when Pinterest ships
 */
export function combineExternalDemand(inputs: BakeoffDemandInputs): number {
  const google = clamp(inputs.google_demand, 0, 1);
  if (inputs.pinterest_demand == null) {
    return google;
  }
  const pinterest = clamp(inputs.pinterest_demand, 0, 1);
  return clamp(google * 0.45 + pinterest * 0.55, 0, 1);
}
