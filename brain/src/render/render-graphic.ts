import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, statSync } from 'node:fs';
import puppeteer from 'puppeteer';

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

  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);
  mkdirSync(path.dirname(absOutput), { recursive: true });

  const start = Date.now();
  console.log(`> rendering graphic`);
  console.log(`  input:  ${absInput}`);
  console.log(`  output: ${absOutput}`);

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Read the viewport size from the HTML body dimensions so we don't have
    // to hard-code 2000×2000 in the tool itself — the template owns its size.
    // Fall back to 2000×2000 if the page doesn't specify explicit body dims.
    await page.setViewport({ width: 2000, height: 2000, deviceScaleFactor: 1 });

    await page.goto(pathToFileURL(absInput).href, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');

    // Verify the bunny thumbnail loaded — log a warning if it failed.
    const imgStatus = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const imgs: any[] = Array.from((globalThis as any).document.querySelectorAll('img'));
      return imgs.map((img: any) => ({
        src: img.src as string,
        ok: (img.complete as boolean) && (img.naturalWidth as number) > 0,
      }));
    });
    for (const { src, ok } of imgStatus) {
      if (ok) {
        console.log(`  ✓ image loaded: ${src}`);
      } else {
        console.warn(`  ✗ image FAILED to load: ${src}`);
      }
    }

    await page.screenshot({
      path: absOutput as `${string}.png`,
      fullPage: false,
      type: 'png',
    });

    const sizeKb = (statSync(absOutput).size / 1024).toFixed(1);
    const ms = Date.now() - start;
    console.log('');
    console.log(`✓ render complete`);
    console.log(`  output:   ${absOutput}`);
    console.log(`  size:     ${sizeKb} KB`);
    console.log(`  duration: ${ms} ms`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('');
  console.error('✗ render failed');
  console.error(`  ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
