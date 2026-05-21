// Image generation via fal.ai.
//
// Two entry points:
//
//   1. Programmatic — for future agents (Design Agent, Listing Agent, etc.):
//        import { generateImage } from '../tools/generate-image.js';
//        const result = await generateImage({ prompt, size, refs, count, ... });
//      Returns a structured `GenerateImageResult` with paths, dimensions,
//      seeds, costs, and fal request IDs that downstream agents can consume.
//
//   2. CLI — for human-driven iteration via Cursor:
//        npm run gen -- --prompt="..." --size=1728x2304 --count=4
//      Same logic, just wraps `generateImage` with argv parsing and stdout.
//
// Outputs are persisted in two places so downstream agents can pick them up:
//   - The image file(s) on disk at the resolved local path
//   - An `activity` row with action='image.generated' and rich jsonb metadata
//     (model, prompt, refs, dims, seeds, costs, fal request IDs, optional
//     product_brief_id linkage). Downstream agents query activity to find
//     assets generated upstream.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  fal,
  resolveModelId,
  resolveReferenceImage,
  downloadImage,
  verifyAndCorrectDimensions,
  buildAutoOutputPath,
  indexOutputPath,
  estimateFluxProCost,
  formatFalValidationError,
} from '../lib/fal.js';
import { log } from '../lib/log.js';
import { mapWithLimit } from '../lib/concurrency.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export type FalImageSizeEnum =
  | 'square_hd'
  | 'square'
  | 'portrait_4_3'
  | 'portrait_16_9'
  | 'landscape_4_3'
  | 'landscape_16_9';

export interface GenerateImageOptions {
  /** The prompt to generate from. Required. */
  prompt: string;

  /**
   * Model alias (`flux-pro`, `flux-pro-edit`) or full fal model id.
   * Default: `flux-pro` (text-to-image), or `flux-pro-edit` if `refs` is non-empty.
   */
  model?: string;

  /**
   * Output dimensions. Either explicit width/height (preferred — pinned exactly)
   * or a fal preset enum. Default: 'portrait_4_3'.
   *
   * NOTE: when an explicit {width, height} is passed, the result is verified
   * and sharp-corrected to those exact dimensions. Enum sizes are passed to
   * fal verbatim and not post-corrected (we don't know the target dims).
   */
  size?: { width: number; height: number } | FalImageSizeEnum;

  /**
   * Reference images for image-to-image edit mode. 1–9 entries.
   * Local paths are auto-uploaded to fal CDN. Existing http(s) URLs pass through.
   * Presence of refs auto-routes to `flux-pro-edit` unless `model` is set.
   */
  refs?: string[];

  /**
   * Base seed for reproducibility. With `count` > 1, seeds become
   * `seed, seed+1, seed+2, …` to keep outputs distinct.
   * Default: a random seed.
   */
  seed?: number;

  /** Number of variants to generate (parallel calls). Default: 1. */
  count?: number;

  /**
   * Output path. If omitted, auto-generated under `dist/gen/`.
   * With `count` > 1, a 2-digit index is injected (foo.png -> foo-01.png, …).
   */
  output?: string;

  /** Output format. Default: inferred from `output` extension, else 'png'. */
  outputFormat?: 'png' | 'jpeg';

  /**
   * Optional FK to a `product_briefs.id`. When set, downstream agents can
   * query `activity` for images linked to a brief:
   *   SELECT metadata FROM activity
   *   WHERE action='image.generated'
   *     AND metadata->>'product_brief_id' = '<uuid>'
   */
  productBriefId?: string;

  /** Freeform metadata an agent caller wants attached to the activity row. */
  agentContext?: Record<string, unknown>;

  /** Skip writing to the activity table (default: false). */
  logToActivity?: boolean;
}

export interface GeneratedImage {
  /** 1-based index across the batch (matches filename suffix when count>1). */
  index: number;
  localPath: string;
  falUrl: string;
  falRequestId: string;
  width: number;
  height: number;
  seed: number;
  costUsd: number;
  /** Present when sharp post-correction was applied (model returned different dims). */
  correctedFrom?: { width: number; height: number };
}

export interface GenerateImageResult {
  model: string;
  prompt: string;
  refs: string[];
  size: { width: number; height: number } | FalImageSizeEnum;
  images: GeneratedImage[];
  totalCostUsd: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
export async function generateImage(
  opts: GenerateImageOptions
): Promise<GenerateImageResult> {
  const startedAt = Date.now();

  if (!opts.prompt || !opts.prompt.trim()) {
    throw new Error('generateImage: prompt is required');
  }

  const count = opts.count ?? 1;
  if (count < 1) throw new Error('count must be >= 1');

  const refs = opts.refs ?? [];
  if (refs.length > 9) {
    throw new Error(
      `fal-ai/flux-2-pro/edit accepts up to 9 reference images (got ${refs.length})`
    );
  }

  // ----- Resolve model -----
  // Explicit > inferred-from-refs > text-to-image default
  const modelAlias = opts.model ?? (refs.length > 0 ? 'flux-pro-edit' : 'flux-pro');
  const modelId = resolveModelId(modelAlias);
  const isEditEndpoint = modelId.endsWith('/edit');

  if (refs.length > 0 && !isEditEndpoint) {
    throw new Error(
      `Reference images were provided but model '${modelAlias}' is not an ` +
      `edit/i2i endpoint. Use --model=flux-pro-edit (or omit --model to ` +
      `auto-route).`
    );
  }
  if (refs.length === 0 && isEditEndpoint) {
    throw new Error(
      `Edit model '${modelAlias}' requires at least one --ref reference image.`
    );
  }

  // ----- Resolve size -----
  // Default to portrait_4_3 unless caller specified. When explicit {w,h} is
  // given, we'll post-verify and sharp-correct to guarantee exact dims.
  const size = opts.size ?? 'portrait_4_3';
  const targetDims = typeof size === 'object' ? size : null;

  // ----- Resolve output format -----
  const inferredFormat: 'png' | 'jpeg' = (() => {
    if (!opts.output) return 'png';
    const ext = path.extname(opts.output).toLowerCase();
    return ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';
  })();
  const outputFormat = opts.outputFormat ?? inferredFormat;

  // ----- Upload refs (local paths) and pass-through (URLs) -----
  const refUrls: string[] = refs.length
    ? await mapWithLimit(refs, 3, 0, (r) => resolveReferenceImage(r))
    : [];

  // ----- Build fal input -----
  function buildInput(seed: number): Record<string, unknown> {
    const input: Record<string, unknown> = {
      prompt: opts.prompt,
      image_size: size, // explicit dims OR enum — fal accepts both
      seed,
      output_format: outputFormat,
    };
    if (refUrls.length > 0) input.image_urls = refUrls;
    return input;
  }

  // ----- Generate N images in parallel (cap concurrency at 3) -----
  const baseSeed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const indices = Array.from({ length: count }, (_, i) => i);

  const images: GeneratedImage[] = await mapWithLimit(indices, 3, 0, async (i) => {
    const seed = baseSeed + i;
    const indexNum = i + 1;

    const result = await fal.subscribe(modelId, {
      input: buildInput(seed),
      logs: false,
    });

    const data = result.data as {
      images?: Array<{ url: string; width?: number; height?: number }>;
    };
    if (!data?.images?.length) {
      throw new Error(`fal returned no images for request ${result.requestId}`);
    }
    const img = data.images[0];

    // Resolve local path. With auto-naming, every image gets a unique slug
    // path so we don't need indexOutputPath. With explicit --output and
    // count>1, indexOutputPath inserts the 2-digit suffix.
    const localPath = opts.output
      ? indexOutputPath(opts.output, indexNum, count)
      : buildAutoOutputPath(opts.prompt, indexNum, outputFormat === 'jpeg' ? 'jpg' : 'png');

    await downloadImage(img.url, localPath);

    // Dimension guarantee (only when caller pinned explicit dims)
    let width = img.width ?? 0;
    let height = img.height ?? 0;
    let correctedFrom: { width: number; height: number } | undefined;
    if (targetDims) {
      const check = await verifyAndCorrectDimensions(
        localPath,
        targetDims.width,
        targetDims.height
      );
      if (check.corrected) {
        correctedFrom = { width: check.actualWidth, height: check.actualHeight };
        width = targetDims.width;
        height = targetDims.height;
      } else {
        width = check.actualWidth;
        height = check.actualHeight;
      }
    }

    const costUsd = estimateFluxProCost(
      targetDims?.width ?? width,
      targetDims?.height ?? height
    );

    return {
      index: indexNum,
      localPath,
      falUrl: img.url,
      falRequestId: result.requestId,
      width,
      height,
      seed,
      costUsd,
      correctedFrom,
    };
  });

  const totalCostUsd = images.reduce((sum, img) => sum + img.costUsd, 0);
  const durationMs = Date.now() - startedAt;

  const result: GenerateImageResult = {
    model: modelId,
    prompt: opts.prompt,
    refs: refUrls,
    size,
    images,
    totalCostUsd,
    durationMs,
  };

  // ----- Activity log (asset hand-off to downstream agents) -----
  if (opts.logToActivity !== false) {
    await log({
      agent: 'product',
      action: 'image.generated',
      description: `Generated ${count} image${count > 1 ? 's' : ''} via ${modelId}`,
      severity: 'success',
      metadata: {
        model: modelId,
        prompt: opts.prompt,
        refs: refUrls,
        size,
        images: images.map((img) => ({
          local_path: img.localPath,
          fal_url: img.falUrl,
          fal_request_id: img.falRequestId,
          seed: img.seed,
          width: img.width,
          height: img.height,
          cost_usd: img.costUsd,
          corrected_from: img.correctedFrom,
        })),
        total_cost_usd: totalCostUsd,
        duration_ms: durationMs,
        product_brief_id: opts.productBriefId,
        agent_context: opts.agentContext,
      },
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface ParsedArgs extends Partial<GenerateImageOptions> {
  _help?: boolean;
}

function parseSize(raw: string): GenerateImageOptions['size'] {
  const wxh = raw.match(/^(\d+)x(\d+)$/i);
  if (wxh) return { width: Number(wxh[1]), height: Number(wxh[2]) };
  return raw as FalImageSizeEnum;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const refs: string[] = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out._help = true;
      continue;
    }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal ?? '';

    switch (key) {
      case 'prompt':            out.prompt = val; break;
      case 'model':             out.model = val; break;
      case 'size':              out.size = parseSize(val); break;
      case 'ref':               refs.push(val); break;
      case 'seed':              out.seed = Number(val); break;
      case 'count':             out.count = Number(val); break;
      case 'output':            out.output = val; break;
      case 'output-format':     out.outputFormat = val === 'jpeg' || val === 'jpg' ? 'jpeg' : 'png'; break;
      case 'product-brief-id':  out.productBriefId = val; break;
      default:                  console.warn(`> ignoring unknown flag: --${key}`);
    }
  }
  if (refs.length > 0) out.refs = refs;
  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage: npm run gen -- --prompt="..." [options]');
  console.error('');
  console.error('Required:');
  console.error('  --prompt=<text>           The image prompt');
  console.error('');
  console.error('Common options:');
  console.error('  --model=<alias|id>        flux-pro (t2i, default)  |  flux-pro-edit (i2i, default when --ref present)');
  console.error('                            or any full fal model id, e.g. fal-ai/flux-2-pro');
  console.error('  --size=WxH                Explicit dimensions, e.g. 1728x2304 (preferred — pinned exactly).');
  console.error('                            Or a fal enum: square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9');
  console.error('                            Default: portrait_4_3');
  console.error('  --ref=<path|url>          Reference image. Repeat up to 9 times. Local paths auto-upload to fal CDN.');
  console.error('  --count=N                 Number of parallel variants. Default: 1');
  console.error('  --seed=N                  Base seed (count>1 increments by 1 per image). Default: random');
  console.error('  --output=<path>           Output path. Default: dist/gen/<timestamp>-<slug>-NN.png');
  console.error('                            With count>1, an index is injected: foo.png -> foo-01.png, foo-02.png');
  console.error('  --output-format=png|jpeg  Default: inferred from --output extension, else png');
  console.error('');
  console.error('Agent integration (optional):');
  console.error('  --product-brief-id=<uuid> Link this generation to a product_briefs row for downstream agents');
  console.error('');
  console.error('Examples:');
  console.error('  npm run gen -- --prompt="vintage watercolor bunny, scalloped frame" --size=1728x2304');
  console.error('  npm run gen -- --prompt="bunny print on wall in modern nursery" --ref=./dist/bunny.png --count=4');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help || !parsed.prompt) usage();

  console.log('> generating image');
  console.log(`> prompt: "${parsed.prompt}"`);
  if (parsed.refs?.length) {
    console.log(`> refs (${parsed.refs.length}): ${parsed.refs.join(', ')}`);
  }
  if (parsed.size) console.log(`> size: ${JSON.stringify(parsed.size)}`);
  if (parsed.count && parsed.count > 1) console.log(`> count: ${parsed.count}`);
  console.log('');

  const result = await generateImage(parsed as GenerateImageOptions);

  console.log('');
  console.log(`✓ generated ${result.images.length} image${result.images.length > 1 ? 's' : ''}`);
  console.log(`> model:     ${result.model}`);
  console.log(`> duration:  ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`> cost est:  $${result.totalCostUsd.toFixed(3)}`);
  console.log('');
  for (const img of result.images) {
    console.log(
      `  [${String(img.index).padStart(2, '0')}] ${img.localPath}  ` +
      `(seed=${img.seed}, ${img.width}x${img.height})`
    );
    if (img.correctedFrom) {
      console.log(
        `       ↳ dims corrected: ${img.correctedFrom.width}x${img.correctedFrom.height} → ${img.width}x${img.height}`
      );
    }
  }
  console.log('');
}

// Only run the CLI when this module is invoked directly (e.g. `npm run gen`).
// When imported by an agent (e.g. `import { generateImage } from '...'`), the
// CLI must NOT execute. This is the standard ESM entry-point check.
const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  main().catch(async (err: unknown) => {
    const falMsg = formatFalValidationError(err);
    const message = falMsg ?? (err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(`✗ generate-image failed: ${message}`);
    await log({
      agent: 'product',
      action: 'image.generation_failed',
      description: message,
      severity: 'error',
      metadata: { error: String(err) },
    }).catch(() => {
      /* best-effort; don't mask the real error */
    });
    process.exit(1);
  });
}
