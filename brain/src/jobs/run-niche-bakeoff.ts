import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { mapWithLimit } from '../lib/concurrency.js';
import {
  BAKEOFF_NICHES,
  DIGITAL_PREFERENCE_HURDLE,
  refineProducibilityFromResults,
  type ProducibilityTag
} from '../lib/bakeoff-keywords.js';
import {
  combineExternalDemand,
  googleDemandFromSeedSignals,
  normalizeTrendingVelocity,
  normalizeTrendingVolume
} from '../lib/bakeoff-demand.js';
import { gapScoreKeyword } from '../lib/gap-score-keyword.js';
import { searchEtsy } from '../lib/etsy-search.js';

const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

interface SignalRow {
  source: string;
  keyword: string;
  metric_type: string;
  value: number;
  metadata: Record<string, unknown>;
}

interface BakeoffRow {
  keyword: string;
  niche: string;
  is_anchor_niche: boolean;
  producibility: ProducibilityTag;
  google_demand: number;
  pinterest_demand: number | null;
  external_demand: number;
  incumbent_engagement: number;
  gap_classification: string;
  supply_weakness: number;
  white_space_score: number;
  quadrant: string;
  result_count: number;
  coherence_score: number;
  flags: string[];
}

function parseRunLabel(): string {
  const arg = process.argv.find(a => a.startsWith('--run-label='));
  if (arg) return arg.split('=')[1] ?? '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `bakeoff-baseline-no-pinterest-${ts}`;
}

function parseTreatment(): string {
  const arg = process.argv.find(a => a.startsWith('--treatment='));
  return arg?.split('=')[1] ?? 'baseline';
}

async function fetchGoogleDemandSignals(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from('signals')
    .select('source, keyword, metric_type, value, metadata')
    .gte('collected_at', SEVEN_DAYS_AGO)
    .in('source', ['google_trends', 'google_trends_trending_now']);

  if (error) {
    throw new Error(`Failed to fetch Google signals: ${error.message}`);
  }

  const byKeyword = new Map<
    string,
    { interest: number; velocity: number; tnVolume: number; tnVelocity: number }
  >();

  for (const raw of data ?? []) {
    const s = raw as SignalRow;
    const key = s.keyword.toLowerCase();
    const entry = byKeyword.get(key) ?? {
      interest: 0,
      velocity: 0,
      tnVolume: 0,
      tnVelocity: 0
    };

    if (s.source === 'google_trends') {
      if (s.metric_type === 'interest_score') entry.interest = s.value;
      if (s.metric_type === 'velocity') entry.velocity = s.value;
    }
    if (s.source === 'google_trends_trending_now' && s.metric_type === 'trending_now') {
      entry.tnVolume = Math.max(entry.tnVolume, s.value);
      const vel =
        typeof s.metadata['increase_percentage'] === 'number'
          ? s.metadata['increase_percentage']
          : 0;
      entry.tnVelocity = Math.max(entry.tnVelocity, vel);
    }
    byKeyword.set(key, entry);
  }

  const demand = new Map<string, number>();
  for (const [key, v] of byKeyword) {
    let score = 0;
    if (v.interest > 0 || v.velocity !== 0) {
      score = Math.max(score, googleDemandFromSeedSignals(v.interest, v.velocity));
    }
    if (v.tnVolume > 0) {
      const tn = normalizeTrendingVolume(v.tnVolume) * 0.6 + normalizeTrendingVelocity(v.tnVelocity) * 0.4;
      score = Math.max(score, tn);
    }
    demand.set(key, score);
  }
  return demand;
}

function lookupGoogleDemand(
  keyword: string,
  googleByKeyword: Map<string, number>
): number {
  const exact = googleByKeyword.get(keyword.toLowerCase());
  if (exact != null && exact > 0) return exact;

  // Partial match for seed overlap (e.g. bakeoff keyword ⊆ opportunity name)
  for (const [k, v] of googleByKeyword) {
    if (v <= 0) continue;
    if (k.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(k)) {
      return v * 0.85;
    }
  }
  return 0;
}

function nicheDisplayName(niche: string, isAnchor: boolean): string {
  const base = niche.replace(/_/g, ' ');
  return isAnchor ? `${base} (ANCHOR)` : base;
}

function buildDigitalPreferredRanking(rows: BakeoffRow[]): BakeoffRow[] {
  const digital = rows.filter(r => r.producibility === 'digital');
  const bestDigitalWs =
    digital.length > 0 ? Math.max(...digital.map(r => r.white_space_score)) : 0;

  const eligible = rows.filter(r => {
    if (r.producibility === 'digital') return true;
    return r.white_space_score >= bestDigitalWs + DIGITAL_PREFERENCE_HURDLE;
  });

  return [...eligible].sort((a, b) => {
    if (b.white_space_score !== a.white_space_score) {
      return b.white_space_score - a.white_space_score;
    }
    if (a.producibility === 'digital' && b.producibility !== 'digital') return -1;
    if (b.producibility === 'digital' && a.producibility !== 'digital') return 1;
    return 0;
  });
}

function summarizeByNiche(rows: BakeoffRow[]): Array<{
  niche: string;
  is_anchor: boolean;
  best_keyword: string;
  best_ws: number;
  keyword_count: number;
}> {
  const byNiche = new Map<string, BakeoffRow[]>();
  for (const r of rows) {
    const list = byNiche.get(r.niche) ?? [];
    list.push(r);
    byNiche.set(r.niche, list);
  }

  return [...byNiche.entries()]
    .map(([niche, list]) => {
      const best = [...list].sort((a, b) => b.white_space_score - a.white_space_score)[0];
      return {
        niche,
        is_anchor: best.is_anchor_niche,
        best_keyword: best.keyword,
        best_ws: best.white_space_score,
        keyword_count: list.length
      };
    })
    .sort((a, b) => b.best_ws - a.best_ws);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runLabel = parseRunLabel();
  const treatment = parseTreatment();
  let etsySearchCalls = 0;
  let etsyListingCalls = 0;
  let etsy429s = 0;

  await log({
    agent: 'intel',
    action: 'bakeoff.start',
    description: `Niche bake-off starting: ${runLabel} (${BAKEOFF_NICHES.length} keywords)`,
    metadata: { run_label: runLabel, treatment, keyword_count: BAKEOFF_NICHES.length }
  });

  console.log(`\n=== Niche bake-off: ${runLabel} ===`);
  console.log(`Treatment: ${treatment} | Pinterest demand slot: null (baseline)\n`);

  const googleByKeyword = await fetchGoogleDemandSignals();

  const { data: runRow, error: runErr } = await supabase
    .from('niche_bakeoff_runs')
    .insert({
      run_label: runLabel,
      treatment,
      pinterest_enabled: false,
      keyword_count: BAKEOFF_NICHES.length,
      metadata: {
        digital_hurdle: DIGITAL_PREFERENCE_HURDLE,
        sources: ['google', 'etsy_incumbent_engagement'],
        pinterest_slot: null
      }
    })
    .select('id')
    .single();

  if (runErr || !runRow) {
    throw new Error(`Failed to create bakeoff run: ${runErr?.message}`);
  }
  const runId = runRow.id as string;

  const searchResults = await mapWithLimit(BAKEOFF_NICHES, 2, 200, async spec => {
    etsySearchCalls++;
    return searchEtsy(spec.keyword, { limit: 25 });
  });

  const scored: BakeoffRow[] = [];

  for (let i = 0; i < BAKEOFF_NICHES.length; i++) {
    const spec = BAKEOFF_NICHES[i];
    const results = searchResults[i] ?? [];

    const google_demand = lookupGoogleDemand(spec.keyword, googleByKeyword);
    const pinterest_demand: number | null = null;
    const external_demand = combineExternalDemand({
      google_demand,
      pinterest_demand
    });

    const gap = await gapScoreKeyword(spec.keyword, external_demand, results);
    etsyListingCalls += gap.stats.unique_listings_fetched;
    etsy429s += gap.stats.failed_fetches;

    const producibility = refineProducibilityFromResults(
      spec.producibility,
      results.map(r => r.title)
    );

    const flags = [...gap.coherence.flags];
    const row: BakeoffRow = {
      keyword: spec.keyword,
      niche: spec.niche,
      is_anchor_niche: spec.is_anchor_niche,
      producibility,
      google_demand,
      pinterest_demand,
      external_demand,
      incumbent_engagement: gap.whitespace.incumbent_engagement,
      gap_classification: gap.landscape_entry.classification,
      supply_weakness: gap.whitespace.supply_weakness,
      white_space_score: gap.whitespace.white_space_score,
      quadrant: gap.whitespace.quadrant,
      result_count: gap.coherence.result_count,
      coherence_score: gap.coherence.coherence_score,
      flags
    };
    scored.push(row);

    const gapAnalysis = {
      search_keyword: spec.keyword,
      scored_at: new Date().toISOString(),
      google_demand,
      pinterest_demand,
      external_demand,
      demand_combined: gap.whitespace.demand_combined,
      top_incumbents: gap.landscape_entry.top_incumbents,
      gap_summary: gap.landscape_entry.gap_summary,
      median_favorers: gap.landscape_entry.median_favorers,
      coherence_score: gap.coherence.coherence_score
    };

    const { error: insErr } = await supabase.from('niche_bakeoff_results').insert({
      run_id: runId,
      keyword: spec.keyword,
      niche: spec.niche,
      is_anchor_niche: spec.is_anchor_niche,
      producibility,
      google_demand,
      pinterest_demand,
      external_demand,
      incumbent_engagement: gap.whitespace.incumbent_engagement,
      demand_combined: gap.whitespace.demand_combined,
      gap_classification: gap.landscape_entry.classification,
      incumbent_seo_median: gap.landscape_entry.median_percent,
      supply_weakness: gap.whitespace.supply_weakness,
      white_space_score: gap.whitespace.white_space_score,
      quadrant: gap.whitespace.quadrant,
      result_count: gap.coherence.result_count,
      coherence_score: gap.coherence.coherence_score,
      flags,
      gap_analysis: gapAnalysis
    });

    if (insErr) {
      console.error(`  fail persist "${spec.keyword}":`, insErr.message);
    } else {
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
      console.log(
        `  ok   ${spec.keyword.slice(0, 42).padEnd(42)} ws=${row.white_space_score.toFixed(3)} ` +
          `${row.quadrant}${flagStr}`
      );
    }
  }

  const rawRanking = [...scored].sort(
    (a, b) => b.white_space_score - a.white_space_score
  );
  const byNiche = summarizeByNiche(scored);
  const digitalPreferred = buildDigitalPreferredRanking(scored);

  const quadrantCounts = scored.reduce(
    (acc, r) => {
      acc[r.quadrant] = (acc[r.quadrant] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log('\n--- 1. RAW ranking (neutral white_space_score) ---');
  console.log(
    'keyword | niche | producibility | ext_demand | inc_engagement | class | WS | quadrant | flags'
  );
  for (const r of rawRanking) {
    console.log(
      `${r.keyword.slice(0, 32).padEnd(32)} | ${r.niche.slice(0, 18).padEnd(18)} | ` +
        `${r.producibility.padEnd(12)} | ${r.external_demand.toFixed(3)} | ` +
        `${r.incumbent_engagement.toFixed(3)} | ${r.gap_classification.padEnd(16)} | ` +
        `${r.white_space_score.toFixed(3)} | ${r.quadrant} | ${r.flags.join(';')}`
    );
  }

  console.log('\n--- 2. BY-NICHE summary (best WS per niche) ---');
  for (const n of byNiche) {
    console.log(
      `${nicheDisplayName(n.niche, n.is_anchor).padEnd(28)} best=${n.best_ws.toFixed(3)} ` +
        `("${n.best_keyword}") [${n.keyword_count} keywords]`
    );
  }

  console.log(
    `\n--- 3. DIGITAL-PREFERRED view (hurdle=+${DIGITAL_PREFERENCE_HURDLE} vs best digital) ---`
  );
  const bestDigital = Math.max(
    ...scored.filter(r => r.producibility === 'digital').map(r => r.white_space_score),
    0
  );
  console.log(`Best digital WS: ${bestDigital.toFixed(3)} — physical/dropship need ≥ ${(bestDigital + DIGITAL_PREFERENCE_HURDLE).toFixed(3)}`);
  for (const r of digitalPreferred.slice(0, 15)) {
    console.log(
      `  ${r.white_space_score.toFixed(3)} ${r.producibility.padEnd(12)} ${r.keyword} (${r.niche})`
    );
  }

  console.log('\n--- Quadrant distribution ---');
  for (const [q, n] of Object.entries(quadrantCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${q}: ${n}`);
  }

  const flagged = scored.filter(r => r.flags.length > 0);
  if (flagged.length) {
    console.log('\n--- Coherence / representativeness flags ---');
    for (const r of flagged) {
      console.log(`  ${r.keyword}: ${r.flags.join(', ')} (coherence=${r.coherence_score.toFixed(2)})`);
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\n[summary] run=${runLabel} keywords=${scored.length} ` +
      `etsy_search=${etsySearchCalls} etsy_listing≈${etsyListingCalls} 429_fails≈${etsy429s} ` +
      `duration=${durationSec}s | BASELINE — no Pinterest`
  );

  await log({
    agent: 'intel',
    action: 'bakeoff.complete',
    description: `Niche bake-off done: ${runLabel} in ${durationSec}s`,
    severity: 'success',
    metadata: {
      run_label: runLabel,
      run_id: runId,
      treatment,
      top_raw: rawRanking.slice(0, 5).map(r => ({
        keyword: r.keyword,
        ws: r.white_space_score,
        niche: r.niche
      })),
      top_niche: byNiche.slice(0, 3),
      duration_sec: durationSec,
      etsy_search_calls: etsySearchCalls,
      etsy_listing_calls: etsyListingCalls
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
