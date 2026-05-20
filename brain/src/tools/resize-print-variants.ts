import path from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Print-size variant definitions
// All coordinates/dimensions are in source-image pixels (5008 px wide master).
// ---------------------------------------------------------------------------
const VARIANTS = [
  { name: '8x10',  left: 0,   top: 210, width: 5008, height: 6260 },
  { name: '11x14', left: 0,   top: 153, width: 5008, height: 6374 },
  { name: '16x20', left: 0,   top: 210, width: 5008, height: 6260 }, // same crop as 8x10
  { name: '18x24', left: 0,   top: 0,   width: 5008, height: 6680 }, // full width
  { name: '24x36', left: 277, top: 0,   width: 4454, height: 6680 },
] as const;

const JPEG_QUALITY = 80;

function usage(): never {
  console.error('');
  console.error('Usage: tsx src/tools/resize-print-variants.ts <input.png> [output-dir]');
  console.error('');
  console.error('  input.png   — path to master PNG (must be ≥5008×6680 px)');
  console.error('  output-dir  — directory for output JPGs (default: same dir as input)');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) usage();

  const outputDir = process.argv[3] ?? path.dirname(inputPath);
  mkdirSync(outputDir, { recursive: true });

  // Validate input exists and get metadata before processing anything.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(inputPath).metadata();
  } catch (err) {
    console.error(`✗ Cannot read input file: ${inputPath}`);
    console.error(`  ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const { width: masterW = 0, height: masterH = 0 } = meta;
  console.log(`> master: ${path.basename(inputPath)} — ${masterW} × ${masterH} px`);
  console.log(`> output: ${outputDir}`);
  console.log('');

  // Warn if master is smaller than the largest variant we need.
  const maxNeededW = Math.max(...VARIANTS.map(v => v.left + v.width));
  const maxNeededH = Math.max(...VARIANTS.map(v => v.top + v.height));
  if (masterW < maxNeededW || masterH < maxNeededH) {
    console.error(
      `✗ Master too small: need at least ${maxNeededW}×${maxNeededH} px, got ${masterW}×${masterH} px`
    );
    process.exit(1);
  }

  let anyError = false;

  for (const v of VARIANTS) {
    const outName = `HillwardStudio-BunnyPrint-${v.name}.jpg`;
    const outPath = path.join(outputDir, outName);

    try {
      await sharp(inputPath)
        .extract({ left: v.left, top: v.top, width: v.width, height: v.height })
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(outPath);

      const sizeKb = statSync(outPath).size / 1024;
      const sizeMb = (sizeKb / 1024).toFixed(2);
      console.log(`  ✓  ${outName}  —  ${v.width} × ${v.height} px  —  ${sizeMb} MB`);
    } catch (err) {
      console.error(`  ✗  ${outName}  —  FAILED: ${err instanceof Error ? err.message : err}`);
      anyError = true;
    }
  }

  console.log('');
  if (anyError) {
    console.error('✗ One or more variants failed — check errors above.');
    process.exit(1);
  }
  console.log(`✓ All ${VARIANTS.length} variants written to ${outputDir}`);
}

main().catch(err => {
  console.error('');
  console.error('✗ Unexpected error:');
  console.error(`  ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
