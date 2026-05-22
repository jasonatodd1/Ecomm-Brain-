import { renderGraphic } from '../lib/render-graphic.js';

function usage(): never {
  console.error('');
  console.error('Usage: tsx src/render/render-graphic.ts <input.html> <output.png>');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) usage();

  await renderGraphic({ inputPath, outputPath });
}

main().catch(err => {
  console.error('');
  console.error('✗ render failed');
  console.error(`  ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
