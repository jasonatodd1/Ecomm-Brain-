import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, statSync } from 'node:fs';
import puppeteer from 'puppeteer';

// Resolve paths from this file's location so it doesn't depend on cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PRODUCT_DIR = path.join(
  PROJECT_ROOT,
  'products',
  'hillward-a5-monthly'
);
const INPUT_HTML = path.join(PRODUCT_DIR, 'template', 'index.html');
const OUTPUT_PDF = path.join(PRODUCT_DIR, 'dist', 'planner-v1.pdf');

async function render(): Promise<void> {
  const start = Date.now();
  console.log('> rendering HillwardStudio A5 monthly planner v1');
  console.log(`  input:  ${INPUT_HTML}`);
  console.log(`  output: ${OUTPUT_PDF}`);

  // dist/ is .gitignored, so it won't exist on a fresh clone — create it
  // before puppeteer tries to write into it.
  mkdirSync(path.dirname(OUTPUT_PDF), { recursive: true });

  // Puppeteer v22+ deprecated the `'new'` string in favor of `headless: true`,
  // which now uses the modern headless-Chrome mode by default. Same behavior
  // as the prompt's `'new'` spec, just the current valid value for v25.
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();

    // pathToFileURL handles spaces and unicode in the path correctly (this
    // workspace lives under "coding projects/Ecomm Bot/...").
    const fileUrl = pathToFileURL(INPUT_HTML).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle0' });

    // Hold for web fonts (Google Fonts <link> requests) to fully load.
    await page.evaluateHandle('document.fonts.ready');

    await page.pdf({
      path: OUTPUT_PDF,
      format: 'A5',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });

    const sizeKb = (statSync(OUTPUT_PDF).size / 1024).toFixed(1);
    const durationMs = Date.now() - start;
    console.log('');
    console.log('✓ render complete');
    console.log(`  output:   ${OUTPUT_PDF}`);
    console.log(`  size:     ${sizeKb} KB`);
    console.log(`  duration: ${durationMs} ms`);
  } finally {
    await browser.close();
  }
}

render().catch(err => {
  console.error('');
  console.error('✗ render failed');
  console.error('  message:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error('  stack:');
    console.error(err.stack);
  }
  process.exit(1);
});
