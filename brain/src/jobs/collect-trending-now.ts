import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import {
  TRENDING_NOW_CATEGORIES,
  verifyTrendingNowCategories,
  nicheFromCategories
} from '../lib/trending-now-categories.js';
import { classifyTrendRelevance } from '../lib/classify-trend-relevance.js';

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const GEO = 'US';
const HOURS = 168;
const POLITENESS_MS = 1000;
const HAIKU_STAGGER_MS = 200;
const ESTIMATED_HAIKU_COST_USD = 0.001;
/** Default cap on Haiku classifications per run (top by volume×velocity). Override via --classify-limit=N */
const DEFAULT_CLASSIFY_LIMIT = 600;

function parseClassifyLimit(): number {
  const arg = process.argv.find(a => a.startsWith('--classify-limit='));
  if (!arg) return DEFAULT_CLASSIFY_LIMIT;
  const n = parseInt(arg.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLASSIFY_LIMIT;
}

function trendPriority(t: DedupedTrend): number {
  return t.search_volume * (1 + Math.max(0, t.increase_percentage) / 100);
}

if (!SERPAPI_KEY) {
  throw new Error(
    'Missing SERPAPI_KEY. Copy .env.example to .env.local and fill in SerpApi credentials.'
  );
}

interface SerpTrendCategory {
  id: number;
  name: string;
}

interface SerpTrendingSearch {
  query: string;
  search_volume?: number;
  increase_percentage?: number;
  categories?: SerpTrendCategory[];
  trend_breakdown?: string[];
  active?: boolean;
  start_timestamp?: number;
  end_timestamp?: number;
}

interface SerpTrendingNowResponse {
  error?: string;
  trending_searches?: SerpTrendingSearch[];
}

interface DedupedTrend {
  query: string;
  search_volume: number;
  increase_percentage: number;
  categories: SerpTrendCategory[];
  trend_breakdown: string[];
  active: boolean;
  seen_in_category_ids: number[];
}

export interface DropLogEntry {
  query: string;
  verdict: 'drop';
  drop_reason: string;
  classification: string;
  reasoning: string;
  categories: string[];
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

async function fetchCategoryTrends(categoryId: number): Promise<SerpTrendingSearch[]> {
  const params = new URLSearchParams({
    engine: 'google_trends_trending_now',
    geo: GEO,
    hours: String(HOURS),
    category_id: String(categoryId),
    api_key: SERPAPI_KEY as string
  });

  const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`SerpApi HTTP ${res.status} for category ${categoryId}`);
  }

  const data = (await res.json()) as SerpTrendingNowResponse;
  if (data.error) {
    throw new Error(`SerpApi error (cat ${categoryId}): ${data.error}`);
  }

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: `SerpApi Trending Now cat=${categoryId} hours=${HOURS}`,
    metadata: {
      provider: 'serpapi',
      engine: 'google_trends_trending_now',
      category_id: categoryId,
      estimated_cost_usd: 1
    }
  });

  return data.trending_searches ?? [];
}

function dedupeTrends(
  byCategory: Map<number, SerpTrendingSearch[]>
): DedupedTrend[] {
  const map = new Map<string, DedupedTrend>();

  for (const [categoryId, trends] of byCategory) {
    for (const t of trends) {
      const query = typeof t.query === 'string' ? t.query.trim() : '';
      if (!query) continue;

      const key = normalizeQuery(query);
      const existing = map.get(key);
      const cats = Array.isArray(t.categories) ? t.categories : [];

      if (existing) {
        for (const c of cats) {
          if (!existing.categories.some(x => x.id === c.id)) {
            existing.categories.push(c);
          }
        }
        if (!existing.seen_in_category_ids.includes(categoryId)) {
          existing.seen_in_category_ids.push(categoryId);
        }
        existing.search_volume = Math.max(
          existing.search_volume,
          typeof t.search_volume === 'number' ? t.search_volume : 0
        );
        existing.increase_percentage = Math.max(
          existing.increase_percentage,
          typeof t.increase_percentage === 'number' ? t.increase_percentage : 0
        );
        if (Array.isArray(t.trend_breakdown)) {
          for (const b of t.trend_breakdown) {
            if (!existing.trend_breakdown.includes(b)) {
              existing.trend_breakdown.push(b);
            }
          }
        }
      } else {
        map.set(key, {
          query,
          search_volume: typeof t.search_volume === 'number' ? t.search_volume : 0,
          increase_percentage:
            typeof t.increase_percentage === 'number' ? t.increase_percentage : 0,
          categories: [...cats],
          trend_breakdown: Array.isArray(t.trend_breakdown)
            ? [...t.trend_breakdown]
            : [],
          active: t.active === true,
          seen_in_category_ids: [categoryId]
        });
      }
    }
  }

  return [...map.values()];
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await verifyTrendingNowCategories();
  console.log(
    `Verified ${TRENDING_NOW_CATEGORIES.length} category IDs against SerpApi official list`
  );

  await log({
    agent: 'intel',
    action: 'trending_now.start',
    description: `Trending Now broad collect starting: ${TRENDING_NOW_CATEGORIES.length} categories, hours=${HOURS}, geo=${GEO}`
  });

  const byCategory = new Map<number, SerpTrendingSearch[]>();
  let serpApiCalls = 0;
  let serpErrors = 0;

  for (const cat of TRENDING_NOW_CATEGORIES) {
    try {
      const trends = await fetchCategoryTrends(cat.id);
      byCategory.set(cat.id, trends);
      serpApiCalls++;
      console.log(
        `  cat ${String(cat.id).padStart(2)} ${cat.name}: ${trends.length} trends`
      );
    } catch (err) {
      serpErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  fail cat ${cat.id} (${cat.name}): ${msg}`);
    } finally {
      await new Promise(r => setTimeout(r, POLITENESS_MS));
    }
  }

  const deduped = dedupeTrends(byCategory);
  const classifyLimit = parseClassifyLimit();
  const toClassify = [...deduped]
    .sort((a, b) => trendPriority(b) - trendPriority(a))
    .slice(0, classifyLimit);

  console.log(
    `\nDeduped ${deduped.length} unique queries from ${serpApiCalls} category pulls; ` +
      `classifying top ${toClassify.length} by volume×velocity (limit=${classifyLimit})`
  );

  let kept = 0;
  let dropped = 0;
  let haikuCalls = 0;
  const dropLog: DropLogEntry[] = [];

  for (let i = 0; i < toClassify.length; i++) {
    const trend = toClassify[i];
    haikuCalls++;

    if (i > 0 && HAIKU_STAGGER_MS > 0) {
      await new Promise(r => setTimeout(r, HAIKU_STAGGER_MS));
    }

    const result = await classifyTrendRelevance({
      query: trend.query,
      categories: trend.categories,
      search_volume: trend.search_volume,
      increase_percentage: trend.increase_percentage,
      trend_breakdown: trend.trend_breakdown
    });

    const categoryNames = trend.categories.map(c => c.name);

    await log({
      agent: 'intel',
      action: 'trending_now.classified',
      description: `${result.verdict.toUpperCase()} "${trend.query}" — ${result.classification}`,
      metadata: {
        query: trend.query,
        verdict: result.verdict,
        drop_reason: result.drop_reason,
        classification: result.classification,
        reasoning: result.reasoning,
        categories: categoryNames,
        search_volume: trend.search_volume,
        increase_percentage: trend.increase_percentage
      }
    });

    if (result.verdict === 'drop') {
      dropped++;
      dropLog.push({
        query: trend.query,
        verdict: 'drop',
        drop_reason: result.drop_reason,
        classification: result.classification,
        reasoning: result.reasoning,
        categories: categoryNames
      });
      if (dropped <= 20 || result.drop_reason === 'ip') {
        console.log(
          `  drop [${i + 1}/${toClassify.length}] "${trend.query.slice(0, 50)}" ` +
            `[${result.drop_reason}] — ${result.reasoning}`
        );
      }
      continue;
    }

    const niche = nicheFromCategories(trend.categories);
    const { error } = await supabase.from('signals').insert({
      source: 'google_trends_trending_now',
      keyword: trend.query,
      metric_type: 'trending_now',
      value: trend.search_volume,
      metadata: {
        via: 'serpapi',
        geo: GEO,
        hours: HOURS,
        increase_percentage: trend.increase_percentage,
        velocity: trend.increase_percentage,
        categories: trend.categories,
        seen_in_category_ids: trend.seen_in_category_ids,
        trend_breakdown: trend.trend_breakdown.slice(0, 10),
        active: trend.active,
        niche,
        gate: {
          verdict: result.verdict,
          classification: result.classification,
          reasoning: result.reasoning
        }
      }
    });

    if (error) {
      console.error(`  fail insert "${trend.query}":`, error.message);
      continue;
    }

    kept++;
    console.log(
      `  keep [${i + 1}/${toClassify.length}] "${trend.query.slice(0, 50)}" ` +
        `vol=${trend.search_volume} +${trend.increase_percentage}% [${niche}]`
    );
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const haikuCost = haikuCalls * ESTIMATED_HAIKU_COST_USD;

  console.log('\n--- Drop examples (first 6) ---');
  for (const d of dropLog.slice(0, 6)) {
    console.log(
      `  DROP [${d.drop_reason}] "${d.query}" — ${d.classification}: ${d.reasoning}`
    );
  }

  const ipExample = dropLog.find(d => d.drop_reason === 'ip');
  if (ipExample) {
    console.log(`\n--- IP block example ---`);
    console.log(
      `  DROP [ip] "${ipExample.query}" — ${ipExample.reasoning}`
    );
  }

  console.log(
    `\n[summary] raw=${deduped.length} classified=${toClassify.length} kept=${kept} dropped=${dropped} ` +
      `serpapi=${serpApiCalls} haiku≈$${haikuCost.toFixed(2)} duration=${durationSec}s`
  );

  await log({
    agent: 'intel',
    action: 'trending_now.complete',
    description: `Trending Now collect done: ${kept} kept / ${toClassify.length} classified (${deduped.length} deduped) in ${durationSec}s`,
    severity: kept === 0 ? 'warning' : 'success',
    metadata: {
      categories_polled: serpApiCalls,
      serp_errors: serpErrors,
      deduped: deduped.length,
      classified: toClassify.length,
      classify_limit: classifyLimit,
      kept,
      dropped,
      haiku_calls: haikuCalls,
      estimated_haiku_cost_usd: haikuCost,
      duration_sec: durationSec,
      drop_samples: dropLog.slice(0, 10)
    }
  });
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
