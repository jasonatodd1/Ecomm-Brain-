// Print-bundle deliverable builders.
//
// This module is the shared engine behind both the legacy
// `src/tools/resize-print-variants.ts` CLI (which only produces the sized
// JPG set) and the full-bundle orchestrator `src/tools/build-print-bundle.ts`.
//
// All functions are pure: they take a source path + an output path, write the
// deliverable to disk, and return structured metadata. They do NOT log to the
// activity table — the orchestrator does that so it can attach product +
// deliverable context per row.
//
// Conventions:
//   - All print sizes are imperial (inches), at 300 DPI for print resolution.
//   - VARIANT crop coordinates target a 5008×6680 px master (the standard
//     output of the bunny pipeline: 1728×2304 FLUX gen → 5008×6680 Clarity
//     upscale). Other masters at the same dimensions work; smaller masters
//     are rejected by `buildSizedJpgVariants`.
//   - PDFs are built with pdf-lib (no headless browser needed).
//   - PNG / JPG ops use sharp.

import path from 'node:path';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

// ---------------------------------------------------------------------------
// Print-size catalog
// ---------------------------------------------------------------------------
// Imperial dimensions (inches) drive the print-bundle PDF page sizes and the
// ratio-guide PDF labels. Pixel-space crop coordinates target the canonical
// 5008×6680 master. Two ratios are covered:
//   - 4:5   (8×10, 16×20)
//   - 11:14 (11×14) — extremely close to 4:5; treated as its own ratio for
//                     buyer clarity since 11×14 frames are widely sold
//   - 2:3   (18×24, 24×36) — note 18×24 is exactly 3:4; we treat it as 2:3
//                            for grouping since buyers shop for "3:4 vs 2:3
//                            frames", and 18×24 sits in the 2:3-frame aisle
//                            in practice. (Confirmed against bunny brief.)
//
// CORRECTION: 18×24 is 3:4 (= 18:24 = 3:4). Keeping the ratio label honest.
const PT_PER_INCH = 72;

export interface PrintSize {
  /** e.g. '8x10' — used as filename suffix. */
  name: string;
  /** Human-facing ratio shown on the ratio guide. */
  ratio: '4:5' | '11:14' | '3:4' | '2:3';
  /** Trim dimensions in inches. */
  inches: { w: number; h: number };
  /** Crop coordinates in source-master pixel space (5008×6680). */
  cropPx: { left: number; top: number; width: number; height: number };
}

export const PRINT_SIZES: readonly PrintSize[] = [
  {
    name:   '8x10',
    ratio:  '4:5',
    inches: { w: 8,  h: 10 },
    cropPx: { left: 0,   top: 210, width: 5008, height: 6260 },
  },
  {
    name:   '11x14',
    ratio:  '11:14',
    inches: { w: 11, h: 14 },
    cropPx: { left: 0,   top: 153, width: 5008, height: 6374 },
  },
  {
    name:   '16x20',
    ratio:  '4:5',
    inches: { w: 16, h: 20 },
    cropPx: { left: 0,   top: 210, width: 5008, height: 6260 },
  },
  {
    name:   '18x24',
    ratio:  '3:4',
    inches: { w: 18, h: 24 },
    cropPx: { left: 0,   top: 0,   width: 5008, height: 6680 },
  },
  {
    name:   '24x36',
    ratio:  '2:3',
    inches: { w: 24, h: 36 },
    cropPx: { left: 277, top: 0,   width: 4454, height: 6680 },
  },
] as const;

export const MASTER_WIDTH_PX = 5008;
export const MASTER_HEIGHT_PX = 6680;
export const PRINT_DPI = 300;

// JPEG quality for the print-ready outputs. 92 = visually transparent on
// continuous-tone watercolor art while keeping per-size files under ~6 MB
// (the print-bundle PDF embeds these so file size compounds).
const JPEG_QUALITY = 92;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function fileSizeMb(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.size / 1024 / 1024;
}

async function validateMasterDimensions(masterPath: string): Promise<{
  width: number;
  height: number;
}> {
  const meta = await sharp(masterPath).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < MASTER_WIDTH_PX || h < MASTER_HEIGHT_PX) {
    throw new Error(
      `Master image too small: need at least ${MASTER_WIDTH_PX}×${MASTER_HEIGHT_PX} px, ` +
        `got ${w}×${h} px (${masterPath})`
    );
  }
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// Deliverable 1: master JPG
// ---------------------------------------------------------------------------
export interface MasterJpgResult {
  outputPath: string;
  width: number;
  height: number;
  sizeMb: number;
  dpi: number;
}

/**
 * Export the master PNG as a print-ready JPEG at 300 DPI density.
 *
 * Sharp's `withMetadata({ density })` embeds the DPI hint in the JPEG EXIF
 * block so print software (Photoshop, Preview, print shops) reads it as
 * 300 DPI rather than the default 72. Pixel dimensions are unchanged.
 */
export async function buildMasterJpg(
  masterPath: string,
  outputPath: string
): Promise<MasterJpgResult> {
  await ensureParentDir(outputPath);
  const { width, height } = await validateMasterDimensions(masterPath);

  await sharp(masterPath)
    .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
    .withMetadata({ density: PRINT_DPI })
    .toFile(outputPath);

  return {
    outputPath,
    width,
    height,
    sizeMb: await fileSizeMb(outputPath),
    dpi: PRINT_DPI,
  };
}

// ---------------------------------------------------------------------------
// Deliverable 2: sized JPG variant set
// ---------------------------------------------------------------------------
export interface SizedVariantResult {
  size: PrintSize;
  outputPath: string;
  width: number;
  height: number;
  sizeMb: number;
}

export interface SizedVariantsResult {
  variants: SizedVariantResult[];
  totalSizeMb: number;
}

/**
 * Produce all 5 print-size JPG variants from a 5008×6680 master.
 * Outputs land at `<outputDir>/<namePrefix>-<size>.jpg`.
 *
 * Throws if the master is smaller than 5008×6680 (would silently upscale).
 */
export async function buildSizedJpgVariants(
  masterPath: string,
  outputDir: string,
  namePrefix: string
): Promise<SizedVariantsResult> {
  await mkdir(outputDir, { recursive: true });
  await validateMasterDimensions(masterPath);

  const variants: SizedVariantResult[] = [];
  let totalSizeMb = 0;

  for (const size of PRINT_SIZES) {
    const outputPath = path.join(outputDir, `${namePrefix}-${size.name}.jpg`);
    await sharp(masterPath)
      .extract(size.cropPx)
      .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: '4:4:4' })
      .withMetadata({ density: PRINT_DPI })
      .toFile(outputPath);

    const sizeMb = await fileSizeMb(outputPath);
    totalSizeMb += sizeMb;
    variants.push({
      size,
      outputPath,
      width: size.cropPx.width,
      height: size.cropPx.height,
      sizeMb,
    });
  }

  return { variants, totalSizeMb };
}

// ---------------------------------------------------------------------------
// Deliverable 3: multi-page print-bundle PDF with crop marks
// ---------------------------------------------------------------------------
export interface PrintBundlePdfResult {
  outputPath: string;
  pageCount: number;
  sizeMb: number;
}

/**
 * Build a multi-page PDF — one page per print size — with the corresponding
 * sized JPG embedded at trim size and crop marks drawn at each corner of the
 * trim box.
 *
 * Page layout per size:
 *   - Page size = trim dims + 0.5 inch of margin on each side (0.25 each).
 *     This gives the buyer room to send the file to a print shop that
 *     prints onto stock larger than the trim, then cuts down. The crop
 *     marks define where to cut.
 *   - Image fills exactly the trim box (centered on the page).
 *   - Crop marks: 4 corner marks, each a pair of 0.25-inch lines extending
 *     outward from the trim corner, with a 0.0625-inch gap from the trim
 *     edge so they're cleanly visible against the image.
 *
 * Requires the sized variants to already exist on disk (call
 * `buildSizedJpgVariants` first).
 */
export async function buildPrintBundlePdf(
  variants: SizedVariantResult[],
  outputPath: string,
  options: { productTitle?: string } = {}
): Promise<PrintBundlePdfResult> {
  await ensureParentDir(outputPath);

  const pdf = await PDFDocument.create();
  pdf.setTitle(options.productTitle ?? 'Print bundle with crop marks');
  pdf.setCreator('HillwardStudio asset pipeline');
  pdf.setProducer('pdf-lib via brain/src/lib/print-bundle.ts');

  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const v of variants) {
    const trimW = v.size.inches.w * PT_PER_INCH;
    const trimH = v.size.inches.h * PT_PER_INCH;
    const marginPt = 0.25 * PT_PER_INCH;
    const pageW = trimW + 2 * marginPt;
    const pageH = trimH + 2 * marginPt;

    const page = pdf.addPage([pageW, pageH]);

    // Embed JPG and draw at trim dims.
    const jpgBytes = await readFile(v.outputPath);
    const embedded = await pdf.embedJpg(jpgBytes);
    page.drawImage(embedded, {
      x: marginPt,
      y: marginPt,
      width: trimW,
      height: trimH,
    });

    drawCropMarks(page, marginPt, marginPt, trimW, trimH);

    // Footer label so a buyer or print-shop operator can identify
    // each page without opening it in software that shows the trim box.
    drawFooterLabel(page, font, v.size, marginPt);
  }

  const bytes = await pdf.save();
  await writeFile(outputPath, bytes);

  return {
    outputPath,
    pageCount: variants.length,
    sizeMb: await fileSizeMb(outputPath),
  };
}

function drawCropMarks(
  page: PDFPage,
  trimX: number,
  trimY: number,
  trimW: number,
  trimH: number
): void {
  // 0.25-inch crop marks, with a 0.0625-inch gap from the trim corner so
  // they don't paint over the image. Pure black, 0.5 pt stroke for clean
  // print rendering.
  const markLen = 0.25 * PT_PER_INCH;
  const markGap = 0.0625 * PT_PER_INCH;
  const stroke = 0.5;
  const black = rgb(0, 0, 0);

  const corners = [
    { x: trimX,         y: trimY,         hDir: -1, vDir: -1 }, // bottom-left
    { x: trimX + trimW, y: trimY,         hDir:  1, vDir: -1 }, // bottom-right
    { x: trimX,         y: trimY + trimH, hDir: -1, vDir:  1 }, // top-left
    { x: trimX + trimW, y: trimY + trimH, hDir:  1, vDir:  1 }, // top-right
  ];

  for (const c of corners) {
    // Horizontal mark extending outward
    page.drawLine({
      start: { x: c.x + c.hDir * markGap,             y: c.y },
      end:   { x: c.x + c.hDir * (markGap + markLen), y: c.y },
      thickness: stroke,
      color: black,
    });
    // Vertical mark extending outward
    page.drawLine({
      start: { x: c.x, y: c.y + c.vDir * markGap },
      end:   { x: c.x, y: c.y + c.vDir * (markGap + markLen) },
      thickness: stroke,
      color: black,
    });
  }
}

function drawFooterLabel(
  page: PDFPage,
  font: PDFFont,
  size: PrintSize,
  marginPt: number
): void {
  const fontSize = 7;
  const label = `${size.inches.w}×${size.inches.h}" — ratio ${size.ratio} — print at 100% scale — crop marks indicate trim`;
  const textWidth = font.widthOfTextAtSize(label, fontSize);
  page.drawText(label, {
    x: (page.getWidth() - textWidth) / 2,
    y: marginPt / 2 - fontSize / 2,
    size: fontSize,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });
}

// ---------------------------------------------------------------------------
// Deliverable 4: single-page ratio-guide PDF
// ---------------------------------------------------------------------------
export interface RatioGuidePdfResult {
  outputPath: string;
  sizeMb: number;
}

/**
 * Build a single-page reference PDF showing all 5 print sizes drawn to scale,
 * each labeled with its trim dimensions, ratio, and the standard frame size
 * a buyer should shop for. Page size: US Letter (8.5×11"), the most common
 * home-printer paper so a buyer can print it and use it as a tactile
 * reference.
 *
 * Layout: title at top; legend block listing all 5 sizes + ratios + frame
 * recommendations; a scale-diagram region showing nested outlined boxes
 * representing the 5 sizes relative to one another so the buyer can see at
 * a glance how much wall space each size occupies.
 */
export async function buildRatioGuidePdf(
  outputPath: string,
  options: { productTitle?: string } = {}
): Promise<RatioGuidePdfResult> {
  await ensureParentDir(outputPath);

  const pdf = await PDFDocument.create();
  pdf.setTitle('Print size & ratio guide');
  pdf.setCreator('HillwardStudio asset pipeline');
  pdf.setProducer('pdf-lib via brain/src/lib/print-bundle.ts');

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // US Letter, portrait
  const pageW = 8.5 * PT_PER_INCH;
  const pageH = 11 * PT_PER_INCH;
  const page = pdf.addPage([pageW, pageH]);

  const margin = 0.6 * PT_PER_INCH;
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.45, 0.45, 0.45);

  // ---- Title ----
  let cursorY = pageH - margin;
  const productTitle = options.productTitle ?? 'HillwardStudio print';
  page.drawText('PRINT SIZE & RATIO GUIDE', {
    x: margin,
    y: cursorY - 14,
    size: 14,
    font: helvBold,
    color: ink,
  });
  cursorY -= 14 + 6;
  page.drawText(productTitle, {
    x: margin,
    y: cursorY - 9,
    size: 9,
    font: helv,
    color: muted,
  });
  cursorY -= 9 + 18;

  // ---- Legend block ----
  page.drawText('Included sizes', {
    x: margin,
    y: cursorY - 10,
    size: 10,
    font: helvBold,
    color: ink,
  });
  cursorY -= 10 + 8;

  const legendRowH = 14;
  const colTrim = margin;
  const colRatio = margin + 1.1 * PT_PER_INCH;
  const colFrame = margin + 2.1 * PT_PER_INCH;

  // Column headers
  page.drawText('Size', { x: colTrim, y: cursorY - 8, size: 8, font: helvBold, color: muted });
  page.drawText('Ratio', { x: colRatio, y: cursorY - 8, size: 8, font: helvBold, color: muted });
  page.drawText('Frame to buy', { x: colFrame, y: cursorY - 8, size: 8, font: helvBold, color: muted });
  cursorY -= 8 + 4;

  // Thin rule under headers
  page.drawLine({
    start: { x: margin, y: cursorY },
    end:   { x: pageW - margin, y: cursorY },
    thickness: 0.5,
    color: muted,
  });
  cursorY -= 6;

  for (const s of PRINT_SIZES) {
    page.drawText(`${s.inches.w}×${s.inches.h}"`, {
      x: colTrim,
      y: cursorY - 9,
      size: 9,
      font: helv,
      color: ink,
    });
    page.drawText(s.ratio, {
      x: colRatio,
      y: cursorY - 9,
      size: 9,
      font: helv,
      color: ink,
    });
    page.drawText(`Standard ${s.inches.w}×${s.inches.h}" frame`, {
      x: colFrame,
      y: cursorY - 9,
      size: 9,
      font: helv,
      color: ink,
    });
    cursorY -= legendRowH;
  }

  cursorY -= 12;

  // ---- Scale diagram ----
  page.drawText('Visual scale comparison', {
    x: margin,
    y: cursorY - 10,
    size: 10,
    font: helvBold,
    color: ink,
  });
  cursorY -= 10 + 10;

  // Available area for the diagram
  const diagramTop = cursorY;
  const diagramBottom = margin + 0.6 * PT_PER_INCH;
  const diagramH = diagramTop - diagramBottom;
  const diagramW = pageW - 2 * margin;

  // Fit the largest size (24×36) into the diagram bounds at uniform scale.
  // Then draw each size as an outlined rectangle anchored at the same
  // bottom-left corner so the buyer can see how each size nests inside the
  // largest one.
  const largest = PRINT_SIZES.reduce(
    (a, b) =>
      a.inches.w * a.inches.h > b.inches.w * b.inches.h ? a : b
  );
  const scale = Math.min(
    diagramW / largest.inches.w,
    diagramH / largest.inches.h
  );

  const anchorX = margin + (diagramW - largest.inches.w * scale) / 2;
  const anchorY = diagramBottom;

  // Draw largest to smallest so the smallest rectangle's outline stays
  // visible on top.
  const ordered = [...PRINT_SIZES].sort(
    (a, b) => b.inches.w * b.inches.h - a.inches.w * a.inches.h
  );

  for (const s of ordered) {
    const w = s.inches.w * scale;
    const h = s.inches.h * scale;
    page.drawRectangle({
      x: anchorX,
      y: anchorY,
      width: w,
      height: h,
      borderColor: ink,
      borderWidth: 0.7,
    });
    // Label sits at the top-right corner of each outlined box.
    const labelSize = 7;
    const label = `${s.inches.w}×${s.inches.h}"`;
    const lw = helv.widthOfTextAtSize(label, labelSize);
    page.drawText(label, {
      x: anchorX + w - lw - 2,
      y: anchorY + h - labelSize - 2,
      size: labelSize,
      font: helv,
      color: ink,
    });
  }

  // ---- Footer note ----
  const footerText =
    'Each rectangle above is drawn to scale — the largest box is 24×36" actual proportion. ' +
    'Print this page at 100% (no scaling) on US Letter to use it as a tactile frame-size reference.';
  const footerSize = 7;
  // Word-wrap by hand at a rough char count; the string is short.
  const words = footerText.split(' ');
  const maxLineWidth = pageW - 2 * margin;
  let line = '';
  let y = margin + 0.05 * PT_PER_INCH;
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (helv.widthOfTextAtSize(candidate, footerSize) > maxLineWidth) {
      page.drawText(line, {
        x: margin,
        y,
        size: footerSize,
        font: helv,
        color: muted,
      });
      y -= footerSize + 2;
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) {
    page.drawText(line, {
      x: margin,
      y,
      size: footerSize,
      font: helv,
      color: muted,
    });
  }

  const bytes = await pdf.save();
  await writeFile(outputPath, bytes);

  return {
    outputPath,
    sizeMb: await fileSizeMb(outputPath),
  };
}
