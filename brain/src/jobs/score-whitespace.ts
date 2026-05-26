import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { searchEtsy } from '../lib/etsy-search.js';
import { mapWithLimit } from '../lib/concurrency.js';
import { computeCompetitiveLandscape } from '../agents/research/competitive.js';
import { scoreWhitespace } from '../lib/whitespace-scoring.js';
import type { EtsySearchResult } from '../agents/research/types.js';

const TOP_N = 10;
const SEARCH_LIMIT = 25;
const DEFAULT_DEMAND_CAP = 40;

function parseLimitArg(): number {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  if (!arg) return DEFAULT_DEMAND_CAP;
  const n = parseInt(arg.split('=')[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEMAND_CAP;
}

interface OpportunityRow {
  id: string;
  name: string;
  confidence_score: number | null;
  demand_combined: number | null;
  niche: string | null;
  metadata: Record<string, unknown>;
}

function resolveSearchKeyword(opp: OpportunityRow): string {
  const source =
    typeof opp.metadata['source'] === 'string' ? opp.metadata['source'] : '';
  if (source === 'google_trends' || source === 'google_trends_trending_now') {
    return opp.name;
  }
  if (typeof opp.metadata['title'] === 'string' && opp.metadata['title'].length > 0) {
    return opp.metadata['title'].slice(0, 100);
  }
  const stripped = opp.name.replace(/^Reddit buyer:\s*/i, '').replace(/\s*\([^)]+\)$/, '');
  return stripped.slice(0, 100) || opp.name;
}

async function fetchCandidateOpportunities(): Promise<OpportunityRow[]> {
  const { data, error } = await supabase
    .from('opportunities')
    .select('id, name, confidence_score, demand_combined, niche, metadata')
    .order('confidence_score', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch opportunities: ${error.message}`);
  }

  const rows = (data ?? []) as OpportunityRow[];

  const { data: listingRows } = await supabase
    .from('listings')
    .select('opportunity_id')
    .not('opportunity_id', 'is', null);

  const withListing = new Set(
    (listingRows ?? [])
      .map(r => r.opportunity_id as string)
      .filter(Boolean)
  );

  const { data: briefRows } = await supabase
    .from('product_briefs')
    .select('decision_id, decisions_needed!inner(context)');

  const withBrief = new Set<string>();
  for (const row of briefRows ?? []) {
    const ctx = (row as { decisions_needed?: { context?: Record<string, unknown> } })
      .decisions_needed?.context;
    const oppId = typeof ctx?.['opportunity_id'] === 'string' ? ctx['opportunity_id'] : null;
    if (oppId) withBrief.add(oppId);
  }

  return rows.filter(o => !withListing.has(o.id) && !withBrief.has(o.id));
}

export interface WhitespaceRunResult {
  keyword: string;
  search_keyword: string;
  niche: string;
  external_demand: number;
  incumbent_engagement: number;
  gap_classification: string;
  supply_weakness: number;
  white_space_score: number;
  quadrant: string;
  median_favorers: number;
  median_seo_percent: number;
}

function demandRankScore(opp: OpportunityRow): number {
  if (opp.demand_combined != null && opp.demand_combined > 0) {
    return Number(opp.demand_combined);
  }
  return Number(opp.confidence_score ?? 0);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let etsySearchCalls = 0;
  let etsyListingCalls = 0;
  let etsyShopCalls = 0;

  await log({
    agent: 'intel',
    action: 'whitespace.start',
    description: 'White-space triangulation scoring starting'
  });

  const demandCap = parseLimitArg();
  const allCandidates = await fetchCandidateOpportunities();
  if (allCandidates.length === 0) {
    console.log('[summary] no candidate opportunities (all have listing or brief)');
    return;
  }

  const candidates = [...allCandidates]
    .sort((a, b) => demandRankScore(b) - demandRankScore(a))
    .slice(0, demandCap);

  console.log(
    `Scoring ${candidates.length} of ${allCandidates.length} candidate opportunities ` +
      `(top ${demandCap} by demand)…`
  );

  const keywordByOppId = new Map<string, string>();
  const searchKeywords: string[] = [];
  for (const opp of candidates) {
    const kw = resolveSearchKeyword(opp);
    keywordByOppId.set(opp.id, kw);
    searchKeywords.push(kw);
  }

  const searchArrays = await mapWithLimit(searchKeywords, 2, 200, k => {
    etsySearchCalls++;
    return searchEtsy(k, { limit: SEARCH_LIMIT });
  });

  const resultsByKeyword = new Map<string, EtsySearchResult[]>();
  searchKeywords.forEach((k, i) => resultsByKeyword.set(k, searchArrays[i] ?? []));

  const competitive = await computeCompetitiveLandscape({
    keywords: searchKeywords,
    resultsByKeyword,
    topN: TOP_N
  });

  etsyListingCalls = competitive.stats.unique_listings_fetched;

  const results: WhitespaceRunResult[] = [];

  for (const opp of candidates) {
    const searchKeyword = keywordByOppId.get(opp.id)!;
    const entry =
      competitive.landscape.find(l => l.keyword === searchKeyword) ??
      competitive.landscape[0];

    if (!entry || entry.keyword !== searchKeyword) {
      console.error(`  fail "${opp.name}": no landscape entry for "${searchKeyword}"`);
      continue;
    }

    const externalDemand = Number(opp.confidence_score ?? 0);
    const ws = scoreWhitespace({
      external_demand: externalDemand,
      median_favorers: entry.median_favorers,
      median_shop_reviews: entry.median_shop_reviews,
      classification: entry.classification,
      median_seo_percent: entry.median_percent
    });

    const gapAnalysis = {
      search_keyword: searchKeyword,
      scored_at: new Date().toISOString(),
      scored_count: entry.scored_count,
      gap_summary: entry.gap_summary,
      median_favorers: entry.median_favorers,
      median_views: entry.median_views,
      median_shop_reviews: entry.median_shop_reviews,
      top_incumbents: entry.top_incumbents,
      external_demand: ws.external_demand,
      incumbent_engagement: ws.incumbent_engagement,
      demand_combined: ws.demand_combined,
      supply_weakness: ws.supply_weakness,
      white_space_score: ws.white_space_score,
      quadrant: ws.quadrant
    };

    const { error } = await supabase
      .from('opportunities')
      .update({
        gap_classification: entry.classification,
        incumbent_seo_median: entry.median_percent,
        incumbent_engagement: ws.incumbent_engagement,
        supply_weakness: ws.supply_weakness,
        demand_combined: ws.demand_combined,
        white_space_score: ws.white_space_score,
        quadrant: ws.quadrant,
        gap_analysis: gapAnalysis,
        updated_at: new Date().toISOString()
      })
      .eq('id', opp.id);

    if (error) {
      console.error(`  fail persist "${opp.name}":`, error.message);
      continue;
    }

    results.push({
      keyword: opp.name,
      search_keyword: searchKeyword,
      niche: opp.niche ?? 'general',
      external_demand: ws.external_demand,
      incumbent_engagement: ws.incumbent_engagement,
      gap_classification: entry.classification,
      supply_weakness: ws.supply_weakness,
      white_space_score: ws.white_space_score,
      quadrant: ws.quadrant,
      median_favorers: entry.median_favorers,
      median_seo_percent: entry.median_percent
    });

    console.log(
      `  ok   "${searchKeyword}": quadrant=${ws.quadrant} ` +
        `ws=${ws.white_space_score.toFixed(3)} ` +
        `demand=${ws.demand_combined.toFixed(3)} supply_weak=${ws.supply_weakness.toFixed(3)} ` +
        `class=${entry.classification} med_fav=${entry.median_favorers.toFixed(0)}`
    );
  }

  results.sort((a, b) => b.white_space_score - a.white_space_score);

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  console.log('\n--- White-space scoreboard (sorted by white_space_score desc) ---');
  console.log(
    'keyword | niche | ext_demand | inc_engagement | classification | supply_weak | ws_score | quadrant'
  );
  for (const r of results) {
    console.log(
      `${r.search_keyword.slice(0, 36).padEnd(36)} | ` +
        `${(r.niche ?? '').slice(0, 14).padEnd(14)} | ` +
        `${r.external_demand.toFixed(3)} | ${r.incumbent_engagement.toFixed(3)} | ` +
        `${r.gap_classification.padEnd(16)} | ${r.supply_weakness.toFixed(3)} | ` +
        `${r.white_space_score.toFixed(3)} | ${r.quadrant}`
    );
  }

  const quadrantCounts = results.reduce(
    (acc, r) => {
      acc[r.quadrant] = (acc[r.quadrant] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  console.log('\n--- Quadrant distribution ---');
  for (const [q, n] of Object.entries(quadrantCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${q}: ${n}`);
  }

  console.log(
    `\n[summary] scored=${results.length} etsy_search=${etsySearchCalls} ` +
      `etsy_listing≈${etsyListingCalls} duration=${durationSec}s`
  );

  await log({
    agent: 'intel',
    action: 'whitespace.complete',
    description: `White-space scoring done: ${results.length} candidates in ${durationSec}s`,
    severity: results.length === 0 ? 'warning' : 'success',
    metadata: {
      scored: results.length,
      candidate_pool: allCandidates.length,
      demand_cap: demandCap,
      etsy_search_calls: etsySearchCalls,
      etsy_listing_calls: etsyListingCalls,
      duration_sec: durationSec,
      top_quadrants: results.slice(0, 5).map(r => ({
        keyword: r.search_keyword,
        quadrant: r.quadrant,
        white_space_score: r.white_space_score
      }))
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
