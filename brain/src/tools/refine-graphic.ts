// refine-graphic — render → vision-critique → revise → re-render loop.
//
// Usage:
//   npm run refine:graphic -- \
//     --html=path/to/template.html \
//     --out=path/to/output.png \
//     --rubric=path/to/rubric.md \
//     [--max-iter=6]
//
// Intermediate renders land in dist/refine-graphic/<slug>/ (gitignored).
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderGraphic } from '../lib/render-graphic.js';

const VISION_MODEL = 'claude-sonnet-4-6';
/** Approximate Sonnet 4.6 list pricing (USD per million tokens). */
const INPUT_USD_PER_M = 3.0;
const OUTPUT_USD_PER_M = 15.0;

interface ParsedArgs {
  html?: string;
  out?: string;
  rubric?: string;
  maxIter: number;
  _help?: boolean;
}

interface CritiqueMeta {
  verdict: 'PASS' | 'REVISE';
  critique: string;
  change_summary: string;
  quality_score?: number;
}

export interface IterationLogEntry {
  iteration: number;
  verdict: 'PASS' | 'REVISE' | 'PARSE_ERROR';
  critique: string;
  change_summary: string;
  quality_score: number | null;
  render_path: string;
  html_path: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  parse_error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { maxIter: 6 };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out._help = true;
      continue;
    }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, val = ''] = m;
    switch (key) {
      case 'html':
        out.html = val;
        break;
      case 'out':
        out.out = val;
        break;
      case 'rubric':
        out.rubric = val;
        break;
      case 'max-iter':
        out.maxIter = Math.max(1, Number(val) || 6);
        break;
      default:
        console.warn(`> ignoring unknown flag: --${key}`);
    }
  }
  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage: npm run refine:graphic -- \\');
  console.error('  --html=<path/to/template.html> \\');
  console.error('  --out=<path/to/output.png> \\');
  console.error('  --rubric=<path/to/rubric.md> \\');
  console.error('  [--max-iter=6]');
  console.error('');
  process.exit(1);
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

function getText(message: Anthropic.Message): string {
  const parts = message.content.filter(b => b.type === 'text');
  if (parts.length === 0) throw new Error('Vision response had no text block');
  return parts.map(p => (p.type === 'text' ? p.text : '')).join('\n');
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_M
  );
}

function extractMetaJson(raw: string): string | null {
  const delimited = raw.match(/<<<META>>>\s*([\s\S]*?)\s*(?:<<<HTML>>>|<<<END>>>)/i);
  if (delimited) return delimited[1]!.trim();

  const passTail = raw.match(/<<<META>>>\s*(\{[\s\S]*?\})\s*$/i);
  if (passTail) return passTail[1]!.trim();

  const looseJson = raw.match(/\{[\s\S]*?"verdict"\s*:\s*"(?:PASS|REVISE)"[\s\S]*?\}/i);
  return looseJson?.[0]?.trim() ?? null;
}

function inferQualityScore(meta: CritiqueMeta): number {
  if (typeof meta.quality_score === 'number' && !Number.isNaN(meta.quality_score)) {
    return Math.max(1, Math.min(10, meta.quality_score));
  }
  return meta.verdict === 'PASS' ? 10 : 5;
}

export type ParseVisionResult =
  | { ok: true; meta: CritiqueMeta; html?: string; qualityScore: number }
  | { ok: false; error: string };

export function parseVisionResponse(raw: string): ParseVisionResult {
  const metaText = extractMetaJson(raw);
  if (!metaText) {
    return {
      ok: false,
      error: `Missing META block. Raw head:\n${raw.slice(0, 500)}`,
    };
  }

  let metaJson: unknown;
  try {
    metaJson = JSON.parse(metaText);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse META JSON: ${(err as Error).message}\n${metaText.slice(0, 400)}`,
    };
  }

  const meta = metaJson as CritiqueMeta;
  if (meta.verdict !== 'PASS' && meta.verdict !== 'REVISE') {
    return {
      ok: false,
      error: `Invalid verdict: ${String((metaJson as CritiqueMeta).verdict)}`,
    };
  }

  if (!meta.critique || typeof meta.critique !== 'string') {
    meta.critique = meta.verdict === 'PASS' ? 'PASS with no critique text.' : 'REVISE requested.';
  }
  if (!meta.change_summary || typeof meta.change_summary !== 'string') {
    meta.change_summary = meta.verdict === 'PASS' ? 'none' : 'unspecified';
  }

  const htmlMatch = raw.match(/<<<HTML>>>\s*([\s\S]*?)\s*<<<END>>>/i);
  let html = htmlMatch?.[1]?.trim();

  if (!html && meta.verdict === 'REVISE') {
    const looseHtml = raw.match(/<<<HTML>>>\s*(<!DOCTYPE[\s\S]*|<html[\s\S]*)/i);
    html = looseHtml?.[1]?.trim();
  }

  if (
    meta.verdict === 'REVISE' &&
    html &&
    !html.includes('<!DOCTYPE') &&
    !html.includes('<html')
  ) {
    return { ok: false, error: 'REVISE verdict but HTML block is not a valid document' };
  }

  if (meta.verdict === 'PASS') {
    return { ok: true, meta, qualityScore: inferQualityScore(meta) };
  }

  if (!html) {
    return { ok: false, error: 'REVISE verdict but no valid HTML block found' };
  }

  return { ok: true, meta, html, qualityScore: inferQualityScore(meta) };
}

const SYSTEM = `You are a senior Etsy listing graphic designer with strong HTML/CSS/SVG skills.

You receive:
1. A RENDERED PNG of an HTML template (what buyers will see)
2. The current HTML source
3. A critique rubric

Your job: look at the ACTUAL RENDERED IMAGE (not just the code), judge it against the rubric, and either PASS or REVISE.

When REVISE: rewrite the COMPLETE HTML document to fix the specific visual problems you see. Preserve the brand header/footer styling unless the rubric says otherwise. Output must remain a self-contained HTML file that renders at 2000×2000. Prefer inlining templates/assets/silhouettes/adult.svg for the person rather than drawing stick figures from scratch.

RESPONSE FORMAT — use EXACTLY this delimiter structure, no markdown fences:

<<<META>>>
{"verdict":"PASS"|"REVISE","critique":"2-4 sentences on what you see vs the rubric","change_summary":"one line on what you changed (or 'none' if PASS)","quality_score":1-10}
<<<HTML>>>
(ONLY if verdict is REVISE: the complete revised <!DOCTYPE html>... document)
<<<END>>>

If verdict is PASS, omit the HTML section entirely — output META then <<<END>>>:

<<<META>>>
{"verdict":"PASS","critique":"...","change_summary":"none","quality_score":9}
<<<END>>>`;

async function visionCritique(opts: {
  pngPath: string;
  html: string;
  rubric: string;
  iteration: number;
}): Promise<{
  parsed: ParseVisionResult;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const pngBytes = readFileSync(opts.pngPath);
  const base64 = pngBytes.toString('base64');
  const anthropic = getAnthropic();

  const userText = [
    `Iteration ${opts.iteration} critique.`,
    '',
    '## Rubric',
    opts.rubric,
    '',
    '## Current HTML',
    '```html',
    opts.html,
    '```',
    '',
    'The attached PNG is the rendered output at 2000×2000. Judge the IMAGE.',
  ].join('\n');

  const resp = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64,
            },
          },
          { type: 'text', text: userText },
        ],
      },
    ],
  });

  const raw = getText(resp);
  const parsed = parseVisionResponse(raw);
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const costUsd = estimateCostUsd(inputTokens, outputTokens);

  return { parsed, costUsd, inputTokens, outputTokens };
}

export interface RefineGraphicResult {
  converged: boolean;
  iterations: number;
  finalPng: string;
  scratchDir: string;
  log: IterationLogEntry[];
  totalCostUsd: number;
  bestIteration: number;
  bestQualityScore: number;
}

export async function refineGraphic(opts: {
  htmlPath: string;
  outPath: string;
  rubricPath: string;
  maxIter?: number;
}): Promise<RefineGraphicResult> {
  const maxIter = opts.maxIter ?? 6;
  const absHtml = path.resolve(opts.htmlPath);
  const absOut = path.resolve(opts.outPath);
  const rubric = readFileSync(path.resolve(opts.rubricPath), 'utf8');

  const slug = path.basename(absHtml, path.extname(absHtml));
  const scratchDir = path.resolve('dist/refine-graphic', slug);
  mkdirSync(scratchDir, { recursive: true });

  let html = readFileSync(absHtml, 'utf8');
  const log: IterationLogEntry[] = [];
  let totalCostUsd = 0;
  let converged = false;
  let bestIteration = 0;
  let bestQualityScore = -1;
  let bestHtml = html;
  let bestPng = '';

  console.log('');
  console.log('=== refine-graphic ===');
  console.log(`  html:      ${absHtml}`);
  console.log(`  out:       ${absOut}`);
  console.log(`  rubric:    ${opts.rubricPath}`);
  console.log(`  max_iter:  ${maxIter}`);
  console.log(`  model:     ${VISION_MODEL}`);
  console.log(`  scratch:   ${scratchDir}`);
  console.log('');

  for (let i = 1; i <= maxIter; i++) {
    const iterHtmlPath = path.join(scratchDir, `iteration-${i}.html`);
    const iterPngPath = path.join(scratchDir, `iteration-${i}.png`);
    writeFileSync(iterHtmlPath, html, 'utf8');

    console.log(`--- iteration ${i}/${maxIter} ---`);
    await renderGraphic({
      inputPath: iterHtmlPath,
      outputPath: iterPngPath,
      quiet: true,
    });
    console.log(`  rendered: ${iterPngPath}`);

    const { parsed, costUsd, inputTokens, outputTokens } = await visionCritique({
      pngPath: iterPngPath,
      html,
      rubric,
      iteration: i,
    });
    totalCostUsd += costUsd;

    if (!parsed.ok) {
      const entry: IterationLogEntry = {
        iteration: i,
        verdict: 'PARSE_ERROR',
        critique: parsed.error,
        change_summary: 'parse failure — kept previous HTML',
        quality_score: null,
        render_path: iterPngPath,
        html_path: iterHtmlPath,
        cost_usd: costUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        parse_error: parsed.error,
      };
      log.push(entry);

      console.warn(`  verdict:   PARSE_ERROR`);
      console.warn(`  error:     ${parsed.error.slice(0, 200)}${parsed.error.length > 200 ? '…' : ''}`);
      console.log(
        `  cost:      $${costUsd.toFixed(4)} (${inputTokens} in / ${outputTokens} out tokens)`
      );
      console.log('');
      continue;
    }

    const { meta, html: revisedHtml, qualityScore } = parsed;

    const entry: IterationLogEntry = {
      iteration: i,
      verdict: meta.verdict,
      critique: meta.critique,
      change_summary: meta.change_summary,
      quality_score: qualityScore,
      render_path: iterPngPath,
      html_path: iterHtmlPath,
      cost_usd: costUsd,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
    log.push(entry);

    if (qualityScore > bestQualityScore) {
      bestQualityScore = qualityScore;
      bestIteration = i;
      bestHtml = html;
      bestPng = iterPngPath;
    }

    console.log(`  verdict:   ${meta.verdict}`);
    console.log(`  quality:   ${qualityScore}/10`);
    console.log(`  critique:  ${meta.critique}`);
    console.log(`  changed:   ${meta.change_summary}`);
    console.log(
      `  cost:      $${costUsd.toFixed(4)} (${inputTokens} in / ${outputTokens} out tokens)`
    );
    console.log('');

    if (meta.verdict === 'PASS') {
      converged = true;
      copyFileSync(iterPngPath, absOut);
      writeFileSync(absHtml, html, 'utf8');
      break;
    }

    if (!revisedHtml) {
      console.warn(`  ⚠ REVISE without HTML — keeping previous source for next iteration`);
      continue;
    }
    html = revisedHtml;
  }

  if (!converged) {
    if (bestIteration === 0 || !bestPng) {
      const fallback = log.find(e => e.verdict !== 'PARSE_ERROR');
      bestIteration = fallback?.iteration ?? log.length;
      bestPng = fallback?.render_path ?? path.join(scratchDir, `iteration-${log.length}.png`);
      bestHtml = readFileSync(
        path.join(scratchDir, `iteration-${bestIteration}.html`),
        'utf8'
      );
      bestQualityScore = fallback?.quality_score ?? 0;
    }

    console.warn(
      `⚠ did not converge — shipping best-so-far iteration ${bestIteration} (quality ${bestQualityScore}/10)`
    );
    copyFileSync(bestPng, absOut);
    writeFileSync(absHtml, bestHtml, 'utf8');
  }

  writeFileSync(
    path.join(scratchDir, 'iteration-log.json'),
    JSON.stringify(
      {
        converged,
        iterations: log.length,
        bestIteration: converged ? log.find(e => e.verdict === 'PASS')?.iteration ?? bestIteration : bestIteration,
        bestQualityScore: converged ? 10 : bestQualityScore,
        totalCostUsd,
        log,
      },
      null,
      2
    )
  );

  return {
    converged,
    iterations: log.length,
    finalPng: absOut,
    scratchDir,
    log,
    totalCostUsd,
    bestIteration: converged
      ? (log.find(e => e.verdict === 'PASS')?.iteration ?? bestIteration)
      : bestIteration,
    bestQualityScore: converged ? 10 : bestQualityScore,
  };
}

const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help) usage();
  if (!parsed.html || !parsed.out || !parsed.rubric) {
    console.error('✗ --html, --out, and --rubric are required');
    usage();
  }

  refineGraphic({
    htmlPath: parsed.html,
    outPath: parsed.out,
    rubricPath: parsed.rubric,
    maxIter: parsed.maxIter,
  })
    .then(result => {
      console.log('=== refine-graphic complete ===');
      console.log(
        `  converged: ${result.converged ? 'YES' : 'NO (cap reached)'} in ${result.iterations} iteration(s)`
      );
      console.log(
        `  best:      iteration ${result.bestIteration} (quality ${result.bestQualityScore}/10)`
      );
      console.log(`  final png: ${result.finalPng}`);
      console.log(`  scratch:   ${result.scratchDir}`);
      console.log(`  total cost: $${result.totalCostUsd.toFixed(4)}`);
      console.log('');
      console.log('Iteration log:');
      for (const e of result.log) {
        const q = e.quality_score != null ? `${e.quality_score}/10` : 'n/a';
        console.log(
          `  [${e.iteration}] ${e.verdict} (${q}) — ${e.change_summary} — ${e.critique.slice(0, 120)}${e.critique.length > 120 ? '…' : ''}`
        );
      }
      console.log('');
      if (!result.converged) process.exitCode = 2;
    })
    .catch(err => {
      console.error('');
      console.error('✗ refine-graphic failed');
      console.error(`  ${err instanceof Error ? err.message : err}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    });
}
