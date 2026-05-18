import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const SERPAPI_KEY = process.env.SERPAPI_KEY;

if (!SERPAPI_KEY) {
  throw new Error(
    'Missing SERPAPI_KEY. ' +
    'Copy .env.example to .env.local and fill in your SerpApi credentials.'
  );
}

const SEED_KEYWORDS = [
  'printable wall art',
  'digital planner',
  'svg files for cricut',
  'custom invitation template',
  'wedding printable',
  'nursery wall art printable',
  'recipe card printable',
  'budget printable',
  'gratitude journal printable',
  'meal planner printable'
];

const RECENT_WINDOW_DAYS = 7;
const POLITENESS_MS = 1000;

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

interface TrendResult {
  recentAvg: number;
  velocity: number;
}

async function fetchTrend(keyword: string): Promise<TrendResult | null> {
  const params = new URLSearchParams({
    engine: 'google_trends',
    q: keyword,
    data_type: 'TIMESERIES',
    date: 'today 1-m',
    geo: 'US',
    api_key: SERPAPI_KEY as string
  });

  const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

  if (!res.ok) {
    throw new Error(`SerpApi returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as SerpApiResponse;

  if (data.error) {
    throw new Error(`SerpApi error: ${data.error}`);
  }

  const points = data.interest_over_time?.timeline_data;
  if (!points || points.length === 0) return null;

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

  return { recentAvg, velocity };
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await log({
    agent: 'intel',
    action: 'trends.start',
    description: `Google Trends (SerpApi) scan starting: ${SEED_KEYWORDS.length} seed keywords`
  });

  let success = 0;
  let skipped = 0;

  for (const keyword of SEED_KEYWORDS) {
    try {
      const trend = await fetchTrend(keyword);

      if (!trend) {
        skipped++;
        console.log(`  skip "${keyword}": no data returned`);
        continue;
      }

      const rows = [
        {
          source: 'google_trends',
          keyword,
          metric_type: 'interest_score',
          value: trend.recentAvg,
          metadata: { window_days: RECENT_WINDOW_DAYS, geo: 'US', via: 'serpapi' }
        },
        {
          source: 'google_trends',
          keyword,
          metric_type: 'velocity',
          value: trend.velocity,
          metadata: { window_days: 23, geo: 'US', via: 'serpapi' }
        }
      ];

      const { error } = await supabase.from('signals').insert(rows);
      if (error) {
        skipped++;
        console.error(`  fail "${keyword}":`, error.message);
        continue;
      }

      success++;
      console.log(
        `  ok   "${keyword}": interest=${trend.recentAvg.toFixed(1)} ` +
          `velocity=${trend.velocity.toFixed(1)}%`
      );
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  error "${keyword}": ${msg}`);
    } finally {
      await new Promise(r => setTimeout(r, POLITENESS_MS));
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  console.log(`[summary] succeeded=${success} skipped=${skipped} duration=${durationSec}s`);

  try {
    await log({
      agent: 'intel',
      action: 'trends.complete',
      description: `Google Trends scan done: ${success} succeeded, ${skipped} skipped in ${durationSec}s`,
      severity: skipped > success ? 'warning' : 'success',
      metadata: { success, skipped, duration_sec: durationSec }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trends.complete failed to write to activity table]: ${msg}`);
  }
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
