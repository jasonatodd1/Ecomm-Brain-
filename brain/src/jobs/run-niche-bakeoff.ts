import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { mapWithLimit } from '../lib/concurrency.js';
import {
  BAKEOFF_NICHES,
  DIGITAL_PREFERENCE_HURDLE,
  headTermFor,
  refineProducibilityFromResults,
  type ProducibilityTag
} from '../lib/bakeoff-keywords.js';
import {
  combineExternalDemand,
  fetchGoogleTrendDemandBatch,
  type GoogleTrendMeasurement
} from '../lib/bakeoff-demand.js';
import { gapScoreKeyword } from '../lib/gap-score-keyword.js';
import { searchEtsy } from '../lib/etsy-search.js';

interface BakeoffRow {
  keyword: string;
  /** Broad term the DEMAND leg measured (may equal keyword when no modifier stripped). */
  head_term: string;
  niche: string;
  is_anchor_niche: boolean;
  producibility: ProducibilityTag;
  google_interest: number | null;
  google_velocity: number | null;
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

interface PriorResult {
  keyword: string;
  external_demand: number;
  white_space_score: number;
  quadrant: string;
  google_demand: number | null;
}

function parseRunLabel(): string {
  const arg = process.argv.find(a => a.startsWith('--run-label='));
  if (arg) return arg.split('=')[1] ?? '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `bakeoff-v3-phrasefix-${ts}`;
}

function parseTreatment(): string {
  const arg = process.argv.find(a => a.startsWith('--treatment='));
  return arg?.split('=')[1] ?? 'baseline';
}

/**
 * Resolve the run to diff against. Explicit --diff-against wins; otherwise default to
 * the most recent v2 baseline (specific-phrase demand) so the head-term fix is measured
 * against the run it replaces. Returns null if none found / explicitly disabled.
 */
async function resolveDiffTarget(): Promise<string | null> {
  const arg = process.argv.find(a => a.startsWith('--diff-against='));
  if (arg) {
    const val = arg.split('=')[1] ?? '';
    return val === 'none' ? null : val;
  }
  const { data, error } = await supabase
    .from('niche_bakeoff_runs')
    .select('run_label')
    .like('run_label', 'bakeoff-baseline-v2-google-fixed-%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.run_label as string;
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

async function fetchPriorRunResults(runLabel: string): Promise<Map<string, PriorResult>> {
  const { data: run, error: runErr } = await supabase
    .from('niche_bakeoff_runs')
    .select('id')
    .eq('run_label', runLabel)
    .maybeSingle();

  if (runErr || !run) {
    console.warn(`\n[diff] prior run not found: ${runLabel}`);
    return new Map();
  }

  const { data: rows, error: resErr } = await supabase
    .from('niche_bakeoff_results')
    .select('keyword, external_demand, white_space_score, quadrant, google_demand')
    .eq('run_id', run.id);

  if (resErr) {
    console.warn(`[diff] failed to load prior results: ${resErr.message}`);
    return new Map();
  }

  const map = new Map<string, PriorResult>();
  for (const r of rows ?? []) {
    map.set(r.keyword as string, {
      keyword: r.keyword as string,
      external_demand: Number(r.external_demand ?? 0),
      white_space_score: Number(r.white_space_score ?? 0),
      quadrant: r.quadrant as string,
      google_demand: r.google_demand != null ? Number(r.google_demand) : null
    });
  }
  return map;
}

function printDiff(
  scored: BakeoffRow[],
  prior: Map<string, PriorResult>,
  priorLabel: string
): void {
  if (prior.size === 0) return;

  console.log(`\n--- 4. DIFF vs prior baseline (${priorLabel}) ---`);
  console.log('keyword | old_ext | new_ext | Δext | old_WS | new_WS | ΔWS | quadrant change');

  const diffs = scored
    .map(r => {
      const old = prior.get(r.keyword);
      if (!old) return null;
      return {
        keyword: r.keyword,
        old_ext: old.external_demand,
        new_ext: r.external_demand,
        delta_ext: r.external_demand - old.external_demand,
        old_ws: old.white_space_score,
        new_ws: r.white_space_score,
        delta_ws: r.white_space_score - old.white_space_score,
        old_quadrant: old.quadrant,
        new_quadrant: r.quadrant
      };
    })
    .filter((d): d is NonNullable<typeof d> => d != null)
    .sort((a, b) => Math.abs(b.delta_ws) - Math.abs(a.delta_ws));

  for (const d of diffs) {
    const qChange =
      d.old_quadrant !== d.new_quadrant
        ? `${d.old_quadrant}→${d.new_quadrant}`
        : d.new_quadrant;
    console.log(
      `${d.keyword.slice(0, 28).padEnd(28)} | ${d.old_ext.toFixed(3)} | ${d.new_ext.toFixed(3)} | ` +
        `${d.delta_ext >= 0 ? '+' : ''}${d.delta_ext.toFixed(3)} | ${d.old_ws.toFixed(3)} | ` +
        `${d.new_ws.toFixed(3)} | ${d.delta_ws >= 0 ? '+' : ''}${d.delta_ws.toFixed(3)} | ${qChange}`
    );
  }

  const oldRank = [...prior.values()].sort((a, b) => b.white_space_score - a.white_space_score);
  const newRank = [...scored].sort((a, b) => b.white_space_score - a.white_space_score);
  const oldTop = oldRank[0];
  const newTop = newRank[0];
  console.log(
    `\n  #1 change: "${oldTop?.keyword ?? '?'}" (${oldTop?.white_space_score.toFixed(3) ?? '?'}) → ` +
      `"${newTop.keyword}" (${newTop.white_space_score.toFixed(3)})`
  );

  const anchorKeywords = scored.filter(r => r.is_anchor_niche);
  const anchorOld = anchorKeywords
    .map(r => ({ keyword: r.keyword, ws: prior.get(r.keyword)?.white_space_score ?? 0, new_ws: r.white_space_score }))
    .sort((a, b) => b.new_ws - a.new_ws);
  console.log('  Anchor internal order (new WS):');
  for (const a of anchorOld) {
    const oldWs = prior.get(a.keyword)?.white_space_score ?? 0;
    console.log(
      `    ${a.keyword}: ${oldWs.toFixed(3)} → ${a.new_ws.toFixed(3)} (${a.new_ws - oldWs >= 0 ? '+' : ''}${(a.new_ws - oldWs).toFixed(3)})`
    );
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runLabel = parseRunLabel();
  const treatment = parseTreatment();
  const diffAgainst = await resolveDiffTarget();
  let etsySearchCalls = 0;
  let etsyListingCalls = 0;
  let etsy429s = 0;
  let serpApiCalls = 0;

  await log({
    agent: 'intel',
    action: 'bakeoff.start',
    description: `Niche bake-off starting: ${runLabel} (${BAKEOFF_NICHES.length} keywords)`,
    metadata: { run_label: runLabel, treatment, keyword_count: BAKEOFF_NICHES.length }
  });

  console.log(`\n=== Niche bake-off: ${runLabel} ===`);
  console.log(`Treatment: ${treatment} | Pinterest demand slot: null (baseline)`);
  console.log(`Demand leg: Google Trends on HEAD term (today 1-m, US) — broad enough to register interest`);
  console.log(`Supply leg: Etsy competition on SPECIFIC phrase — what a listing actually ranks against\n`);

  // DEMAND leg reads HEAD terms (deduped to save SerpApi credits); SUPPLY leg reads specific phrases.
  const headByKeyword = new Map<string, string>();
  for (const spec of BAKEOFF_NICHES) headByKeyword.set(spec.keyword, headTermFor(spec));
  const uniqueHeads = [...new Set([...headByKeyword.values()])];

  console.log(
    `Fetching Google Trends for ${uniqueHeads.length} unique head terms ` +
      `(from ${BAKEOFF_NICHES.length} specific phrases)…`
  );
  const googleByHead = await fetchGoogleTrendDemandBatch(uniqueHeads);
  serpApiCalls = uniqueHeads.length;

  for (const head of uniqueHeads) {
    const m = googleByHead.get(head);
    if (m?.has_data) {
      console.log(
        `  trends "${head.slice(0, 30).padEnd(30)}" interest=${m.interest_score?.toFixed(1)} ` +
          `velocity=${m.velocity_pct?.toFixed(1)}% demand=${m.google_demand.toFixed(3)}`
      );
    } else {
      console.log(
        `  trends "${head.slice(0, 30).padEnd(30)}" no data${m?.error ? ` (${m.error})` : ''} demand=0.000 (genuine low/dead)`
      );
    }
  }

  const priorResults = diffAgainst ? await fetchPriorRunResults(diffAgainst) : new Map();

  const { data: runRow, error: runErr } = await supabase
    .from('niche_bakeoff_runs')
    .insert({
      run_label: runLabel,
      treatment,
      pinterest_enabled: false,
      keyword_count: BAKEOFF_NICHES.length,
      metadata: {
        digital_hurdle: DIGITAL_PREFERENCE_HURDLE,
        sources: ['google_trends_head_term', 'etsy_incumbent_engagement'],
        pinterest_slot: null,
        google_fetch: 'serpapi TIMESERIES today 1-m geo=US',
        demand_supply_split: 'demand=head_term, supply=specific_phrase',
        unique_head_terms: uniqueHeads.length,
        diff_against: diffAgainst
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
    const head_term = headByKeyword.get(spec.keyword) ?? spec.keyword;
    const trend: GoogleTrendMeasurement =
      googleByHead.get(head_term) ?? {
        keyword: head_term,
        interest_score: null,
        velocity_pct: null,
        google_demand: 0,
        has_data: false
      };

    const google_demand = trend.google_demand;
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
      head_term,
      niche: spec.niche,
      is_anchor_niche: spec.is_anchor_niche,
      producibility,
      google_interest: trend.interest_score,
      google_velocity: trend.velocity_pct,
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
      demand_head_term: head_term,
      head_term_differs: head_term !== spec.keyword,
      scored_at: new Date().toISOString(),
      google_interest: trend.interest_score,
      google_velocity_pct: trend.velocity_pct,
      google_demand,
      google_has_data: trend.has_data,
      google_error: trend.error ?? null,
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
        `  ok   ${spec.keyword.slice(0, 42).padEnd(42)} ext=${external_demand.toFixed(3)} ` +
          `ws=${row.white_space_score.toFixed(3)} ${row.quadrant}${flagStr}`
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

  console.log('\n--- 0. DEMAND/SUPPLY SPLIT (head term drives demand; specific phrase drives supply) ---');
  console.log('specific phrase (supply) | head term (demand) | head_interest | head_demand | note');
  for (const r of scored) {
    const differs = r.head_term !== r.keyword;
    let note: string;
    if (!differs) {
      note = 'no modifier — head = specific';
    } else if (r.google_demand >= 0.05) {
      note = 'RESCUED (long-tail artifact → real head demand)';
    } else {
      note = 'genuine low/dead (head still ~0 — not rescued)';
    }
    console.log(
      `${r.keyword.slice(0, 32).padEnd(32)} | ${r.head_term.slice(0, 24).padEnd(24)} | ` +
        `${r.google_interest != null ? r.google_interest.toFixed(1).padStart(6) : '   n/a'} | ` +
        `${r.google_demand.toFixed(3)} | ${note}`
    );
  }

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

  if (diffAgainst && priorResults.size > 0) {
    printDiff(scored, priorResults, diffAgainst);
  }

  console.log(
    '\n--- Demand volatility caveat ---'
  );
  console.log(
    '  Single-window Google Trends velocity is volatile (e.g. meal planner ext_demand can swing run-to-run).'
  );
  console.log(
    '  Demand scores are approximate; borderline niches may warrant a re-pull or longer window.'
  );
  console.log('  Backlog: demand stability score (not built).');

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `\n[summary] run=${runLabel} keywords=${scored.length} ` +
      `serpapi=${serpApiCalls} etsy_search=${etsySearchCalls} etsy_listing≈${etsyListingCalls} ` +
      `429_fails≈${etsy429s} duration=${durationSec}s | v3 phrase-fix — head-term demand / specific-phrase supply, no Pinterest`
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
      serpapi_calls: serpApiCalls,
      top_raw: rawRanking.slice(0, 5).map(r => ({
        keyword: r.keyword,
        ws: r.white_space_score,
        ext_demand: r.external_demand,
        niche: r.niche
      })),
      top_niche: byNiche.slice(0, 3),
      duration_sec: durationSec,
      etsy_search_calls: etsySearchCalls,
      etsy_listing_calls: etsyListingCalls,
      diff_against: diffAgainst
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
