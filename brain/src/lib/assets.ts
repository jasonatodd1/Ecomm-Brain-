// Shared writer for the `assets` table (migration 0007).
//
// Every asset-producing tool (generate-image, upscale-image, build-print-bundle,
// resize-print-variants) and the manual `link:asset` CLI goes through this
// module so insert shape, validation, and failure handling are uniform.
//
// Failure posture: a failed asset insert prints `[ASSET_INSERT_FAILED]` to
// stderr (mirroring `[ACTIVITY_LOG_FAILED]` in log.ts) but does NOT throw.
// The producing tool already wrote the file to disk and logged an activity
// row; losing the asset-table row is recoverable via the `link:asset` CLI,
// whereas crashing the tool after the artifact landed on disk would be worse.
import { supabase } from './supabase.js';

export type AssetKind =
  | 'hero'
  | 'lifestyle'
  | 'whats_included'
  | 'size_grid'
  | 'lifestyle_detail'
  | 'source_file'
  | 'print_variant'
  | 'master'
  | 'transparent'
  | 'ratio_guide'
  | 'crop_marks_pdf';

export type AssetSource =
  | 'fal_generated'
  | 'fal_upscaled'
  | 'fal_ui'
  | 'render_graphic'
  | 'resize_print'
  | 'render_planner'
  | 'build_bundle'
  | 'manual_upload';

export const ASSET_KINDS: readonly AssetKind[] = [
  'hero',
  'lifestyle',
  'whats_included',
  'size_grid',
  'lifestyle_detail',
  'source_file',
  'print_variant',
  'master',
  'transparent',
  'ratio_guide',
  'crop_marks_pdf',
] as const;

export const ASSET_SOURCES: readonly AssetSource[] = [
  'fal_generated',
  'fal_upscaled',
  'fal_ui',
  'render_graphic',
  'resize_print',
  'render_planner',
  'build_bundle',
  'manual_upload',
] as const;

export interface InsertAssetInput {
  kind: AssetKind;
  source: AssetSource;
  /** Either listing_id or product_brief_id (or both) is recommended; both nullable in DB. */
  listing_id?: string;
  product_brief_id?: string;
  local_path?: string;
  cdn_url?: string;
  width?: number;
  height?: number;
  fal_request_id?: string;
  metadata?: Record<string, unknown>;
}

export interface InsertAssetResult {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  local_path: string | null;
}

/**
 * Insert one asset row. Returns the new row's id+kind+source on success, or
 * null on failure (after logging the error to stderr). Does NOT throw.
 */
export async function insertAsset(
  input: InsertAssetInput
): Promise<InsertAssetResult | null> {
  const row: Record<string, unknown> = {
    kind: input.kind,
    source: input.source,
    metadata: input.metadata ?? {},
  };
  if (input.listing_id) row.listing_id = input.listing_id;
  if (input.product_brief_id) row.product_brief_id = input.product_brief_id;
  if (input.local_path) row.local_path = input.local_path;
  if (input.cdn_url) row.cdn_url = input.cdn_url;
  if (typeof input.width === 'number') row.width = input.width;
  if (typeof input.height === 'number') row.height = input.height;
  if (input.fal_request_id) row.fal_request_id = input.fal_request_id;

  const { data, error } = await supabase
    .from('assets')
    .insert(row)
    .select('id, kind, source, local_path')
    .single();

  if (error) {
    console.error(
      '[ASSET_INSERT_FAILED]',
      error.message,
      '-- input:',
      JSON.stringify({
        kind: input.kind,
        source: input.source,
        local_path: input.local_path,
        listing_id: input.listing_id,
        product_brief_id: input.product_brief_id,
      })
    );
    return null;
  }

  return data as InsertAssetResult;
}

/**
 * Look up an existing asset by (kind, local_path) — used by the link:asset CLI
 * for idempotency. Returns null when no match exists. Throws on DB errors
 * (callers should treat a DB error as a hard stop, unlike the soft failure
 * posture of inserts).
 */
export async function findAssetByPath(
  kind: AssetKind,
  local_path: string
): Promise<InsertAssetResult | null> {
  const { data, error } = await supabase
    .from('assets')
    .select('id, kind, source, local_path')
    .eq('kind', kind)
    .eq('local_path', local_path)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`findAssetByPath failed: ${error.message}`);
  }
  return (data as InsertAssetResult | null) ?? null;
}
