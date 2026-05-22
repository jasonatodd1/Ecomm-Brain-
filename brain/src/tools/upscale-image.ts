// Image upscaling via fal.ai (default: Clarity Upscaler).
//
// Two entry points (same pattern as `generate-image.ts`):
//
//   1. Programmatic — for future agents:
//        import { upscaleImage } from '../tools/upscale-image.js';
//        const result = await upscaleImage({ input, scale, ... });
//
//   2. CLI — for human-driven iteration via Cursor:
//        npm run upscale -- --input=./dist/gen/bunny-01.png --scale=2.9
//
// Outputs are persisted in two places so downstream agents can pick them up:
//   - The upscaled image on disk at the resolved local path
//   - An `activity` row with action='image.upscaled' and rich jsonb metadata
//
// Default model is Clarity Upscaler with faithful-upscale parameter values
// (low creativity, high resemblance) so the upscaler enlarges without
// reinterpreting the source. Override flags exist when detail enhancement
// is wanted instead. NOTE: Clarity is diffusion-based and cannot be fully
// pixel-faithful even at maximum resemblance — small drift in fine detail is
// inherent to the architecture. For absolutely faithful upscaling of clean
// illustrations, consider `--model=fal-ai/aura-sr` (deterministic GAN, fixed 4x).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  fal,
  resolveModelId,
  resolveReferenceImage,
  downloadImage,
  verifyAndCorrectDimensions,
  buildUpscaleOutputPath,
  estimateClarityUpscaleCost,
  formatFalValidationError,
} from '../lib/fal.js';
import { log } from '../lib/log.js';
import { insertAsset, type AssetKind } from '../lib/assets.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface UpscaleImageOptions {
  /** Input image: local path or http(s) URL. Required. */
  input: string;

  /**
   * Upscale factor. Default: 2.
   * If both `scale` and `size` are provided, `size` wins (scale is recomputed).
   * If only `size` is provided, requires input to be a local path so input
   * dimensions can be read.
   */
  scale?: number;

  /**
   * Target output dimensions. If provided, scale is computed from the input
   * image's actual dimensions (read via sharp). The Clarity result is then
   * sharp-corrected to exact target dims.
   */
  size?: { width: number; height: number };

  /**
   * Model: alias 'clarity' (default) or full fal model ID for an upscaler.
   * Currently only Clarity is tested. Other models may have different input
   * schemas — caller is on their own.
   */
  model?: string;

  // ----- Clarity Upscaler tuning knobs -----
  // Defaults are tuned for FAITHFUL upscaling (no creative reinterpretation),
  // which is more conservative than Clarity's own defaults. Override these
  // when you want detail enhancement.

  /** 0-1. Lower = less reinterpretation. Default: 0.1 (Clarity default: 0.35). */
  creativity?: number;
  /** 0-1. Higher = locks harder to source. Default: 1.0 (Clarity default: 0.6). */
  resemblance?: number;
  /** CFG. Default: 4 (matches Clarity default). */
  guidanceScale?: number;
  /** Default: 20 (Clarity default: 18). */
  numInferenceSteps?: number;
  /** Quality-steering prompt. Default: "masterpiece, best quality, highres, sharp, detailed". */
  prompt?: string;
  /** Default: "blurry, low resolution, pixelated, compression artifacts, noisy, grainy". */
  negativePrompt?: string;

  /** Seed for reproducibility. Random if not specified. */
  seed?: number;

  /** Output path. If absent, auto-named under `dist/gen/` from the input stem. */
  output?: string;

  /** Output format. Default: png. */
  outputFormat?: 'png' | 'jpeg';

  /** Optional FK to a `product_briefs.id` for downstream agent lookups. */
  productBriefId?: string;
  /**
   * Optional FK to a `listings.id`. Persisted on the assets row so the
   * Listing Agent can fetch its asset set in one query.
   */
  listingId?: string;
  /**
   * Asset `kind` for the new `assets` row. Defaults to 'master' because the
   * common case for `upscale-image.ts` is producing a print-ready master from
   * a smaller hero generation. Override via `--kind=hero` etc. when upscaling
   * non-master assets.
   */
  kind?: AssetKind;
  /** Freeform metadata to attach to the activity row. */
  agentContext?: Record<string, unknown>;
  /** Skip writing to the activity table (default: false). */
  logToActivity?: boolean;
  /** Skip writing to the assets table (default: false). */
  registerAsset?: boolean;
}

export interface UpscaleImageResult {
  model: string;
  inputUrl: string; // resolved CDN URL (uploaded if input was local)
  outputPath: string;
  outputUrl: string; // fal CDN URL of the upscaled result
  falRequestId: string;
  inputDimensions?: { width: number; height: number }; // present when input is local
  outputDimensions: { width: number; height: number };
  upscaleFactor: number; // actual factor passed to Clarity
  seed: number;
  costUsd: number;
  correctedFrom?: { width: number; height: number };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Defaults (faithful-upscale tuning)
// ---------------------------------------------------------------------------
const DEFAULT_PROMPT = 'masterpiece, best quality, highres, sharp, detailed';
const DEFAULT_NEGATIVE_PROMPT =
  'blurry, low resolution, pixelated, compression artifacts, noisy, grainy';
const DEFAULT_CREATIVITY = 0.1;
const DEFAULT_RESEMBLANCE = 1.0;
const DEFAULT_GUIDANCE_SCALE = 4;
const DEFAULT_NUM_INFERENCE_STEPS = 20;
const DEFAULT_SCALE = 2;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
export async function upscaleImage(
  opts: UpscaleImageOptions
): Promise<UpscaleImageResult> {
  const startedAt = Date.now();

  if (!opts.input || !opts.input.trim()) {
    throw new Error('upscaleImage: input is required');
  }

  const isLocalInput = !/^https?:\/\//i.test(opts.input);

  // ----- Read input dimensions when local (needed if size is requested) -----
  let inputDimensions: { width: number; height: number } | undefined;
  if (isLocalInput) {
    const buffer = await readFile(path.resolve(opts.input));
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height) {
      inputDimensions = { width: meta.width, height: meta.height };
    }
  }

  // ----- Resolve scale / target dims -----
  // Precedence: size > scale > DEFAULT_SCALE.
  // When size is given, we compute scale from input dims (requires local input).
  let scale: number;
  let targetDims: { width: number; height: number } | null = null;

  if (opts.size) {
    if (!inputDimensions) {
      throw new Error(
        'upscaleImage: --size requires a local input path so input dimensions ' +
        'can be read. Use --scale=N for URL inputs.'
      );
    }
    targetDims = opts.size;
    // Use max ratio so the upscaled image is at least as large as target in both dims
    scale = Math.max(
      opts.size.width / inputDimensions.width,
      opts.size.height / inputDimensions.height
    );
  } else {
    scale = opts.scale ?? DEFAULT_SCALE;
    if (scale <= 0) throw new Error('scale must be > 0');
  }

  // ----- Resolve model -----
  const modelAlias = opts.model ?? 'clarity';
  const modelId = resolveModelId(modelAlias);

  // ----- Resolve output format & path -----
  const inferredFormat: 'png' | 'jpeg' = (() => {
    if (!opts.output) return 'png';
    const ext = path.extname(opts.output).toLowerCase();
    return ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';
  })();
  const outputFormat = opts.outputFormat ?? inferredFormat;
  const outputPath =
    opts.output ??
    buildUpscaleOutputPath(opts.input, scale, outputFormat === 'jpeg' ? 'jpg' : 'png');

  // ----- Upload local input to fal CDN; pass-through if URL -----
  const inputUrl = await resolveReferenceImage(opts.input);

  // ----- Build fal input payload -----
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const input: Record<string, unknown> = {
    image_url: inputUrl,
    prompt: opts.prompt ?? DEFAULT_PROMPT,
    negative_prompt: opts.negativePrompt ?? DEFAULT_NEGATIVE_PROMPT,
    upscale_factor: scale,
    creativity: opts.creativity ?? DEFAULT_CREATIVITY,
    resemblance: opts.resemblance ?? DEFAULT_RESEMBLANCE,
    guidance_scale: opts.guidanceScale ?? DEFAULT_GUIDANCE_SCALE,
    num_inference_steps: opts.numInferenceSteps ?? DEFAULT_NUM_INFERENCE_STEPS,
    seed,
  };

  // ----- Call fal -----
  const result = await fal.subscribe(modelId, { input, logs: false });

  // Clarity returns `image` (singular). Other upscalers may return `images` (plural).
  // Handle both shapes.
  const data = result.data as {
    image?: { url: string; width?: number; height?: number };
    images?: Array<{ url: string; width?: number; height?: number }>;
  };
  const img = data.image ?? data.images?.[0];
  if (!img?.url) {
    throw new Error(`Upscale returned no image for request ${result.requestId}`);
  }
  const outputUrl = img.url;

  // ----- Download -----
  await downloadImage(outputUrl, outputPath);

  // ----- Verify & correct dimensions (if target was specified) -----
  let outputDimensions = { width: img.width ?? 0, height: img.height ?? 0 };
  let correctedFrom: { width: number; height: number } | undefined;
  if (targetDims) {
    const check = await verifyAndCorrectDimensions(
      outputPath,
      targetDims.width,
      targetDims.height
    );
    if (check.corrected) {
      correctedFrom = { width: check.actualWidth, height: check.actualHeight };
      outputDimensions = { width: targetDims.width, height: targetDims.height };
    } else {
      outputDimensions = { width: check.actualWidth, height: check.actualHeight };
    }
  }

  const durationMs = Date.now() - startedAt;
  const costUsd = estimateClarityUpscaleCost(
    outputDimensions.width,
    outputDimensions.height
  );

  const upscaleResult: UpscaleImageResult = {
    model: modelId,
    inputUrl,
    outputPath,
    outputUrl,
    falRequestId: result.requestId,
    inputDimensions,
    outputDimensions,
    upscaleFactor: scale,
    seed,
    costUsd,
    correctedFrom,
    durationMs,
  };

  // ----- Activity log (asset hand-off to downstream agents) -----
  if (opts.logToActivity !== false) {
    await log({
      agent: 'product',
      action: 'image.upscaled',
      description: `Upscaled image via ${modelId} (${scale.toFixed(2)}x)`,
      severity: 'success',
      metadata: {
        model: modelId,
        input_url: inputUrl,
        input_path: isLocalInput ? path.resolve(opts.input) : undefined,
        input_dimensions: inputDimensions,
        output_path: outputPath,
        output_url: outputUrl,
        output_dimensions: outputDimensions,
        upscale_factor: scale,
        seed,
        cost_usd: costUsd,
        corrected_from: correctedFrom,
        duration_ms: durationMs,
        params: {
          prompt: input.prompt,
          negative_prompt: input.negative_prompt,
          creativity: input.creativity,
          resemblance: input.resemblance,
          guidance_scale: input.guidance_scale,
          num_inference_steps: input.num_inference_steps,
        },
        fal_request_id: result.requestId,
        product_brief_id: opts.productBriefId,
        listing_id: opts.listingId,
        agent_context: opts.agentContext,
      },
    });
  }

  // ----- Asset registry (queryable hand-off to the Listing Agent) -----
  if (opts.registerAsset !== false) {
    const assetKind: AssetKind = opts.kind ?? 'master';
    await insertAsset({
      kind: assetKind,
      source: 'fal_upscaled',
      listing_id: opts.listingId,
      product_brief_id: opts.productBriefId,
      local_path: outputPath,
      cdn_url: outputUrl,
      width: outputDimensions.width,
      height: outputDimensions.height,
      fal_request_id: result.requestId,
      metadata: {
        model: modelId,
        input_url: inputUrl,
        input_path: isLocalInput ? path.resolve(opts.input) : undefined,
        input_dimensions: inputDimensions,
        upscale_factor: scale,
        seed,
        cost_usd: costUsd,
        duration_ms: durationMs,
        corrected_from: correctedFrom,
        params: {
          prompt: input.prompt,
          negative_prompt: input.negative_prompt,
          creativity: input.creativity,
          resemblance: input.resemblance,
          guidance_scale: input.guidance_scale,
          num_inference_steps: input.num_inference_steps,
        },
      },
    });
  }

  return upscaleResult;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface ParsedArgs extends Partial<UpscaleImageOptions> {
  _help?: boolean;
}

function parseSize(raw: string): { width: number; height: number } | undefined {
  const m = raw.match(/^(\d+)x(\d+)$/i);
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
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
      case 'input':            out.input = val; break;
      case 'scale':            out.scale = Number(val); break;
      case 'size':             out.size = parseSize(val); break;
      case 'model':            out.model = val; break;
      case 'creativity':       out.creativity = Number(val); break;
      case 'resemblance':      out.resemblance = Number(val); break;
      case 'guidance-scale':   out.guidanceScale = Number(val); break;
      case 'inference-steps':  out.numInferenceSteps = Number(val); break;
      case 'prompt':           out.prompt = val; break;
      case 'negative-prompt':  out.negativePrompt = val; break;
      case 'seed':             out.seed = Number(val); break;
      case 'output':           out.output = val; break;
      case 'output-format':    out.outputFormat = val === 'jpeg' || val === 'jpg' ? 'jpeg' : 'png'; break;
      case 'product-brief-id': out.productBriefId = val; break;
      case 'listing-id':       out.listingId = val; break;
      case 'kind':             out.kind = val as AssetKind; break;
      default:                 console.warn(`> ignoring unknown flag: --${key}`);
    }
  }
  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage: npm run upscale -- --input=<path|url> [options]');
  console.error('');
  console.error('Required:');
  console.error('  --input=<path|url>        Image to upscale. Local paths upload to fal CDN.');
  console.error('');
  console.error('Common options (one of these, or use --scale=2 default):');
  console.error('  --scale=N                 Upscale factor (e.g. 2, 2.9, 4). Default: 2');
  console.error('  --size=WxH                Target output dimensions (e.g. 5008x6680).');
  console.error('                            Requires a local --input so input dims can be read.');
  console.error('                            Computes scale from input dims; sharp-corrects to exact target.');
  console.error('');
  console.error('Faithful-upscale defaults (override only when you want detail enhancement):');
  console.error('  --creativity=N            0-1, default 0.1  (Clarity default: 0.35)');
  console.error('  --resemblance=N           0-1, default 1.0  (Clarity default: 0.6)');
  console.error('  --inference-steps=N       default 20        (Clarity default: 18)');
  console.error('  --guidance-scale=N        default 4');
  console.error('  --prompt="..."            default: "masterpiece, best quality, highres, sharp, detailed"');
  console.error('  --negative-prompt="..."   default: "blurry, low resolution, pixelated, compression artifacts, noisy, grainy"');
  console.error('  --seed=N                  default: random');
  console.error('');
  console.error('Output:');
  console.error('  --model=<alias|id>        default: clarity (fal-ai/clarity-upscaler)');
  console.error('  --output=<path>           default: dist/gen/<ts>-<input-stem>-upscaled-<scale>x.png');
  console.error('  --output-format=png|jpeg  default: inferred from --output extension, else png');
  console.error('');
  console.error('Agent integration (optional):');
  console.error('  --product-brief-id=<uuid> Link this upscale to a product_briefs row (FK on assets row)');
  console.error('  --listing-id=<uuid>       Link this upscale to a listings row (FK on assets row)');
  console.error('  --kind=<asset-kind>       Asset kind for the assets row. Default: master.');
  console.error('                            Accepted: master | hero | lifestyle | source_file');
  console.error('');
  console.error('Examples:');
  console.error('  # 2x upscale with faithful defaults');
  console.error('  npm run upscale -- --input=./dist/gen/bunny-01.png --scale=2');
  console.error('');
  console.error('  # Upscale bunny art to exact print resolution (1728x2304 -> 5008x6680)');
  console.error('  npm run upscale -- --input=./dist/gen/bunny-01.png --size=5008x6680');
  console.error('');
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help || !parsed.input) usage();

  console.log('> upscaling image');
  console.log(`> input: ${parsed.input}`);
  if (parsed.size) console.log(`> target size: ${parsed.size.width}x${parsed.size.height}`);
  else if (parsed.scale) console.log(`> scale: ${parsed.scale}x`);
  console.log('');

  const result = await upscaleImage(parsed as UpscaleImageOptions);

  console.log('');
  console.log(`✓ upscaled`);
  console.log(`> model:    ${result.model}`);
  console.log(`> duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`> cost est: $${result.costUsd.toFixed(3)}  (Clarity is compute-time billed; actual TBD)`);
  console.log(`> factor:   ${result.upscaleFactor.toFixed(2)}x  (seed=${result.seed})`);
  if (result.inputDimensions) {
    console.log(
      `> dims:     ${result.inputDimensions.width}x${result.inputDimensions.height}  ` +
      `→  ${result.outputDimensions.width}x${result.outputDimensions.height}`
    );
  } else {
    console.log(`> dims:     output ${result.outputDimensions.width}x${result.outputDimensions.height}`);
  }
  if (result.correctedFrom) {
    console.log(
      `> corrected: ${result.correctedFrom.width}x${result.correctedFrom.height} → ${result.outputDimensions.width}x${result.outputDimensions.height} (sharp resize to exact target)`
    );
  }
  console.log(`> output:   ${result.outputPath}`);
  console.log('');
}

// Only run the CLI when this module is invoked directly. When imported by an
// agent, the CLI must NOT execute (so `import { upscaleImage } from '...'`
// doesn't trip argv parsing).
const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  main().catch(async (err: unknown) => {
    const falMsg = formatFalValidationError(err);
    const message = falMsg ?? (err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(`✗ upscale-image failed: ${message}`);
    await log({
      agent: 'product',
      action: 'image.upscale_failed',
      description: message,
      severity: 'error',
      metadata: { error: String(err) },
    }).catch(() => {
      /* best-effort; don't mask the real error */
    });
    process.exit(1);
  });
}
