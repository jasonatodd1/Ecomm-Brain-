// HillwardStudio Meal Planner — PDF renderer (4 SKUs from one template).
//
// Renders products/hillward-meal-planner/templates/index.html four times,
// once per (week-start × paper-size) combo, writing the PDFs into
// products/hillward-meal-planner/deliverables/.
//
// Asset spec is locked by v5 brief cb213bf4 (multi-wedge differentiation):
//   - 7-day meal grid (Sun-start AND Mon-start variants)
//   - Aisle-grouped grocery list (Produce/Proteins/Dairy/Pantry/Freezer/Other)
//   - Side-by-side meal grid + grocery on a single page
//   - Notes strip
//   - Print-friendly (no solid fills, hairline rules)
//
// Mirrors the bunny/A5-planner pattern: one product directory under
// products/<slug>/, HTML+CSS in templates/, output in deliverables/
// (gitignored). One Puppeteer browser instance reused across all 4 renders
// for speed — total runtime stays well under 10s on M-series hardware.
//
// CLI:
//   npm run build:meal-planner

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, statSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT_DIR = path.join(PROJECT_ROOT, 'products', 'hillward-meal-planner');
const INPUT_HTML = path.join(PRODUCT_DIR, 'templates', 'index.html');
const OUTPUT_DIR = path.join(PRODUCT_DIR, 'deliverables');

type WeekStart = 'sun' | 'mon';
type PaperSize = 'letter' | 'a4';

interface SkuVariant {
  start: WeekStart;
  size: PaperSize;
  filename: string;
  /** Pupeteer page.pdf format value. */
  pdfFormat: 'Letter' | 'A4';
}

const SKUS: SkuVariant[] = [
  { start: 'sun', size: 'letter', filename: 'meal-planner-sun-letter.pdf', pdfFormat: 'Letter' },
  { start: 'mon', size: 'letter', filename: 'meal-planner-mon-letter.pdf', pdfFormat: 'Letter' },
  { start: 'sun', size: 'a4',     filename: 'meal-planner-sun-a4.pdf',     pdfFormat: 'A4'     },
  { start: 'mon', size: 'a4',     filename: 'meal-planner-mon-a4.pdf',     pdfFormat: 'A4'     }
];

interface RenderedSku extends SkuVariant {
  outputPath: string;
  sizeKb: number;
  durationMs: number;
}

async function renderOne(
  browser: Browser,
  sku: SkuVariant
): Promise<RenderedSku> {
  const outputPath = path.join(OUTPUT_DIR, sku.filename);
  const start = Date.now();

  const page = await browser.newPage();
  try {
    const fileUrl = pathToFileURL(INPUT_HTML).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle0' });

    // Apply variant data-attributes BEFORE the template's inline script runs
    // its DOM build... except the inline script already ran on `goto`. So we
    // re-run the build after flipping the data-attributes — the template is
    // structured so its `build()` IIFE reads data-start / data-size from <body>
    // at call time, but it self-invoked on first parse. Simplest reliable
    // path: rebuild the variant-dependent DOM in-page.
    await page.evaluate(
      ({ startAttr, sizeAttr }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const doc = (globalThis as any).document;
        doc.body.setAttribute('data-start', startAttr);
        doc.body.setAttribute('data-size', sizeAttr);

        const startLabel = startAttr === 'mon' ? 'Monday Start' : 'Sunday Start';
        const DAYS_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const DAYS_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const days = startAttr === 'mon' ? DAYS_MON : DAYS_SUN;

        const grid = doc.getElementById('meal-days');
        if (grid) {
          grid.innerHTML = '';
          for (const d of days) {
            const labelWrap = doc.createElement('div');
            labelWrap.className = 'day-cell day-label-cell';
            const label = doc.createElement('span');
            label.className = 'day-label';
            label.textContent = d;
            labelWrap.appendChild(label);
            grid.appendChild(labelWrap);
            for (let i = 0; i < 3; i++) {
              const cell = doc.createElement('div');
              cell.className = 'day-cell meal-cell';
              grid.appendChild(cell);
            }
          }
        }

        const chip = doc.querySelector('.week-start-chip');
        if (chip) chip.textContent = startLabel;
        const meta = doc.querySelector('.footer-meta');
        if (meta) {
          meta.textContent =
            `Weekly Meal Planner · Aisle-Grouped Grocery · ${startLabel}`;
        }
      },
      { startAttr: sku.start, sizeAttr: sku.size }
    );

    await page.evaluateHandle('document.fonts.ready');

    await page.pdf({
      path: outputPath,
      format: sku.pdfFormat,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: false
    });
  } finally {
    await page.close();
  }

  const sizeKb = statSync(outputPath).size / 1024;
  const durationMs = Date.now() - start;
  return { ...sku, outputPath, sizeKb, durationMs };
}

async function main(): Promise<void> {
  const overallStart = Date.now();
  console.log('> rendering HillwardStudio meal planner v1 (4 SKUs)');
  console.log(`  source: ${INPUT_HTML}`);
  console.log(`  output: ${OUTPUT_DIR}`);
  console.log('');

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });
  const results: RenderedSku[] = [];
  try {
    for (const sku of SKUS) {
      const r = await renderOne(browser, sku);
      results.push(r);
      console.log(
        `  ✓ ${r.filename.padEnd(32)} ${r.sizeKb.toFixed(1).padStart(6)} KB  ${String(r.durationMs).padStart(5)} ms`
      );
    }
  } finally {
    await browser.close();
  }

  const totalMs = Date.now() - overallStart;
  const totalKb = results.reduce((a, r) => a + r.sizeKb, 0);

  console.log('');
  console.log(`✓ rendered ${results.length} SKUs in ${totalMs} ms`);
  console.log(`  total size: ${totalKb.toFixed(1)} KB`);
}

main().catch(err => {
  console.error('');
  console.error('✗ meal planner render failed');
  console.error('  message:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error('  stack:');
    console.error(err.stack);
  }
  process.exit(1);
});
