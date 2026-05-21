// Shared fal.ai infrastructure.
//
// This module is consumed by the CLI tools (`src/tools/generate-image.ts`,
// `src/tools/upscale-image.ts`) AND, importantly, by future agents that will
// orchestrate image work programmatically. Keep the exported surface stable —
// downstream agents will hand-off requirements to these functions and receive
// structured results back.
import { fal } from '@fal-ai/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------
const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  throw new Error(
    'Missing FAL_KEY. Copy .env.example to .env.local and add your fal.ai API key.'
  );
}
fal.config({ credentials: FAL_KEY });
export { fal };

// ---------------------------------------------------------------------------
// Model aliases
// ---------------------------------------------------------------------------
// Friendly names -> full fal model IDs. Pass anything not in this map through
// verbatim, so new models work without code changes (principle #3).
export const MODEL_ALIASES: Record<string, string> = {
  // Text-to-image
  'flux-pro':       'fal-ai/flux-2-pro',
  // Image-to-image (multi-reference, up to 9 refs)
  'flux-pro-edit':  'fal-ai/flux-2-pro/edit',
  // Upscalers
  'clarity':        'fal-ai/clarity-upscaler',
};

export function resolveModelId(aliasOrId: string): string {
  return MODEL_ALIASES[aliasOrId] ?? aliasOrId;
}

// ---------------------------------------------------------------------------
// Pricing estimates
// ---------------------------------------------------------------------------
// FLUX.2 Pro (both t2i and edit): $0.03 first MP, $0.015 each additional MP,
// rounded up. We use ceiling so estimates over- rather than under-report.
// The real charge is whatever fal bills; this is for budgeting only.
export function estimateFluxProCost(width: number, height: number): number {
  const mp = Math.max(1, Math.ceil((width * height) / 1_000_000));
  return 0.03 + 0.015 * (mp - 1);
}

// Clarity Upscaler: priced per-call by fal (compute-time based). We can't
// precompute exactly, but ~$0.05–$0.20 per 2–4x upscale is typical. We log
// a placeholder estimate and let activity downstream reconcile if needed.
export function estimateClarityUpscaleCost(_outputWidth: number, _outputHeight: number): number {
  return 0.10; // rough placeholder; revisit when we have billing data
}

// ---------------------------------------------------------------------------
// Reference image handling
// ---------------------------------------------------------------------------
const ALLOWED_REF_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Resolve a reference image to a fal-hosted URL.
 *  - If `ref` is already an http(s) URL, return it unchanged.
 *  - Otherwise, treat it as a local path: read the file, upload to fal CDN,
 *    return the resulting URL so it can be passed in `image_urls`.
 */
export async function resolveReferenceImage(ref: string): Promise<string> {
  if (/^https?:\/\//i.test(ref)) return ref;

  const absPath = path.resolve(ref);
  const ext = path.extname(absPath).toLowerCase();
  if (!ALLOWED_REF_EXTS.has(ext)) {
    throw new Error(`Unsupported reference image type: ${ext} (${ref})`);
  }

  const buffer = await readFile(absPath);
  const mime = MIME_BY_EXT[ext];
  // Node 20+ has global Blob. fal's storage.upload accepts Blob/File.
  const blob = new Blob([buffer], { type: mime });
  const url = await fal.storage.upload(blob);
  return url;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
/**
 * Download an image from a URL to a local path. Creates parent dirs as needed.
 * Returns the path it was written to (same as `outPath`).
 */
export async function downloadImage(url: string, outPath: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download image from ${url}: ${res.status} ${res.statusText}`
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  return outPath;
}

// ---------------------------------------------------------------------------
// Dimension verification + correction
// ---------------------------------------------------------------------------
export interface DimensionCheck {
  actualWidth: number;
  actualHeight: number;
  corrected: boolean;
}

/**
 * Ensure the image at `imagePath` has exactly the target dimensions.
 *
 * Layer 2/3 of the dimension guarantee:
 *  - Small mismatches (model snaps to a multiple of 8/16) are silently
 *    sharp-corrected to the exact target. The file at `imagePath` is rewritten.
 *  - Large mismatches (max ratio > `upscaleThreshold` in either direction) throw,
 *    because correcting them would mean significant up- or down-scaling that
 *    degrades quality. The caller should generate at a smaller size and use a
 *    dedicated upscaler instead.
 *
 * Default threshold: 1.5x. So a request for 1728x2304 that comes back as
 * 1024x1366 (max ratio ~1.7x) will throw rather than silently produce a blurry
 * result.
 */
export async function verifyAndCorrectDimensions(
  imagePath: string,
  targetWidth: number,
  targetHeight: number,
  options: { upscaleThreshold?: number } = {}
): Promise<DimensionCheck> {
  const threshold = options.upscaleThreshold ?? 1.5;

  const inputBuffer = await readFile(imagePath);
  const meta = await sharp(inputBuffer).metadata();
  const actualWidth = meta.width ?? 0;
  const actualHeight = meta.height ?? 0;

  if (actualWidth === targetWidth && actualHeight === targetHeight) {
    return { actualWidth, actualHeight, corrected: false };
  }

  // Refuse to correct big mismatches — quality loss would be silent and bad.
  const ratios = [
    targetWidth / Math.max(actualWidth, 1),
    targetHeight / Math.max(actualHeight, 1),
    Math.max(actualWidth, 1) / targetWidth,
    Math.max(actualHeight, 1) / targetHeight,
  ];
  const maxRatio = Math.max(...ratios);
  if (maxRatio > threshold) {
    throw new Error(
      `Dimension mismatch too large for safe correction: requested ` +
      `${targetWidth}x${targetHeight}, model returned ${actualWidth}x${actualHeight} ` +
      `(max ratio ${maxRatio.toFixed(2)}x > ${threshold}x). ` +
      `Generate at a smaller size and use a dedicated upscaler.`
    );
  }

  // Small correction: resize to exact target. `cover` fills the requested
  // box and crops if aspect differs; for diffusion rounding (usually a few
  // pixels off in one dimension) this is effectively a no-op visually.
  const corrected = await sharp(inputBuffer)
    .resize(targetWidth, targetHeight, { fit: 'cover', position: 'center' })
    .toBuffer();
  await writeFile(imagePath, corrected);

  return { actualWidth, actualHeight, corrected: true };
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------
/**
 * Auto-generate an output path when the caller didn't specify one.
 * Format: dist/gen/YYYY-MM-DD-HHMM-<prompt-slug>-NN.<ext>
 */
export function buildAutoOutputPath(
  prompt: string,
  index: number,
  ext: 'png' | 'jpg' = 'png'
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = (prompt || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'image';
  const idx = String(index).padStart(2, '0');
  return path.join('dist', 'gen', `${ts}-${slug}-${idx}.${ext}`);
}

/**
 * Auto-generate an output path for an upscaled image.
 * Format: dist/gen/YYYY-MM-DD-HHMM-<input-stem>-upscaled-<scale>x.<ext>
 *
 * Uses the input filename's stem rather than a prompt slug, since the prompt
 * for upscalers is just quality-steering text ("masterpiece, best quality")
 * and not a meaningful descriptor of the asset.
 */
export function buildUpscaleOutputPath(
  inputPath: string,
  scale: number,
  ext: 'png' | 'jpg' = 'png'
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const stem = (path.parse(inputPath).name || 'image')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '') || 'image';
  // 2 -> "2", 2.9 -> "2.9", 2.95 -> "2.95"
  const scaleStr = Number(scale.toFixed(2)).toString();
  return path.join('dist', 'gen', `${ts}-${stem}-upscaled-${scaleStr}x.${ext}`);
}

/**
 * Inject a 1-based numeric index into an explicit output path when count>1.
 *   foo.png + (index=2, count=4) -> foo-02.png
 * When count<=1, returns basePath unchanged.
 */
export function indexOutputPath(
  basePath: string,
  index: number,
  totalCount: number
): string {
  if (totalCount <= 1) return basePath;
  const parsed = path.parse(basePath);
  const idx = String(index).padStart(2, '0');
  return path.join(parsed.dir, `${parsed.name}-${idx}${parsed.ext}`);
}
