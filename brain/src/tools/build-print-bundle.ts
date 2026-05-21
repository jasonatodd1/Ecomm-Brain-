// Full deliverable-bundle builder.
//
// Reads a master image (typically the upscaled 5008×6680 print master) and
// writes ALL the artifacts a v2 ProductBrief promises a buyer:
//
//   1. master.jpg                  — full 5008×6680 JPG at 300 DPI
//   2. transparent.png             — background-removed version (fal birefnet/v2)
//   3. print-bundle.pdf            — multi-page PDF, one page per print size,
//                                    with crop marks for print-shop alignment
//   4. ratio-guide.pdf             — single-page reference (sizes + ratios +
//                                    frame recommendations + visual scale diagram)
//   5. sized/<prefix>-<size>.jpg   — the 5 sized JPG variants (8×10, 11×14,
//                                    16×20, 18×24, 24×36)
//
// One activity row per deliverable is written under
// `agent='product', action='asset.built'` so future agents (Listing Agent,
// performance/optimization) can look up exactly which assets exist on disk
// for a given product without inspecting the filesystem.
//
// CLI:
//   npm run build:bundle -- --master=<path> --product=<slug> [--name-prefix=...]
//
// Programmatic (for future agents):
//   import { buildPrintBundle } from '../tools/build-print-bundle.js';
//   const result = await buildPrintBundle({
//     masterPath: '...',
//     productSlug: 'hillward-nursery-bunny',
//   });
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import {
  buildMasterJpg,
  buildSizedJpgVariants,
  buildPrintBundlePdf,
  buildRatioGuidePdf,
  PRINT_SIZES,
} from '../lib/print-bundle.js';
import { removeBackground, formatFalValidationError } from '../lib/fal.js';
import { log } from '../lib/log.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface BuildPrintBundleOptions {
  /** Path to the 5008×6680 master PNG (e.g., the Clarity-upscaled output). */
  masterPath: string;
  /** Product slug, used for output dir + filename prefix. */
  productSlug: string;
  /**
   * Override the auto-derived filename prefix for sized variants.
   * Default: 'HillwardStudio-<TitleCasedSlugTail>'.
   */
  namePrefix?: string;
  /** Optional override of the output directory. Default: products/<slug>/deliverables/. */
  outputDir?: string;
  /** Optional FK to a product_briefs row, persisted on every activity row. */
  productBriefId?: string;
  /** Skip writing to the activity table (default: false). */
  logToActivity?: boolean;
  /** Skip the (slow + fal-dependent) background-removal step. Default: false. */
  skipTransparent?: boolean;
}

export interface BuildPrintBundleResult {
  outputDir: string;
  deliverables: DeliverableSummary[];
  totalCostUsd: number;
  totalDurationMs: number;
  totalSizeMb: number;
}

export interface DeliverableSummary {
  kind:
    | 'master_jpg'
    | 'sized_jpg_set'
    | 'print_bundle_pdf'
    | 'transparent_png'
    | 'ratio_guide_pdf';
  outputPath: string;
  /** For sized_jpg_set, this is the directory holding the 5 JPGs. */
  sizeMb: number;
  durationMs: number;
  costUsd: number;
  /** Per-kind extras (page count, dims, fal request id, etc.). */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------
export async function buildPrintBundle(
  opts: BuildPrintBundleOptions
): Promise<BuildPrintBundleResult> {
  const overallStart = Date.now();

  const outputDir =
    opts.outputDir ??
    path.join('products', opts.productSlug, 'deliverables');
  const sizedDir = path.join(outputDir, 'sized');
  await mkdir(sizedDir, { recursive: true });

  const namePrefix = opts.namePrefix ?? deriveNamePrefix(opts.productSlug);
  const productTitle = humanizeProductSlug(opts.productSlug);

  const deliverables: DeliverableSummary[] = [];

  // ----- 1. Master JPG ---------------------------------------------------
  console.log('> 1/5 master JPG (5008×6680 @ 300 DPI)');
  {
    const t0 = Date.now();
    const outPath = path.join(outputDir, 'master.jpg');
    const r = await buildMasterJpg(opts.masterPath, outPath);
    const dur = Date.now() - t0;
    const summary: DeliverableSummary = {
      kind: 'master_jpg',
      outputPath: r.outputPath,
      sizeMb: r.sizeMb,
      durationMs: dur,
      costUsd: 0,
      metadata: { width: r.width, height: r.height, dpi: r.dpi },
    };
    deliverables.push(summary);
    console.log(`     ${r.width}×${r.height} px — ${r.sizeMb.toFixed(2)} MB — ${(dur / 1000).toFixed(1)}s`);
    await maybeLog(opts, productTitle, summary);
  }

  // ----- 2. Sized JPG variants -------------------------------------------
  console.log(`> 2/5 sized JPG set (${PRINT_SIZES.length} variants → ${path.relative(process.cwd(), sizedDir)}/)`);
  let variantResults: Awaited<ReturnType<typeof buildSizedJpgVariants>>['variants'] = [];
  {
    const t0 = Date.now();
    const r = await buildSizedJpgVariants(
      opts.masterPath,
      sizedDir,
      namePrefix
    );
    variantResults = r.variants;
    const dur = Date.now() - t0;
    const summary: DeliverableSummary = {
      kind: 'sized_jpg_set',
      outputPath: sizedDir,
      sizeMb: r.totalSizeMb,
      durationMs: dur,
      costUsd: 0,
      metadata: {
        variants: r.variants.map(v => ({
          size: v.size.name,
          ratio: v.size.ratio,
          path: v.outputPath,
          width_px: v.width,
          height_px: v.height,
          size_mb: Number(v.sizeMb.toFixed(2)),
        })),
        total_size_mb: Number(r.totalSizeMb.toFixed(2)),
      },
    };
    deliverables.push(summary);
    for (const v of r.variants) {
      console.log(`     ✓ ${v.size.name}  ${v.width}×${v.height}  ${v.sizeMb.toFixed(2)} MB`);
    }
    console.log(`     total ${r.totalSizeMb.toFixed(2)} MB — ${(dur / 1000).toFixed(1)}s`);
    await maybeLog(opts, productTitle, summary);
  }

  // ----- 3. Print-bundle PDF ---------------------------------------------
  console.log('> 3/5 print-bundle PDF with crop marks');
  {
    const t0 = Date.now();
    const outPath = path.join(outputDir, 'print-bundle.pdf');
    const r = await buildPrintBundlePdf(variantResults, outPath, { productTitle });
    const dur = Date.now() - t0;
    const summary: DeliverableSummary = {
      kind: 'print_bundle_pdf',
      outputPath: r.outputPath,
      sizeMb: r.sizeMb,
      durationMs: dur,
      costUsd: 0,
      metadata: { page_count: r.pageCount, pages: PRINT_SIZES.map(s => s.name) },
    };
    deliverables.push(summary);
    console.log(`     ${r.pageCount} pages — ${r.sizeMb.toFixed(2)} MB — ${(dur / 1000).toFixed(1)}s`);
    await maybeLog(opts, productTitle, summary);
  }

  // ----- 4. Transparent PNG (fal birefnet/v2) ----------------------------
  if (opts.skipTransparent) {
    console.log('> 4/5 transparent PNG — SKIPPED (--skip-transparent)');
  } else {
    console.log('> 4/5 transparent PNG (fal-ai/birefnet/v2)');
    const t0 = Date.now();
    const outPath = path.join(outputDir, 'transparent.png');
    try {
      const r = await removeBackground({
        input: opts.masterPath,
        output: outPath,
      });
      const dur = Date.now() - t0;
      const { stat } = await import('node:fs/promises');
      const sizeMb = (await stat(outPath)).size / 1024 / 1024;
      const summary: DeliverableSummary = {
        kind: 'transparent_png',
        outputPath: outPath,
        sizeMb,
        durationMs: dur,
        costUsd: r.costUsd,
        metadata: {
          width: r.outputDimensions.width,
          height: r.outputDimensions.height,
          model: 'fal-ai/birefnet/v2',
          variant: r.variant,
          operating_resolution: r.operatingResolution,
          fal_request_id: r.falRequestId,
          fal_url: r.outputUrl,
        },
      };
      deliverables.push(summary);
      console.log(
        `     ${r.outputDimensions.width}×${r.outputDimensions.height} px — ${sizeMb.toFixed(2)} MB — ${(dur / 1000).toFixed(1)}s — $${r.costUsd.toFixed(3)}`
      );
      await maybeLog(opts, productTitle, summary);
    } catch (err) {
      const falMsg = formatFalValidationError(err);
      const msg = falMsg ?? (err instanceof Error ? err.message : String(err));
      console.error(`     ✗ transparent PNG failed: ${msg}`);
      if (opts.logToActivity !== false) {
        await log({
          agent: 'product',
          action: 'asset.build_failed',
          description: `transparent PNG (birefnet) failed for ${opts.productSlug}: ${msg}`,
          severity: 'error',
          metadata: {
            product_slug: opts.productSlug,
            kind: 'transparent_png',
            error: String(err),
            product_brief_id: opts.productBriefId,
          },
        }).catch(() => {
          /* best-effort */
        });
      }
      throw err;
    }
  }

  // ----- 5. Ratio-guide PDF ----------------------------------------------
  console.log('> 5/5 ratio-guide PDF (US Letter, 1 page)');
  {
    const t0 = Date.now();
    const outPath = path.join(outputDir, 'ratio-guide.pdf');
    const r = await buildRatioGuidePdf(outPath, { productTitle });
    const dur = Date.now() - t0;
    const summary: DeliverableSummary = {
      kind: 'ratio_guide_pdf',
      outputPath: r.outputPath,
      sizeMb: r.sizeMb,
      durationMs: dur,
      costUsd: 0,
      metadata: { page_count: 1, page_size: 'US Letter' },
    };
    deliverables.push(summary);
    console.log(`     ${r.sizeMb.toFixed(2)} MB — ${(dur / 1000).toFixed(1)}s`);
    await maybeLog(opts, productTitle, summary);
  }

  const totalCostUsd = deliverables.reduce((sum, d) => sum + d.costUsd, 0);
  const totalDurationMs = Date.now() - overallStart;
  const totalSizeMb = deliverables.reduce((sum, d) => sum + d.sizeMb, 0);

  return {
    outputDir,
    deliverables,
    totalCostUsd,
    totalDurationMs,
    totalSizeMb,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function maybeLog(
  opts: BuildPrintBundleOptions,
  productTitle: string,
  summary: DeliverableSummary
): Promise<void> {
  if (opts.logToActivity === false) return;
  await log({
    agent: 'product',
    action: 'asset.built',
    description: `Built ${summary.kind} for ${productTitle}`,
    severity: 'success',
    metadata: {
      product_slug: opts.productSlug,
      product_brief_id: opts.productBriefId,
      kind: summary.kind,
      path: summary.outputPath,
      size_mb: Number(summary.sizeMb.toFixed(2)),
      duration_ms: summary.durationMs,
      cost_usd: summary.costUsd,
      ...summary.metadata,
    },
  }).catch(err => {
    // log() already prints [ACTIVITY_LOG_FAILED] for us; we just don't want
    // a logging failure to abort the bundle.
    console.error(`     (activity log failed for ${summary.kind}: ${err instanceof Error ? err.message : String(err)})`);
  });
}

function deriveNamePrefix(slug: string): string {
  // hillward-nursery-bunny → HillwardStudio-NurseryBunny
  const titleCased = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(p => p[0].toUpperCase() + p.slice(1))
    .join('');
  // Strip leading "Hillward" so the prefix reads "HillwardStudio-<rest>"
  // when the slug is one of our hillward-* products.
  if (titleCased.toLowerCase().startsWith('hillward')) {
    return `HillwardStudio-${titleCased.slice('Hillward'.length)}`;
  }
  return `HillwardStudio-${titleCased}`;
}

function humanizeProductSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map(p => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface ParsedArgs {
  master?: string;
  product?: string;
  namePrefix?: string;
  outputDir?: string;
  productBriefId?: string;
  skipTransparent?: boolean;
  _help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out._help = true;
      continue;
    }
    if (arg === '--skip-transparent') {
      out.skipTransparent = true;
      continue;
    }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal ?? '';
    switch (key) {
      case 'master':            out.master = val; break;
      case 'product':           out.product = val; break;
      case 'name-prefix':       out.namePrefix = val; break;
      case 'output-dir':        out.outputDir = val; break;
      case 'product-brief-id':  out.productBriefId = val; break;
      default:                  console.warn(`> ignoring unknown flag: --${key}`);
    }
  }
  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage: npm run build:bundle -- --master=<path> --product=<slug> [options]');
  console.error('');
  console.error('Required:');
  console.error('  --master=<path>           Path to 5008×6680 master PNG');
  console.error('  --product=<slug>          Product slug (e.g., hillward-nursery-bunny)');
  console.error('');
  console.error('Optional:');
  console.error('  --name-prefix=<str>       Filename prefix for sized variants');
  console.error('                            (default: HillwardStudio-<TitleCasedSlug>)');
  console.error('  --output-dir=<path>       Override output dir');
  console.error('                            (default: products/<slug>/deliverables/)');
  console.error('  --product-brief-id=<uuid> FK to product_briefs.id, attached to every activity row');
  console.error('  --skip-transparent        Skip the fal birefnet call (faster local iteration)');
  console.error('');
  console.error('Produces:');
  console.error('  <output-dir>/master.jpg           (5008×6680 @ 300 DPI)');
  console.error('  <output-dir>/sized/<prefix>-*.jpg (5 print-size variants)');
  console.error('  <output-dir>/print-bundle.pdf     (multi-page, one per size, with crop marks)');
  console.error('  <output-dir>/transparent.png      (background removed via fal-ai/birefnet/v2)');
  console.error('  <output-dir>/ratio-guide.pdf      (single-page reference)');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help || !parsed.master || !parsed.product) usage();

  console.log('> build-print-bundle');
  console.log(`> master:  ${parsed.master}`);
  console.log(`> product: ${parsed.product}`);
  console.log('');

  const result = await buildPrintBundle({
    masterPath: parsed.master!,
    productSlug: parsed.product!,
    namePrefix: parsed.namePrefix,
    outputDir: parsed.outputDir,
    productBriefId: parsed.productBriefId,
    skipTransparent: parsed.skipTransparent,
  });

  console.log('');
  console.log(`✓ bundle complete — ${result.deliverables.length} deliverables`);
  console.log(`> output dir:   ${result.outputDir}`);
  console.log(`> total size:   ${result.totalSizeMb.toFixed(2)} MB`);
  console.log(`> total cost:   $${result.totalCostUsd.toFixed(3)}`);
  console.log(`> duration:     ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log('');
}

const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  main().catch(async (err: unknown) => {
    const falMsg = formatFalValidationError(err);
    const message = falMsg ?? (err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(`✗ build-print-bundle failed: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
