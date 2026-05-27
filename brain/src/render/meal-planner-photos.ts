// HillwardStudio Meal Planner — programmatic listing photos.
//
// Produces 3 deliverables from the v4 template, mirroring the bunny
// listing-photos pattern but adapted for a structured-document product:
//
//   1. meal-planner-05-pdf-preview.png         (kind: artwork_flat, display_order: 5)
//      Canonical mon-start / US Letter page, rendered straight from
//      HTML at deviceScaleFactor 3.125 → ~2550×3300px (Letter at 300dpi,
//      long edge 3300px > the 3000 Etsy ask). The cream off-white
//      background is captured intact. Doubles as (a) an Etsy listing
//      photo of the actual product flat and (b) the source image
//      Jason composites into lifestyle scenes in fal UI.
//
//   2. meal-planner-06-detail-aisle-headers.png (kind: lifestyle_detail, display_order: 6)
//      Tight crop of the grocery section showing all 6 aisle headers
//      (Produce / Proteins / Dairy / Pantry / Freezer / Other) with
//      a thin strip of meal-grid context on the left to make the
//      side-by-side workflow wedge visually obvious. Per v5
//      image_spec, this exists specifically "to make the structural
//      innovation obvious." Captured by reading the bounding rect of
//      .grocery from the rendered DOM and using sharp.extract().
//
//   3. meal-planner-07-whats-included.png      (kind: whats_included, display_order: 7)
//      2×2 composite of all 4 SKU page-thumbnails with labels
//      (Sun-start Letter / Mon-start Letter / Sun-start A4 / Mon-start
//      A4). Built by rendering each SKU as a base64 PNG thumbnail and
//      assembling them into a standalone HTML grid that Puppeteer
//      then captures as one image. Cream background matches the
//      planner palette.
//
// Lifestyle photos (hero, two lifestyle scenes) are NOT produced here —
// those are composited by Jason in fal UI using pdf-preview.png as the
// input. Same split as the bunny: programmatic technicals via Cursor,
// lifestyle compositing via fal UI by the operator.
//
// CLI:
//   npm run render:meal-planner-photos

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, statSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT_DIR = path.join(PROJECT_ROOT, 'products', 'hillward-meal-planner');
const TEMPLATE_HTML = path.join(PRODUCT_DIR, 'templates', 'index.html');
const PHOTOS_DIR = path.join(PRODUCT_DIR, 'listing-photos');

// 300 dpi = 300 / 96 css-px ≈ 3.125 — produces 2550×3300 from 816×1056
// CSS-px viewport (Letter at default 96dpi). A4 reuses the same scale.
const HI_DPI_SCALE = 3.125;
const LETTER_CSS_W = 816;
const LETTER_CSS_H = 1056;
const A4_CSS_W = 794;   // 210mm * 3.7795 px/mm
const A4_CSS_H = 1123;  // 297mm * 3.7795 px/mm

// Thumbnail device-scale for the 2×2 grid. 1.5× gives source PNGs
// big enough to downsample crisply when the composite is captured at
// dpr=2 (composite img displays at ≤464×600 CSS → ≤928×1200 output;
// source at 1.5 scale = 1224×1584, comfortable downsample headroom).
const THUMB_SCALE = 1.5;

// Cream off-white matches --off-white in the planner CSS (#F7F5F2).
const CREAM = '#F7F5F2';

type WeekStart = 'sun' | 'mon';
type PaperSize = 'letter' | 'a4';

interface SkuVariant {
  start: WeekStart;
  size: PaperSize;
  label: string;
  cssPageSize: 'letter' | 'A4';
}

const ALL_SKUS: SkuVariant[] = [
  { start: 'sun', size: 'letter', label: 'Sunday-start · US Letter', cssPageSize: 'letter' },
  { start: 'mon', size: 'letter', label: 'Monday-start · US Letter', cssPageSize: 'letter' },
  { start: 'sun', size: 'a4',     label: 'Sunday-start · A4',        cssPageSize: 'A4'     },
  { start: 'mon', size: 'a4',     label: 'Monday-start · A4',        cssPageSize: 'A4'     },
];

// Canonical SKU for the standalone "PDF preview" hero shot — same one
// the v5 brief image_spec[0] keys off.
const CANONICAL_SKU: SkuVariant = ALL_SKUS[1]; // mon-start · Letter

interface RenderResult {
  filename: string;
  outputPath: string;
  widthPx: number;
  heightPx: number;
  sizeKb: number;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Load the template into a puppeteer page and apply variant attributes
 * (data-start, data-size) + the per-render @page CSS injection. Returns
 * the page sized to the variant's CSS pixel dimensions at HI_DPI_SCALE.
 *
 * Same pattern as src/render/meal-planner.ts but optimized for PNG
 * screenshots — viewport equals exactly the .page CSS dimensions so we
 * can `page.screenshot({ fullPage: false, clip: full-page })` without
 * any white margin bleed.
 */
async function preparePage(
  browser: Browser,
  sku: SkuVariant,
  scale: number
): Promise<import('puppeteer').Page> {
  const page = await browser.newPage();
  const cssW = sku.size === 'letter' ? LETTER_CSS_W : A4_CSS_W;
  const cssH = sku.size === 'letter' ? LETTER_CSS_H : A4_CSS_H;
  await page.setViewport({ width: cssW, height: cssH, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(TEMPLATE_HTML).href, { waitUntil: 'networkidle0' });

  await page.evaluate(
    ({ startAttr, sizeAttr, cssPageSize }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as any).document;
      doc.body.setAttribute('data-start', startAttr);
      doc.body.setAttribute('data-size', sizeAttr);

      const existing = doc.getElementById('page-size-style');
      if (existing) existing.remove();
      const style = doc.createElement('style');
      style.id = 'page-size-style';
      style.textContent = `@page { size: ${cssPageSize}; margin: 0; }`;
      doc.head.appendChild(style);

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
    { startAttr: sku.start, sizeAttr: sku.size, cssPageSize: sku.cssPageSize }
  );

  await page.evaluateHandle('document.fonts.ready');
  return page;
}

/**
 * Screenshot the .page element of a prepared puppeteer page. Returns a
 * PNG buffer. We screenshot the element (not the viewport) so we can't
 * accidentally include the document body's default white background.
 */
async function screenshotPage(
  page: import('puppeteer').Page
): Promise<Buffer> {
  const handle = await page.$('.page');
  if (!handle) throw new Error('.page element not found in template');
  const buf = (await handle.screenshot({ type: 'png' })) as Buffer;
  await handle.dispose();
  return buf;
}

function describe(p: string): { sizeKb: number } {
  return { sizeKb: statSync(p).size / 1024 };
}

// ------------------------------------------------------------------
// 1. pdf-preview.png — canonical product flat at 300dpi
// ------------------------------------------------------------------
async function renderPdfPreview(browser: Browser): Promise<RenderResult> {
  const filename = 'meal-planner-05-pdf-preview.png';
  const outputPath = path.join(PHOTOS_DIR, filename);

  const page = await preparePage(browser, CANONICAL_SKU, HI_DPI_SCALE);
  try {
    const png = await screenshotPage(page);
    await sharp(png).toFile(outputPath);
  } finally {
    await page.close();
  }

  const meta = await sharp(outputPath).metadata();
  return {
    filename,
    outputPath,
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
    sizeKb: describe(outputPath).sizeKb,
  };
}

// ------------------------------------------------------------------
// 2. detail-aisle-headers.png — tight grocery-section crop
// ------------------------------------------------------------------
async function renderAisleDetail(browser: Browser): Promise<RenderResult> {
  const filename = 'meal-planner-06-detail-aisle-headers.png';
  const outputPath = path.join(PHOTOS_DIR, filename);

  const page = await preparePage(browser, CANONICAL_SKU, HI_DPI_SCALE);
  try {
    // Capture the full canonical page first, then crop to grocery + a
    // strip of meal-grid context on the left. Reading the bounding rect
    // from the DOM keeps the crop accurate even if the layout shifts.
    const fullPng = await screenshotPage(page);

    const bounds = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const doc = (globalThis as any).document;
      const pageEl = doc.querySelector('.page');
      const groceryEl = doc.querySelector('.grocery');
      if (!pageEl || !groceryEl) {
        throw new Error('layout elements not found');
      }
      const pageRect = pageEl.getBoundingClientRect();
      const grocRect = groceryEl.getBoundingClientRect();
      return {
        pageLeft:   pageRect.left,
        pageTop:    pageRect.top,
        pageWidth:  pageRect.width,
        pageHeight: pageRect.height,
        grocLeft:   grocRect.left,
        grocTop:    grocRect.top,
        grocWidth:  grocRect.width,
        grocHeight: grocRect.height,
      };
    });

    // Convert DOM-pixel rect to device-pixel rect for sharp.extract.
    const dpr = HI_DPI_SCALE;
    // Add a 28-CSS-px strip of meal-grid context on the left so the
    // viewer reads the side-by-side workflow wedge, not just a column.
    const leftContextCss = 28;
    const left = Math.max(
      0,
      Math.round((bounds.grocLeft - bounds.pageLeft - leftContextCss) * dpr)
    );
    const top = Math.max(
      0,
      Math.round((bounds.grocTop - bounds.pageTop) * dpr)
    );
    const width = Math.round((bounds.grocWidth + leftContextCss) * dpr);
    const height = Math.round(bounds.grocHeight * dpr);

    await sharp(fullPng)
      .extract({ left, top, width, height })
      .toFile(outputPath);
  } finally {
    await page.close();
  }

  const meta = await sharp(outputPath).metadata();
  return {
    filename,
    outputPath,
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
    sizeKb: describe(outputPath).sizeKb,
  };
}

// ------------------------------------------------------------------
// 3. whats-included.png — 2x2 SKU grid composite
// ------------------------------------------------------------------
async function renderWhatsIncluded(browser: Browser): Promise<RenderResult> {
  const filename = 'meal-planner-07-whats-included.png';
  const outputPath = path.join(PHOTOS_DIR, filename);

  // First: render every SKU as a moderately-sized PNG thumbnail and
  // base64-embed them in a composite HTML page.
  const thumbs: Array<{ sku: SkuVariant; dataUrl: string }> = [];
  for (const sku of ALL_SKUS) {
    const page = await preparePage(browser, sku, THUMB_SCALE);
    try {
      const buf = await screenshotPage(page);
      thumbs.push({
        sku,
        dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
      });
    } finally {
      await page.close();
    }
  }

  // Build the composite HTML. Single Inter family across the design
  // for typographic continuity with the planner itself.
  const compositeHtml = buildWhatsIncludedHtml(thumbs);

  const page = await browser.newPage();
  try {
    // 3000×3000 final composite — well above Etsy display ceiling and
    // clean to crop/resize later if needed.
    await page.setViewport({ width: 1500, height: 1500, deviceScaleFactor: 2 });
    // setContent only accepts 'load' / 'domcontentloaded' waitUntil
    // values; we then poll document.fonts.ready to ensure Inter
    // glyphs are embedded before screenshotting.
    await page.setContent(compositeHtml, { waitUntil: 'load' });
    await page.evaluateHandle('document.fonts.ready');

    const handle = await page.$('.composite');
    if (!handle) throw new Error('.composite root not found');
    const buf = (await handle.screenshot({ type: 'png' })) as Buffer;
    await handle.dispose();

    await sharp(buf).toFile(outputPath);
  } finally {
    await page.close();
  }

  const meta = await sharp(outputPath).metadata();
  return {
    filename,
    outputPath,
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
    sizeKb: describe(outputPath).sizeKb,
  };
}

function buildWhatsIncludedHtml(
  thumbs: Array<{ sku: SkuVariant; dataUrl: string }>
): string {
  // Square composite — 2×2 grid + small header. CSS embedded inline
  // because this template is single-use and never edited by hand.
  const cellsHtml = thumbs.map(t => `
    <div class="cell">
      <div class="thumb-wrap">
        <img class="thumb" src="${t.dataUrl}" alt="${t.sku.label}" />
      </div>
      <div class="cell-label">${t.sku.label}</div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --cream:    ${CREAM};
      --charcoal: #2E2A26;
      --slate:    #6B6357;
      --stone:    #A89F92;
      --sand:     #D6CFC4;
      --font:     'Inter', system-ui, -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      font-family: var(--font);
      color: var(--charcoal);
      background: var(--cream);
    }
    .composite {
      width: 1500px;
      height: 1500px;
      padding: 60px;
      background: var(--cream);
      display: flex;
      flex-direction: column;
      gap: 30px;
    }
    .composite-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 0 10px 12px;
      border-bottom: 1px solid var(--stone);
    }
    .composite-title {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.32em;
      text-transform: uppercase;
    }
    .composite-sub {
      font-size: 12px;
      font-weight: 400;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      color: var(--stone);
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: auto auto;
      gap: 36px 30px;
      justify-items: center;
      align-content: start;
    }
    .cell {
      display: flex;
      flex-direction: column;
      gap: 14px;
      align-items: center;
      width: 100%;
    }
    /* Explicit fixed height + max-width on .thumb-wrap is the
       reliable way to constrain an <img> inside a CSS grid cell.
       flex:1 + max-height:100% on the img is fragile because the
       parent's intrinsic content height (the image at natural size)
       fights the flex shrink rules. Fixing the wrap height makes
       the layout deterministic — 600px clears Letter (464×600) and
       A4 (424×600) at our composite scale with margin to spare. */
    .thumb-wrap {
      width: 100%;
      height: 600px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--cream);
    }
    .thumb {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
      border: 1px solid var(--sand);
      box-shadow: 0 1px 0 rgba(46, 42, 38, 0.04);
      display: block;
    }
    .cell-label {
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--charcoal);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="composite">
    <div class="composite-header">
      <div class="composite-title">What's Included</div>
      <div class="composite-sub">4 versions · Letter + A4 · Sun + Mon start</div>
    </div>
    <div class="grid">
      ${cellsHtml}
    </div>
  </div>
</body>
</html>`;
}

// ------------------------------------------------------------------
// main
// ------------------------------------------------------------------
async function main(): Promise<void> {
  const overallStart = Date.now();
  console.log('> rendering HillwardStudio meal planner listing photos (3 programmatic)');
  console.log(`  source:  ${TEMPLATE_HTML}`);
  console.log(`  output:  ${PHOTOS_DIR}`);
  console.log('');

  mkdirSync(PHOTOS_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });
  try {
    const pdfPreview      = await renderPdfPreview(browser);
    const aisleDetail     = await renderAisleDetail(browser);
    const whatsIncluded   = await renderWhatsIncluded(browser);

    const results = [pdfPreview, aisleDetail, whatsIncluded];
    for (const r of results) {
      console.log(
        `  ✓ ${r.filename.padEnd(28)} ${String(r.widthPx).padStart(4)}×${String(r.heightPx).padEnd(4)} ${r.sizeKb.toFixed(1).padStart(7)} KB`
      );
    }
    console.log('');
    console.log(`✓ rendered ${results.length} photos in ${Date.now() - overallStart} ms`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('');
  console.error('✗ meal-planner-photos render failed');
  console.error('  message:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error('  stack:');
    console.error(err.stack);
  }
  process.exit(1);
});
