import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, statSync } from 'node:fs';
import puppeteer from 'puppeteer';

export interface RenderGraphicResult {
  inputPath: string;
  outputPath: string;
  sizeKb: number;
  durationMs: number;
}

export interface RenderGraphicOptions {
  inputPath: string;
  outputPath: string;
  /** When true, suppress progress logs (refine loop prints its own). */
  quiet?: boolean;
}

/**
 * Render an HTML file to PNG/JPEG via headless Puppeteer.
 * Shared by `render:graphic` CLI and `refine:graphic` loop.
 */
export async function renderGraphic(
  opts: RenderGraphicOptions
): Promise<RenderGraphicResult> {
  const absInput = path.resolve(opts.inputPath);
  const absOutput = path.resolve(opts.outputPath);
  mkdirSync(path.dirname(absOutput), { recursive: true });

  const start = Date.now();
  if (!opts.quiet) {
    console.log(`> rendering graphic`);
    console.log(`  input:  ${absInput}`);
    console.log(`  output: ${absOutput}`);
  }

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 2000, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(absInput).href, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');

    if (!opts.quiet) {
      const imgStatus = await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const imgs: any[] = Array.from((globalThis as any).document.querySelectorAll('img'));
        return imgs.map((img: any) => ({
          src: img.src as string,
          ok: (img.complete as boolean) && (img.naturalWidth as number) > 0,
        }));
      });
      for (const { src, ok } of imgStatus) {
        if (ok) console.log(`  ✓ image loaded: ${src}`);
        else console.warn(`  ✗ image FAILED to load: ${src}`);
      }
    }

    const ext = path.extname(absOutput).toLowerCase();
    const imgType = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';

    await page.screenshot({
      path: absOutput as `${string}.png`,
      fullPage: false,
      type: imgType,
      ...(imgType === 'jpeg' ? { quality: 92 } : {}),
    });
  } finally {
    await browser.close();
  }

  const sizeKb = statSync(absOutput).size / 1024;
  const durationMs = Date.now() - start;

  if (!opts.quiet) {
    console.log('');
    console.log(`✓ render complete`);
    console.log(`  output:   ${absOutput}`);
    console.log(`  size:     ${sizeKb.toFixed(1)} KB`);
    console.log(`  duration: ${durationMs} ms`);
  }

  return {
    inputPath: absInput,
    outputPath: absOutput,
    sizeKb,
    durationMs,
  };
}
