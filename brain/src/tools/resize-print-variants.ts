// Print-size variant generator — produces the 5 sized JPGs from a master PNG.
//
// This is the legacy CLI from before the full bundle pipeline shipped. It is
// preserved as a working entry point for cases where the operator only wants
// the sized variants (no PDFs, no transparent PNG, no fal call). For the
// complete deliverable bundle a v2 brief promises, use:
//
//   npm run build:bundle -- --master=<path> --product=<slug>
//
// The underlying VARIANT definitions, crop coords, and sharp ops all live in
// `brain/src/lib/print-bundle.ts` — single source of truth.
//
// Each variant produced is registered in the `assets` table with
// kind='print_variant', source='resize_print'. Pass --product-brief-id or
// --listing-id to FK the assets rows to a brief / listing.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSizedJpgVariants } from '../lib/print-bundle.js';
import { insertAsset } from '../lib/assets.js';
import { log } from '../lib/log.js';

interface ParsedArgs {
  input?: string;
  outputDir?: string;
  namePrefix?: string;
  productBriefId?: string;
  listingId?: string;
  registerAssets?: boolean;
  _help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  // Back-compat: positional args are still accepted, so the historic
  // `tsx src/tools/resize-print-variants.ts <input.png> [output-dir]` invocation
  // keeps working.
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out._help = true;
      continue;
    }
    if (arg === '--no-register') {
      out.registerAssets = false;
      continue;
    }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) {
      const [, key, rawVal] = m;
      const val = rawVal ?? '';
      switch (key) {
        case 'input':            out.input = val; break;
        case 'output-dir':       out.outputDir = val; break;
        case 'name-prefix':      out.namePrefix = val; break;
        case 'product-brief-id': out.productBriefId = val; break;
        case 'listing-id':       out.listingId = val; break;
        default:                 console.warn(`> ignoring unknown flag: --${key}`);
      }
      continue;
    }
    positional.push(arg);
  }

  if (!out.input && positional[0]) out.input = positional[0];
  if (!out.outputDir && positional[1]) out.outputDir = positional[1];

  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage:');
  console.error('  npm run resize:print -- --input=<path> [options]');
  console.error('  tsx src/tools/resize-print-variants.ts <input.png> [output-dir]   (legacy positional form)');
  console.error('');
  console.error('Required:');
  console.error('  --input=<path>            Master PNG (must be ≥5008×6680 px)');
  console.error('');
  console.error('Optional:');
  console.error('  --output-dir=<path>       Default: same dir as input');
  console.error('  --name-prefix=<str>       Default: HillwardStudio-BunnyPrint');
  console.error('  --product-brief-id=<uuid> FK to product_briefs.id on each assets row');
  console.error('  --listing-id=<uuid>       FK to listings.id on each assets row');
  console.error('  --no-register             Skip writing rows to the assets table');
  console.error('');
  console.error('NOTE: This only produces the 5 sized JPG variants. For the full');
  console.error('deliverable bundle (master JPG + sized JPGs + print-bundle PDF +');
  console.error('transparent PNG + ratio-guide PDF), use:');
  console.error('');
  console.error('  npm run build:bundle -- --master=<path> --product=<slug>');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help || !parsed.input) usage();

  const inputPath = parsed.input!;
  const outputDir = parsed.outputDir ?? path.dirname(inputPath);
  const namePrefix = parsed.namePrefix ?? 'HillwardStudio-BunnyPrint';

  console.log(`> master: ${path.basename(inputPath)}`);
  console.log(`> output: ${outputDir}`);
  console.log('');

  const { variants, totalSizeMb } = await buildSizedJpgVariants(
    inputPath,
    outputDir,
    namePrefix
  );

  for (const v of variants) {
    console.log(
      `  ✓  ${path.basename(v.outputPath)}  —  ${v.width} × ${v.height} px  —  ${v.sizeMb.toFixed(2)} MB`
    );
  }
  console.log('');
  console.log(`✓ ${variants.length} variants written to ${outputDir} (${totalSizeMb.toFixed(2)} MB total)`);

  // ----- Asset registry --------------------------------------------------
  // One row per variant. Skipped via --no-register.
  if (parsed.registerAssets !== false) {
    let registered = 0;
    for (const v of variants) {
      const row = await insertAsset({
        kind: 'print_variant',
        source: 'resize_print',
        listing_id: parsed.listingId,
        product_brief_id: parsed.productBriefId,
        local_path: v.outputPath,
        width: v.width,
        height: v.height,
        metadata: {
          tool: 'resize-print-variants',
          name_prefix: namePrefix,
          size_name: v.size.name,
          ratio: v.size.ratio,
          size_mb: Number(v.sizeMb.toFixed(2)),
          source_master: path.resolve(inputPath),
        },
      });
      if (row) registered += 1;
    }
    console.log(`> registered ${registered}/${variants.length} variant${variants.length === 1 ? '' : 's'} in assets`);

    await log({
      agent: 'product',
      action: 'asset.batch_registered',
      description: `Registered ${registered} print_variant rows from resize-print-variants`,
      severity: registered === variants.length ? 'success' : 'warning',
      metadata: {
        tool: 'resize-print-variants',
        input_path: path.resolve(inputPath),
        output_dir: outputDir,
        name_prefix: namePrefix,
        variant_count: variants.length,
        registered_count: registered,
        product_brief_id: parsed.productBriefId,
        listing_id: parsed.listingId,
      },
    }).catch(() => { /* best-effort */ });
  }
}

const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error('');
    console.error(`✗ resize-print-variants failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
