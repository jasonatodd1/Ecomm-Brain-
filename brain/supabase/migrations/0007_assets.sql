-- Migration 0007: assets — the queryable registry of every image/file
-- artifact the system produces or links manually. Replaces "grep the
-- activity log to find a hero image" with "SELECT * FROM assets WHERE
-- listing_id = ? AND kind = 'hero'". Required by the Listing Agent.
-- Run this in: Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              TEXT NOT NULL,
  listing_id        UUID REFERENCES listings (id) ON DELETE SET NULL,
  product_brief_id  UUID REFERENCES product_briefs (id) ON DELETE SET NULL,
  local_path        TEXT,
  cdn_url           TEXT,
  width             INTEGER,
  height            INTEGER,
  source            TEXT NOT NULL,
  fal_request_id    TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Text + CHECK over strict enum so adding a new kind/source is a one-line
  -- ALTER instead of a typed-enum migration dance. Listed values cover every
  -- artifact the current asset-producing tools emit
  -- (generate-image / upscale-image / build-print-bundle / resize-print-variants)
  -- plus the manual-link path. Update the CHECK list when a new producer ships.
  CONSTRAINT assets_kind_check CHECK (
    kind IN (
      'hero',              -- main listing photo (fal-generated)
      'lifestyle',         -- in-context shot
      'whats_included',    -- typographic "what you get" graphic
      'size_grid',         -- nested print-size comparison
      'lifestyle_detail',  -- close-up detail shot
      'source_file',       -- the canonical source/master artwork or PDF
      'print_variant',     -- one of the 5 sized print JPGs
      'master',            -- 5008×6680 print-master JPG
      'transparent',       -- background-removed PNG
      'ratio_guide',       -- single-page print-size reference PDF
      'crop_marks_pdf'     -- multi-page print-bundle PDF with crop marks
    )
  ),
  CONSTRAINT assets_source_check CHECK (
    source IN (
      'fal_generated',  -- generate-image.ts (FLUX.2 Pro)
      'fal_upscaled',   -- upscale-image.ts (Clarity)
      'fal_ui',         -- generated via fal.ai web UI / playground
      'render_graphic', -- render-graphic.ts (Puppeteer screenshot)
      'resize_print',   -- resize-print-variants.ts (legacy sized-only CLI)
      'render_planner', -- render-planner.ts (Puppeteer PDF)
      'build_bundle',   -- build-print-bundle.ts (full deliverable orchestrator)
      'manual_upload'   -- link:asset CLI for assets produced outside the system
    )
  )
);

-- "Find all assets for listing X" (Listing Agent fetches its own asset set).
CREATE INDEX IF NOT EXISTS assets_listing_id_idx
  ON assets (listing_id)
  WHERE listing_id IS NOT NULL;

-- "Find all assets for brief Y" (asset hand-off when a listing doesn't yet
-- exist — brief produced → assets generated → listing created).
CREATE INDEX IF NOT EXISTS assets_product_brief_id_idx
  ON assets (product_brief_id)
  WHERE product_brief_id IS NOT NULL;

-- "Find the hero for listing X" — composite supports the common Listing
-- Agent query: WHERE kind = ? AND listing_id = ?.
CREATE INDEX IF NOT EXISTS assets_kind_listing_id_idx
  ON assets (kind, listing_id);

COMMENT ON TABLE assets IS
  'Queryable registry of every image/file artifact the system produces or links manually. ' ||
  'Replaces "grep the activity log" for asset lookups. Listing Agent walks this table to ' ||
  'verify brief deliverables exist before publish, and to find hero / lifestyle / sized ' ||
  'images per listing. Server-write-only (no RLS) — same posture as listings_stats / ' ||
  'product_briefs / agent_runs. Inserts go through src/lib/assets.ts.';

COMMENT ON COLUMN assets.kind IS
  'What this asset is. CHECK-constrained; see migration 0007 for the canonical list.';

COMMENT ON COLUMN assets.local_path IS
  'Filesystem path under brain/ — e.g. ''products/<slug>/deliverables/master.jpg'' or ' ||
  '''dist/gen/2026-05-21-1255-vintage-watercolor-bunny--01.png''. Nullable because ' ||
  'CDN-only assets exist (fal upload before download, future Etsy CDN backfill).';

COMMENT ON COLUMN assets.cdn_url IS
  'External URL (fal CDN, Etsy CDN, etc.). Nullable — most local assets are not yet ' ||
  'uploaded anywhere. When both local_path and cdn_url are set, they represent the ' ||
  'same asset in two locations.';

COMMENT ON COLUMN assets.metadata IS
  'Producer-specific fields: prompt, seed, model, parent_asset_id (for upscales/variants), ' ||
  'reference_image_ids, cost_usd, duration_ms, page_count (for PDFs), etc.';
