// Opportunity scanner v2 — PHASE A: shortlist (automated, clean).
//
//   npm run opportunity:shortlist [-- --keywords="a,b,c"]
//
// For each seed keyword: run the Haiku AI-fit classifier + compliance gate
// (EXCLUDE craft-moated / AI-art-risk here, unchanged behavior), generate the
// Sonnet wedge, and emit an eRank worksheet CSV + a machine-state sidecar.
//
// The human then fills the CSV from eRank (real avg searches, competition,
// top-10 review counts) and runs Phase C (score-opportunities-from-erank.ts).
// API-derived demand/review numbers are PRELIMINARY/UNTRUSTED and never feed
// the final score — see the verified KEY LIMITATION (Etsy API can't reproduce
// organic ranking / true incumbents).
//
// Error handling matches the pipeline: per-keyword failures log + skip; one bad
// keyword never crashes the run or corrupts state.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import {
  aiFitExclusionReason,
  computeAiFit,
  OPPORTUNITY_SCORER_VERSION
} from '../lib/opportunity-scoring.js';
import {
  assessIncumbents,
  costLine,
  ERANK_CSV_HEADER,
  gatherPreliminary,
  logSafe,
  toCsvRow,
  totalCostUsd,
  writeWedge,
  writeSidecar,
  type ShortlistEntry,
  type ShortlistSidecar
} from '../lib/opportunity-pipeline.js';

const SEED_FILE = path.resolve(process.cwd(), 'config/opportunity-seed-keywords.txt');
const PULLS_DIR = path.resolve(process.cwd(), 'config/erank-pulls');

async function resolveKeywords(): Promise<string[]> {
  const arg = process.argv.find(a => a.startsWith('--keywords='));
  if (arg) {
    return arg
      .slice('--keywords='.length)
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
  }
  const raw = await readFile(SEED_FILE, 'utf-8');
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
}

async function shortlistKeyword(keyword: string): Promise<ShortlistEntry> {
  const listings = await gatherPreliminary(keyword);
  const llm = await assessIncumbents(keyword, listings);
  const { ai_fit, compliance_risk } = computeAiFit(llm);
  const aiReason = aiFitExclusionReason(ai_fit, compliance_risk);

  const entry: ShortlistEntry = {
    keyword,
    ai_fit,
    compliance_risk,
    product_type: llm.product_type,
    seo_quality: llm.seo_quality,
    seo_gap: Math.max(0, Math.min(100, 100 - llm.seo_quality)),
    specificity_gap: llm.specificity_gap,
    dominant_product_summary: llm.dominant_product_summary,
    ai_excluded: aiReason != null,
    ai_exclude_reason: aiReason,
    wedge: '',
    rationale: '',
    preliminary_listings_seen: listings.length
  };

  // Wedge only for gate-passing keywords (no point pulling eRank / pitching a
  // craft-moated niche we won't score).
  if (!entry.ai_excluded) {
    const preliminaryNote =
      listings.length > 0
        ? `${listings.length} API listings seen (titles/tags only; demand+reviews come from eRank, not here)`
        : 'no API listings returned';
    const w = await writeWedge(keyword, llm, preliminaryNote);
    entry.wedge = w.wedge;
    entry.rationale = w.rationale;
  }

  return entry;
}

function erankInstructions(keyword: string): string {
  return (
    `  • "${keyword}"\n` +
    `      Keyword Tool       -> etsy_avg_searches (monthly), etsy_competition (# listings)\n` +
    `      "Average buyer sees in search results" view -> top10_review_counts:\n` +
    `        the review counts of the actual top 10 organic listings, comma-separated\n` +
    `      notes -> say "fortress: <shop>" if one shop dominates the top 3; blank = unknown`
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const runDate = new Date().toISOString().slice(0, 10);

  const keywords = await resolveKeywords();
  if (keywords.length === 0) {
    console.log('[summary] no keywords (empty seed file and no --keywords=)');
    return;
  }

  await logSafe(
    'opportunity_shortlist.start',
    `Opportunity shortlist (Phase A) starting: ${keywords.length} keywords`,
    'info',
    { keywords, run_date: runDate }
  );
  console.log(
    `Opportunity scanner ${OPPORTUNITY_SCORER_VERSION} — PHASE A shortlist — ${keywords.length} keywords (run ${runDate})\n`
  );

  const entries: ShortlistEntry[] = [];
  for (const keyword of keywords) {
    try {
      const entry = await shortlistKeyword(keyword);
      entries.push(entry);
      if (entry.ai_excluded) {
        console.log(`  excl "${keyword}": ${entry.ai_exclude_reason}`);
      } else {
        console.log(
          `  pass "${keyword}": ai_fit=${entry.ai_fit} type=${entry.product_type} ` +
            `seo_gap=${entry.seo_gap} spec_gap=${entry.specificity_gap}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL "${keyword}": ${msg}`);
      await logSafe(
        'opportunity_shortlist.keyword_failed',
        `Phase A failed for "${keyword}" — skipped`,
        'warning',
        { keyword, error: msg }
      );
    }
  }

  const gatePassing = entries.filter(e => !e.ai_excluded);
  const excluded = entries.filter(e => e.ai_excluded);

  // --- Write the eRank worksheet CSV (gate-passing keywords only) ---
  await mkdir(PULLS_DIR, { recursive: true });
  const csvPath = path.join(PULLS_DIR, `${runDate}.csv`);
  const csvLines = [toCsvRow([...ERANK_CSV_HEADER])];
  for (const e of gatePassing) {
    csvLines.push(toCsvRow([e.keyword, e.wedge, '', '', '', '']));
  }
  await writeFile(csvPath, csvLines.join('\n') + '\n', 'utf-8');

  // --- Write the Phase A -> Phase C sidecar (ALL keywords, incl. excluded) ---
  const sidecar: ShortlistSidecar = {
    run_date: runDate,
    scorer_version: OPPORTUNITY_SCORER_VERSION,
    entries
  };
  await writeSidecar(csvPath, sidecar);

  // --- Report ---
  console.log(`\n=== SHORTLIST (${gatePassing.length} gate-passing, ${excluded.length} excluded) ===`);
  if (gatePassing.length > 0) {
    console.log('\nGate-passing → fill these in eRank:');
    for (const e of gatePassing) {
      console.log(`  - ${e.keyword}  —  wedge: ${e.wedge || '(none)'}`);
    }
  }
  if (excluded.length > 0) {
    console.log('\nExcluded at AI-fit gate (no eRank pull needed):');
    for (const e of excluded) {
      console.log(`  - ${e.keyword}: ${e.ai_exclude_reason}`);
    }
  }

  console.log('\n=== eRank instructions (per keyword) ===');
  for (const e of gatePassing) {
    console.log(erankInstructions(e.keyword));
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\nWorksheet:  ${csvPath}`);
  console.log(`Sidecar:    ${csvPath.replace(/\.csv$/i, '.shortlist.json')}`);
  console.log(`Next:       fill the worksheet from eRank, then run:`);
  console.log(`            npm run opportunity:score -- --pulls=${path.relative(process.cwd(), csvPath)}`);
  console.log(`\n${costLine()}`);
  console.log(
    `[summary] keywords=${entries.length} gate_passing=${gatePassing.length} ` +
      `excluded=${excluded.length} duration=${durationSec}s`
  );

  await logSafe(
    'opportunity_shortlist.complete',
    `Phase A done: ${gatePassing.length} gate-passing, ${excluded.length} excluded in ${durationSec}s`,
    'success',
    {
      run_date: runDate,
      gate_passing: gatePassing.length,
      excluded: excluded.length,
      csv_path: csvPath,
      llm_cost_usd: Number(totalCostUsd().toFixed(4))
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
