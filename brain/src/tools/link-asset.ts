// link:asset — manual registry CLI for assets created outside the system.
//
// Usage:
//   npm run link:asset -- \
//     --listing-id=<uuid> \                                # or --etsy-listing-id=<numeric>
//     --product-brief-id=<uuid> \                          # optional, often the brief-only handoff
//     --kind=<hero|master|transparent|...> \
//     --path=<local-path-under-brain/> \
//     [--source=manual_upload] \                           # default
//     [--width=N] [--height=N] \                           # auto-read via sharp for images
//     [--cdn-url=<https://...>] \
//     [--fal-request-id=<...>]
//
// The bunny PNG, the planner PDF, and any future hand-uploaded asset goes
// through this CLI so the assets registry is the single source of truth.
// Idempotent on (kind, local_path) — re-runs print "already linked" and exit 0.
//
// Always writes an activity row with action='asset.linked' so the link event
// is itself audit-able. Errors halt and exit non-zero (unlike the soft-fail
// posture of insertAsset() inside producer tools — here, the operator is
// invoking the link explicitly and wants to know if it failed).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  insertAsset,
  findAssetByPath,
  ASSET_KINDS,
  ASSET_SOURCES,
  type AssetKind,
  type AssetSource,
} from '../lib/assets.js';
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

interface ParsedArgs {
  listingId?: string;
  etsyListingId?: string;
  productBriefId?: string;
  kind?: string;
  path?: string;
  source?: string;
  width?: number;
  height?: number;
  cdnUrl?: string;
  falRequestId?: string;
  metadata?: Record<string, unknown>;
  _help?: boolean;
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
      case 'listing-id':       out.listingId = val; break;
      case 'etsy-listing-id':  out.etsyListingId = val; break;
      case 'product-brief-id': out.productBriefId = val; break;
      case 'kind':             out.kind = val; break;
      case 'path':             out.path = val; break;
      case 'source':           out.source = val; break;
      case 'width':            out.width = Number(val); break;
      case 'height':           out.height = Number(val); break;
      case 'cdn-url':          out.cdnUrl = val; break;
      case 'fal-request-id':   out.falRequestId = val; break;
      case 'metadata':
        // Accept --metadata='{"foo":"bar"}' for arbitrary JSON blobs.
        try {
          out.metadata = JSON.parse(val);
        } catch {
          throw new Error(`--metadata must be valid JSON; got: ${val}`);
        }
        break;
      default: console.warn(`> ignoring unknown flag: --${key}`);
    }
  }
  return out;
}

function usage(): never {
  console.error('');
  console.error('Usage: npm run link:asset -- [args]');
  console.error('');
  console.error('Identity (at least ONE required):');
  console.error('  --listing-id=<uuid>           listings.id (uuid)');
  console.error('  --etsy-listing-id=<numeric>   numeric Etsy listing id — auto-resolved to listings.id');
  console.error('  --product-brief-id=<uuid>     product_briefs.id (uuid)');
  console.error('');
  console.error('Required:');
  console.error(`  --kind=<value>                One of: ${ASSET_KINDS.join(' | ')}`);
  console.error('  --path=<local-path>           Path under brain/, e.g. products/.../master.jpg');
  console.error('');
  console.error('Optional:');
  console.error(`  --source=<value>              One of: ${ASSET_SOURCES.join(' | ')}.  Default: manual_upload`);
  console.error('  --width=N --height=N          Asset dimensions. Auto-read via sharp for images.');
  console.error('  --cdn-url=<https://...>       External URL (fal CDN, Etsy CDN, etc.)');
  console.error('  --fal-request-id=<...>        fal request id (when applicable)');
  console.error('  --metadata=\'<json>\'           Arbitrary JSON blob merged into metadata column');
  console.error('');
  console.error('Behavior:');
  console.error('  - Verifies --path exists. Aborts non-zero otherwise.');
  console.error('  - Idempotent on (kind, path): re-runs are a no-op + exit 0.');
  console.error('  - Writes activity row with action=asset.linked on success.');
  console.error('');
  process.exit(1);
}

// Auto-detect width+height for raster images. PDFs and other non-images
// silently no-op (sharp.metadata throws "unsupported image format").
async function readImageDims(
  localPath: string
): Promise<{ width?: number; height?: number }> {
  try {
    const buffer = await readFile(localPath);
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height) {
      return { width: meta.width, height: meta.height };
    }
  } catch {
    /* not a sharp-readable image — leave dims undefined */
  }
  return {};
}

// Resolve a numeric Etsy listing id → listings.id uuid via Supabase.
async function resolveEtsyListingId(etsyId: string): Promise<string> {
  const { data, error } = await supabase
    .from('listings')
    .select('id')
    .eq('etsy_listing_id', etsyId)
    .maybeSingle();
  if (error) {
    throw new Error(`Lookup of etsy_listing_id=${etsyId} failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `No listings row with etsy_listing_id=${etsyId}. ` +
      `Seed the listing first (npm run seed:listings), or pass --listing-id=<uuid> directly.`
    );
  }
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._help) usage();

  if (!parsed.kind) {
    console.error('✗ --kind is required');
    usage();
  }
  if (!parsed.path) {
    console.error('✗ --path is required');
    usage();
  }
  if (!parsed.listingId && !parsed.etsyListingId && !parsed.productBriefId) {
    console.error('✗ at least one of --listing-id / --etsy-listing-id / --product-brief-id is required');
    usage();
  }

  // ----- Validate kind / source against the CHECK constraint -----
  if (!ASSET_KINDS.includes(parsed.kind as AssetKind)) {
    throw new Error(
      `Invalid --kind="${parsed.kind}". Must be one of: ${ASSET_KINDS.join(', ')}`
    );
  }
  const source = (parsed.source ?? 'manual_upload') as AssetSource;
  if (!ASSET_SOURCES.includes(source)) {
    throw new Error(
      `Invalid --source="${source}". Must be one of: ${ASSET_SOURCES.join(', ')}`
    );
  }

  // ----- Resolve listing_id (uuid) -----
  let listingId = parsed.listingId;
  if (!listingId && parsed.etsyListingId) {
    listingId = await resolveEtsyListingId(parsed.etsyListingId);
    console.log(`> resolved etsy_listing_id=${parsed.etsyListingId} → listings.id=${listingId}`);
  }

  // ----- Verify path exists -----
  const absPath = path.resolve(parsed.path!);
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      throw new Error(`${absPath} is not a regular file`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--path does not exist or is unreadable: ${absPath} (${msg})`);
  }

  // ----- Auto-detect dims if not provided + path is an image -----
  let width = parsed.width;
  let height = parsed.height;
  if (width === undefined || height === undefined) {
    const dims = await readImageDims(absPath);
    width = width ?? dims.width;
    height = height ?? dims.height;
  }

  // ----- Idempotency check on (kind, local_path) -----
  const existing = await findAssetByPath(
    parsed.kind as AssetKind,
    parsed.path!
  );
  if (existing) {
    console.log(
      `~ already linked: assets.id=${existing.id} kind=${existing.kind} path=${existing.local_path}`
    );
    console.log('  (no-op — exit 0)');
    return;
  }

  // ----- Insert -----
  const row = await insertAsset({
    kind: parsed.kind as AssetKind,
    source,
    listing_id: listingId,
    product_brief_id: parsed.productBriefId,
    local_path: parsed.path,
    cdn_url: parsed.cdnUrl,
    width,
    height,
    fal_request_id: parsed.falRequestId,
    metadata: {
      ...(parsed.metadata ?? {}),
      linked_via: 'link:asset',
      cli_invocation_at: new Date().toISOString(),
    },
  });

  if (!row) {
    // insertAsset already printed [ASSET_INSERT_FAILED] — escalate to exit 1
    // because the operator invoked this explicitly.
    throw new Error('Asset insert failed — see [ASSET_INSERT_FAILED] above');
  }

  console.log('');
  console.log(`✓ linked asset`);
  console.log(`  id:          ${row.id}`);
  console.log(`  kind:        ${row.kind}`);
  console.log(`  source:      ${row.source}`);
  console.log(`  path:        ${row.local_path ?? '(none)'}`);
  if (listingId) console.log(`  listing_id:  ${listingId}`);
  if (parsed.productBriefId) console.log(`  brief_id:    ${parsed.productBriefId}`);
  if (width && height) console.log(`  dimensions:  ${width}×${height}`);

  await log({
    agent: 'product',
    action: 'asset.linked',
    description: `Linked ${row.kind} asset at ${row.local_path ?? row.id}`,
    severity: 'success',
    metadata: {
      asset_id: row.id,
      kind: row.kind,
      source: row.source,
      local_path: row.local_path,
      listing_id: listingId,
      product_brief_id: parsed.productBriefId,
      width,
      height,
      cdn_url: parsed.cdnUrl,
      fal_request_id: parsed.falRequestId,
    },
  });
}

const isEntryPoint =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isEntryPoint) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('');
    console.error(`✗ link:asset failed: ${msg}`);
    process.exit(1);
  });
}
