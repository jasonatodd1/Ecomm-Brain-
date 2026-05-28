// Opportunity scanner v2 — PHASE C: score from the filled eRank worksheet.
//
//   npm run opportunity:score -- --pulls=config/erank-pulls/{date}.csv
//
// Ingests the human-filled eRank worksheet + the Phase A sidecar, computes REAL
// demand (from eRank avg searches) and REAL attackability (from the top-10
// organic review counts), carries forward the Phase A AI-fit/compliance + wedge,
// applies the hard gates, persists to opportunity_scores with a data_source
// provenance flag, and writes the ranked report (with a validation section).
//
// UNKNOWN handling: any blank eRank field -> that pillar is UNKNOWN, excluded
// from the composite (status 'incomplete'), surfaced in the report. Blanks are
// NEVER coerced to 0.
//
// Error handling matches the pipeline: per-keyword failures log + skip.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import {
  scoreOpportunityErank,
  MIN_AVG_SEARCHES,
  OPPORTUNITY_SCORER_VERSION,
  type OpportunityErankInput,
  type OpportunityScoreResult
} from '../lib/opportunity-scoring.js';
import {
  costLine,
  ERANK_CSV_HEADER,
  logSafe,
  parseCsv,
  parseNumberCell,
  parseReviewCounts,
  readSidecar,
  runDateFromPath,
  type ShortlistEntry
} from '../lib/opportunity-pipeline.js';

// Keywords whose before/after we must show at the top of the report (the
// acceptance test for the eRank fix).
const VALIDATION_KEYWORDS = [
  'budget planner printable',
  'habit tracker printable',
  'freelancer client onboarding template',
  'virtual assistant business kit'
] as const;

interface PullRow {
  keyword: string;
  avg_searches: number | null;
  competition: number | null;
  top10_review_counts: number[] | null;
  notes: string;
}

function parsePullsCsv(text: string): PullRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  // Map header -> index so column order is forgiving.
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (name: string): number => header.indexOf(name);
  const iKw = idx('keyword');
  const iSearch = idx('etsy_avg_searches');
  const iComp = idx('etsy_competition');
  const iRev = idx('top10_review_counts');
  const iNotes = idx('notes');

  const out: PullRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 0) continue;
    const keyword = (row[iKw] ?? '').trim();
    if (!keyword) continue;
    out.push({
      keyword,
      avg_searches: iSearch >= 0 ? parseNumberCell(row[iSearch] ?? '') : null,
      competition: iComp >= 0 ? parseNumberCell(row[iComp] ?? '') : null,
      top10_review_counts: iRev >= 0 ? parseReviewCounts(row[iRev] ?? '') : null,
      notes: iNotes >= 0 ? (row[iNotes] ?? '').trim() : ''
    });
  }
  return out;
}

function detectFortress(notes: string): boolean {
  return /fortress|one shop|single shop|dominat/i.test(notes);
}

interface BeforeRow {
  attackability: number | null;
  demand: number | null;
  status: string | null;
  reason: string | null;
}

async function fetchBefore(runDate: string): Promise<Map<string, BeforeRow>> {
  // "Before" = the prior API-run rows (data_source IS NULL — written before the
  // provenance column existed) for the validation keywords.
  const { data, error } = await supabase
    .from('opportunity_scores')
    .select('keyword, attackability, demand, status, reason, data_source, run_date')
    .in('keyword', [...VALIDATION_KEYWORDS])
    .is('data_source', null);

  const map = new Map<string, BeforeRow>();
  if (error || !data) return map;
  for (const row of data as Array<Record<string, unknown>>) {
    const kw = String(row['keyword']);
    // Keep the most recent prior row per keyword.
    map.set(kw, {
      attackability: row['attackability'] as number | null,
      demand: row['demand'] as number | null,
      status: row['status'] as string | null,
      reason: row['reason'] as string | null
    });
  }
  return map;
}

interface ScoredKeyword {
  keyword: string;
  entry: ShortlistEntry;
  pull: PullRow | null;
  result: OpportunityScoreResult;
}

async function persist(runDate: string, sk: ScoredKeyword): Promise<void> {
  const { result, entry, pull } = sk;
  const reason = result.reasons.length > 0 ? result.reasons.join('; ') : null;
  const { error } = await supabase.from('opportunity_scores').upsert(
    {
      run_date: runDate,
      keyword: sk.keyword,
      opportunity_score: result.opportunity_score,
      attackability: result.attackability,
      demand: result.demand,
      ai_fit: result.ai_fit,
      demand_pool: null, // deprecated in v2 (estimated-sales model removed)
      median_reviews: result.signals.median_reviews,
      status: result.status,
      data_source: result.data_source,
      reason,
      wedge: entry.wedge || null,
      rationale: entry.rationale || null,
      sub_scores: result.sub_scores,
      raw_signals: {
        ...result.signals,
        compliance_risk: result.compliance_risk,
        erank_pull: pull
          ? {
              avg_searches: pull.avg_searches,
              competition: pull.competition,
              top10_review_counts: pull.top10_review_counts,
              notes: pull.notes
            }
          : null,
        unknown_flags: {
          demand_unknown: !result.signals.demand_known,
          attackability_unknown: !result.signals.attack_known
        }
      },
      model_meta: {
        scorer_version: OPPORTUNITY_SCORER_VERSION,
        product_type: entry.product_type,
        seo_quality_raw: entry.seo_quality,
        dominant_product_summary: entry.dominant_product_summary
      }
    },
    { onConflict: 'run_date,keyword' }
  );

  if (error) {
    await logSafe(
      'opportunity_score.persist_failed',
      `Failed to persist eRank score for "${sk.keyword}"`,
      'warning',
      { keyword: sk.keyword, error: error.message }
    );
  }
}

function fmt(n: number | null): string {
  if (n == null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function buildReport(
  runDate: string,
  scored: ScoredKeyword[],
  before: Map<string, BeforeRow>
): string {
  const lines: string[] = [];
  lines.push(`# Opportunity scan (eRank-verified) — ${runDate}`);
  lines.push('');
  lines.push(
    `Scanner ${OPPORTUNITY_SCORER_VERSION}. Demand + attackability are sourced from a ` +
      `manual **eRank** pull (ToS-clean licensed tool), NOT the Etsy API — which we verified ` +
      `cannot reproduce on-site organic ranking or surface a niche's true high-review incumbents.`
  );
  lines.push('');

  // --- Validation section (acceptance test) ---
  lines.push('## Validation (API-run → eRank-run)');
  lines.push('');
  lines.push(
    'Acceptance test for the fix. "Before" = the prior API run (biased proxy); ' +
      '"after" = this eRank-verified run.'
  );
  lines.push('');
  lines.push('| Keyword | Attack before → after | Demand before → after | Verdict |');
  lines.push('| --- | --- | --- | --- |');
  for (const kw of VALIDATION_KEYWORDS) {
    const sk = scored.find(s => s.keyword === kw);
    const b = before.get(kw);
    const beforeAttack = b ? fmt(b.attackability) : 'n/a';
    const beforeDemand = b
      ? b.status === 'excluded'
        ? `excl (${fmt(b.demand)})`
        : fmt(b.demand)
      : 'n/a';
    if (!sk) {
      lines.push(`| ${kw} | ${beforeAttack} → (no eRank row) | ${beforeDemand} → (no eRank row) | ⏳ awaiting data |`);
      continue;
    }
    const r = sk.result;
    const afterAttack = r.attackability != null ? fmt(r.attackability) : 'UNKNOWN';
    const afterDemand =
      r.status === 'excluded' && r.reasons.some(x => x.includes('demand'))
        ? `excl (${fmt(r.demand)})`
        : r.demand != null
          ? fmt(r.demand)
          : 'UNKNOWN';
    const verdict = validationVerdict(kw, sk);
    lines.push(`| ${kw} | ${beforeAttack} → ${afterAttack} | ${beforeDemand} → ${afterDemand} | ${verdict} |`);
  }
  lines.push('');

  // --- eRank-verified scored survivors ---
  const survivors = scored
    .filter(s => s.result.status === 'scored')
    .sort((a, b) => (b.result.opportunity_score ?? 0) - (a.result.opportunity_score ?? 0));
  lines.push('## eRank-verified candidates (sorted by opportunity_score)');
  lines.push('');
  if (survivors.length === 0) {
    lines.push('_None scored._');
  } else {
    lines.push(
      '| Keyword | Opp | Attack | Demand | AI-fit | Median reviews | Avg searches | Wedge |'
    );
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const s of survivors) {
      const r = s.result;
      lines.push(
        `| ${s.keyword} | **${fmt(r.opportunity_score)}** | ${fmt(r.attackability)} | ${fmt(r.demand)} | ${fmt(r.ai_fit)} | ${fmt(r.signals.median_reviews)} | ${fmt(r.signals.avg_searches)} | ${s.entry.wedge || '—'} |`
      );
    }
    lines.push('');
    lines.push('### Rationales');
    lines.push('');
    for (const s of survivors) {
      lines.push(`- **${s.keyword}** (${fmt(s.result.opportunity_score)}): ${s.entry.rationale || '—'}`);
    }
  }
  lines.push('');

  // --- Incomplete (blank eRank fields) ---
  const incomplete = scored.filter(s => s.result.status === 'incomplete');
  lines.push('## Incomplete (awaiting eRank data — UNKNOWN pillars)');
  lines.push('');
  if (incomplete.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Keyword | Attack | Demand | AI-fit | Missing |');
    lines.push('| --- | ---: | ---: | ---: | --- |');
    for (const s of incomplete) {
      const r = s.result;
      lines.push(
        `| ${s.keyword} | ${fmt(r.attackability)} | ${fmt(r.demand)} | ${fmt(r.ai_fit)} | ${r.reasons.join('; ')} |`
      );
    }
  }
  lines.push('');

  // --- Excluded ---
  const excluded = scored.filter(s => s.result.status === 'excluded');
  lines.push('## Excluded');
  lines.push('');
  if (excluded.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Keyword | Attack | Demand | AI-fit | Source | Reason |');
    lines.push('| --- | ---: | ---: | ---: | --- | --- |');
    for (const s of excluded) {
      const r = s.result;
      lines.push(
        `| ${s.keyword} | ${fmt(r.attackability)} | ${fmt(r.demand)} | ${fmt(r.ai_fit)} | ${r.data_source} | ${r.reasons.join('; ')} |`
      );
    }
  }
  lines.push('');

  // --- Notes ---
  lines.push('## Notes');
  lines.push('');
  lines.push(
    `- **Demand** = eRank "Etsy avg searches" (monthly), banded 0-100. Hard gate: avg searches < ${MIN_AVG_SEARCHES}/mo → excluded. ` +
      'The old estimated-sales demand_pool + MIN_DEMAND_POOL are removed.'
  );
  lines.push(
    '- **Attackability** = real eRank top-10 organic review counts → median (inverted) + soft_ratio (share < 500), ' +
      'plus carried-forward Haiku seo_gap + specificity_gap; fortress flag caps it hard. youth_signal is dropped (its estimated-sales input is gone).'
  );
  lines.push(
    '- **AI-fit** = Haiku product-type classification carried forward from Phase A (not re-run). craft / AI-art-risk niches are excluded at Phase A.'
  );
  lines.push(
    '- **data_source** provenance: `erank_verified` = demand + attackability from the pull; `incomplete` = a pillar was blank; `api_preliminary` = excluded at the AI-fit gate (no eRank).'
  );
  lines.push(
    '- Blank eRank fields are UNKNOWN, excluded from the composite — never coerced to 0.'
  );
  lines.push(
    '- All thresholds/weights are first-pass (see opportunity-scoring.ts) and need tuning against this run.'
  );
  return lines.join('\n');
}

function validationVerdict(keyword: string, sk: ScoredKeyword): string {
  const r = sk.result;
  if (keyword === 'budget planner printable' || keyword === 'habit tracker printable') {
    if (r.attackability == null) return '⏳ attackability still UNKNOWN (fill top-10 reviews)';
    // The fix succeeds if real top-10 fortress reviews drop attackability to LOW.
    return r.attackability <= 45
      ? `✅ dropped to LOW attackability (${fmt(r.attackability)})`
      : `❌ STILL HIGH (${fmt(r.attackability)}) — fix failed for this keyword (check real top-10 reviews/fortress)`;
  }
  // freelancer / VA: demand re-evaluated on real volume.
  if (r.demand == null) return '⏳ demand still UNKNOWN (fill avg searches)';
  if (r.status === 'excluded' && r.reasons.some(x => x.includes('demand'))) {
    return `genuinely thin on real volume (avg searches ${fmt(r.signals.avg_searches)})`;
  }
  if (r.status === 'scored') {
    return `survives on real volume (demand ${fmt(r.demand)}, avg searches ${fmt(r.signals.avg_searches)})`;
  }
  return `re-evaluated (${r.status})`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const pullsArg = process.argv.find(a => a.startsWith('--pulls='));
  if (!pullsArg) {
    console.error('Missing --pulls=<path to filled eRank CSV>. Run Phase A first (npm run opportunity:shortlist).');
    process.exit(1);
  }
  const pullsPath = path.resolve(process.cwd(), pullsArg.slice('--pulls='.length));
  const runDate = runDateFromPath(pullsPath);

  // Read worksheet + sidecar.
  let csvText: string;
  try {
    csvText = await readFile(pullsPath, 'utf-8');
  } catch {
    console.error(`Could not read pulls CSV: ${pullsPath}`);
    process.exit(1);
  }
  const sidecar = await readSidecar(pullsPath).catch(() => null);
  if (!sidecar) {
    console.error(
      `Could not read the Phase A sidecar (${pullsPath.replace(/\.csv$/i, '.shortlist.json')}). ` +
        'Re-run Phase A (npm run opportunity:shortlist) to regenerate it.'
    );
    process.exit(1);
  }

  const pulls = parsePullsCsv(csvText);
  const pullByKeyword = new Map(pulls.map(p => [p.keyword, p]));

  await logSafe(
    'opportunity_score.start',
    `Phase C scoring starting from ${path.basename(pullsPath)}: ${sidecar.entries.length} keywords`,
    'info',
    { run_date: runDate, pulls_path: pullsPath, keywords: sidecar.entries.length }
  );
  console.log(
    `Opportunity scanner ${OPPORTUNITY_SCORER_VERSION} — PHASE C score — run ${runDate}\n` +
      `Worksheet: ${pullsPath}\n`
  );

  const before = await fetchBefore(runDate);

  const scored: ScoredKeyword[] = [];
  for (const entry of sidecar.entries) {
    try {
      const pull = pullByKeyword.get(entry.keyword) ?? null;
      const input: OpportunityErankInput = {
        avg_searches: pull?.avg_searches ?? null,
        competition: pull?.competition ?? null,
        top10_review_counts: pull?.top10_review_counts ?? null,
        fortress: pull ? detectFortress(pull.notes) : false,
        ai_fit: entry.ai_fit,
        compliance_risk: entry.compliance_risk,
        product_type: entry.product_type,
        seo_gap: entry.seo_gap,
        specificity_gap: entry.specificity_gap,
        ai_excluded: entry.ai_excluded,
        ai_exclude_reason: entry.ai_exclude_reason ?? undefined
      };
      const result = scoreOpportunityErank(input);
      const sk: ScoredKeyword = { keyword: entry.keyword, entry, pull, result };
      await persist(runDate, sk);
      scored.push(sk);

      const r = result;
      console.log(
        `  ${r.status.padEnd(10)} "${entry.keyword}": ` +
          `opp=${fmt(r.opportunity_score)} attack=${fmt(r.attackability)} ` +
          `demand=${fmt(r.demand)} ai_fit=${fmt(r.ai_fit)} ` +
          `[${r.data_source}]${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL "${entry.keyword}": ${msg}`);
      await logSafe(
        'opportunity_score.keyword_failed',
        `Phase C failed for "${entry.keyword}" — skipped`,
        'warning',
        { keyword: entry.keyword, error: msg }
      );
    }
  }

  // --- Report ---
  const reportDir = path.resolve(process.cwd(), 'opportunities');
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${runDate}.md`);
  await writeFile(reportPath, buildReport(runDate, scored, before), 'utf-8');

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n--- Report written to ${reportPath} ---`);
  console.log(costLine());
  console.log(
    `[summary] scored=${scored.filter(s => s.result.status === 'scored').length} ` +
      `incomplete=${scored.filter(s => s.result.status === 'incomplete').length} ` +
      `excluded=${scored.filter(s => s.result.status === 'excluded').length} duration=${durationSec}s`
  );

  await logSafe(
    'opportunity_score.complete',
    `Phase C done: ${scored.length} keywords in ${durationSec}s`,
    'success',
    {
      run_date: runDate,
      scored: scored.filter(s => s.result.status === 'scored').length,
      incomplete: scored.filter(s => s.result.status === 'incomplete').length,
      excluded: scored.filter(s => s.result.status === 'excluded').length,
      report_path: reportPath
    }
  );
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
