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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSizedJpgVariants } from '../lib/print-bundle.js';

function usage(): never {
  console.error('');
  console.error('Usage: tsx src/tools/resize-print-variants.ts <input.png> [output-dir]');
  console.error('');
  console.error('  input.png   — path to master PNG (must be ≥5008×6680 px)');
  console.error('  output-dir  — directory for output JPGs (default: same dir as input)');
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
  const inputPath = process.argv[2];
  if (!inputPath) usage();

  const outputDir = process.argv[3] ?? path.dirname(inputPath);
  const namePrefix = 'HillwardStudio-BunnyPrint';

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
