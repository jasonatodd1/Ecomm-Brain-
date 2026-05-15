import googleTrends from 'google-trends-api';
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

// Seed keywords for digital printables niche. The intel agent will
// expand and prune this list dynamically as it learns what's converting
// in your store. For now these are reasonable starting points across
// the most common Etsy printable subcategories.
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

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 7;
const POLITENESS_MS = 2000;

interface InterestResult {
  recentAvg: number;
  velocity: number;
}

// Google occasionally returns HTML bot-detection pages instead of JSON
// when traffic is heavy or the IP looks like a data center. Parse safely.
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectInterest(keyword: string): Promise<InterestResult | null> {
  const raw = await googleTrends.interestOverTime({
    keyword,
    startTime: new Date(Date.now() - PERIOD_MS),
    geo: 'US'
  });

  const data = safeParse(raw) as
    | { default?: { timelineData?: Array<{ value?: number[] }> } }
    | null;

  const points = data?.default?.timelineData;
  if (!points || points.length === 0) return null;

  const values = points.map(p => p.value?.[0] ?? 0);
  const recent = values.slice(-RECENT_WINDOW_DAYS);
  const earlier = values.slice(0, -RECENT_WINDOW_DAYS);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg =
    earlier.length > 0
      ? earlier.reduce((a, b) => a + b, 0) / earlier.length
      : recentAvg;

  const velocity = earlierAvg > 0 ? (recentAvg - earlierAvg) / earlierAvg : 0;

  return { recentAvg, velocity };
}

async function collectRelated(keyword: string): Promise<string[]> {
  try {
    const raw = await googleTrends.relatedQueries({
      keyword,
      startTime: new Date(Date.now() - PERIOD_MS),
      geo: 'US'
    });

    const data = safeParse(raw) as
      | {
          default?: {
            rankedList?: Array<{
              rankedKeyword?: Array<{ query: string; value: number }>;
            }>;
          };
        }
      | null;

    // rankedList[1] is the "rising" queries — the leading indicators
    const rising = data?.default?.rankedList?.[1]?.rankedKeyword ?? [];
    return rising.slice(0, 5).map(r => r.query);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await log({
    agent: 'intel',
    action: 'gtrends.start',
    description: `Google Trends scan starting: ${SEED_KEYWORDS.length} seed keywords`
  });

  let success = 0;
  let skipped = 0;

  for (const keyword of SEED_KEYWORDS) {
    try {
      const trend = await collectInterest(keyword);
      if (!trend) {
        skipped++;
        console.log(`  skip "${keyword}": no data returned`);
        continue;
      }

      const related = await collectRelated(keyword);

      const rows = [
        {
          source: 'google_trends',
          keyword,
          metric_type: 'interest_score',
          value: trend.recentAvg,
          metadata: { window_days: RECENT_WINDOW_DAYS, geo: 'US' }
        },
        {
          source: 'google_trends',
          keyword,
          metric_type: 'velocity',
          value: trend.velocity,
          metadata: { window_days: 30, geo: 'US' }
        }
      ];

      if (related.length > 0) {
        rows.push({
          source: 'google_trends',
          keyword,
          metric_type: 'rising_related_count',
          value: related.length,
          metadata: { related_queries: related, geo: 'US' } as unknown as {
            window_days: number;
            geo: string;
          }
        });
      }

      const { error } = await supabase.from('signals').insert(rows);
      if (error) {
        skipped++;
        console.error(`  fail "${keyword}":`, error.message);
        continue;
      }

      success++;
      console.log(
        `  ok   "${keyword}": interest=${trend.recentAvg.toFixed(1)} ` +
          `velocity=${(trend.velocity * 100).toFixed(1)}% related=${related.length}`
      );

      // Be polite to Google's unofficial endpoint
      await new Promise(r => setTimeout(r, POLITENESS_MS));
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  error "${keyword}": ${msg}`);
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  await log({
    agent: 'intel',
    action: 'gtrends.complete',
    description: `Google Trends scan done: ${success} succeeded, ${skipped} skipped in ${durationSec}s`,
    severity: skipped > success ? 'warning' : 'success',
    metadata: { success, skipped, duration_sec: durationSec }
  });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
