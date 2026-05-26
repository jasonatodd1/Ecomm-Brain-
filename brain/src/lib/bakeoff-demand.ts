/**
 * Composable demand inputs for niche bake-off (baseline vs Pinterest treatment).
 * Scoring math lives in whitespace-scoring.ts — this module only assembles external demand.
 *
 * Google leg: actively fetches SerpApi Google Trends per keyword (same window as collect-trends.ts).
 * Does NOT read or write the main signals table.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const RECENT_WINDOW_DAYS = 7;
const DEFAULT_POLITENESS_MS = 1000;

interface TimelinePoint {
  date: string;
  values: Array<{ query: string; value: number; extracted_value: number }>;
}

interface InterestOverTime {
  timeline_data: TimelinePoint[];
}

interface SerpApiResponse {
  error?: string;
  interest_over_time?: InterestOverTime;
}

export interface GoogleTrendMeasurement {
  keyword: string;
  /** 7-day recent average interest (0–100 scale from Trends). null if no data. */
  interest_score: number | null;
  /** Percent change recent vs earlier window. null if no data. */
  velocity_pct: number | null;
  /** Normalized external demand from interest + velocity. Real 0 when Trends returns flat/low. */
  google_demand: number;
  /** False when SerpApi returned no timeline (distinct from google_demand=0). */
  has_data: boolean;
  error?: string;
}

export interface BakeoffDemandInputs {
  /** Google product-term demand from fresh Trends pull, 0–1. */
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

/** Seed-keyword demand from interest_score (0–100) + velocity (%). Same formula as collect-trends → score-opportunities. */
export function googleDemandFromSeedSignals(
  interestScore: number,
  velocityPct: number
): number {
  const velocityCapped = clamp(velocityPct, -100, 100);
  return clamp(interestScore / 100 + velocityCapped / 200, 0, 1);
}

/**
 * Fetch Google Trends TIMESERIES for one keyword via SerpApi.
 * Same params as collect-trends.ts: engine=google_trends, data_type=TIMESERIES, date=today 1-m, geo=US.
 */
export async function fetchGoogleTrendDemand(keyword: string): Promise<GoogleTrendMeasurement> {
  if (!SERPAPI_KEY) {
    throw new Error(
      'Missing SERPAPI_KEY. Copy .env.example to .env.local and fill in your SerpApi credentials.'
    );
  }

  const params = new URLSearchParams({
    engine: 'google_trends',
    q: keyword,
    data_type: 'TIMESERIES',
    date: 'today 1-m',
    geo: 'US',
    api_key: SERPAPI_KEY
  });

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!res.ok) {
      return {
        keyword,
        interest_score: null,
        velocity_pct: null,
        google_demand: 0,
        has_data: false,
        error: `HTTP ${res.status}`
      };
    }

    const data = (await res.json()) as SerpApiResponse;
    if (data.error) {
      return {
        keyword,
        interest_score: null,
        velocity_pct: null,
        google_demand: 0,
        has_data: false,
        error: data.error
      };
    }

    const points = data.interest_over_time?.timeline_data;
    if (!points || points.length === 0) {
      return {
        keyword,
        interest_score: null,
        velocity_pct: null,
        google_demand: 0,
        has_data: false
      };
    }

    const values = points.map(p => p.values[0]?.extracted_value ?? 0);
    const recent = values.slice(-RECENT_WINDOW_DAYS);
    const earlier = values.slice(0, -RECENT_WINDOW_DAYS);

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const earlierAvg =
      earlier.length > 0
        ? earlier.reduce((a, b) => a + b, 0) / earlier.length
        : recentAvg;

    const velocity =
      earlierAvg > 0 ? ((recentAvg - earlierAvg) / earlierAvg) * 100 : 0;

    return {
      keyword,
      interest_score: recentAvg,
      velocity_pct: velocity,
      google_demand: googleDemandFromSeedSignals(recentAvg, velocity),
      has_data: true
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      keyword,
      interest_score: null,
      velocity_pct: null,
      google_demand: 0,
      has_data: false,
      error: msg
    };
  }
}

/** Fetch Trends demand for all bake-off keywords sequentially with politeness delay. */
export async function fetchGoogleTrendDemandBatch(
  keywords: string[],
  politenessMs = DEFAULT_POLITENESS_MS
): Promise<Map<string, GoogleTrendMeasurement>> {
  const out = new Map<string, GoogleTrendMeasurement>();

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i];
    const measurement = await fetchGoogleTrendDemand(keyword);
    out.set(keyword, measurement);

    if (i < keywords.length - 1) {
      await new Promise(r => setTimeout(r, politenessMs));
    }
  }

  return out;
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
