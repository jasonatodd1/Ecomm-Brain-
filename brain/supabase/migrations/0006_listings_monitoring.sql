-- Migration 0006: listings monitoring (backfill + daily snapshots)
-- Run this in: Supabase Dashboard > SQL Editor

-- (a) Extend listings with Etsy mirror columns + relax title NOT NULL.
--     Title was originally meant for manually-authored draft titles. Now that
--     listings rows represent live Etsy listings being monitored, title is
--     sourced from Etsy on each snapshot — populated by monitor-listings.ts.
ALTER TABLE listings
  ALTER COLUMN title DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS views INTEGER,
  ADD COLUMN IF NOT EXISTS num_favorers INTEGER,
  ADD COLUMN IF NOT EXISTS etsy_state TEXT,
  ADD COLUMN IF NOT EXISTS tags JSONB,
  ADD COLUMN IF NOT EXISTS etsy_last_modified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ;

-- Unique on etsy_listing_id so seed-listings.ts can rely on it for idempotency
-- and so future joins from Etsy data are unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS listings_etsy_listing_id_unique
  ON listings (etsy_listing_id)
  WHERE etsy_listing_id IS NOT NULL;

COMMENT ON COLUMN listings.views IS 'Mirror of latest listings_stats.views — read current state without a JOIN';
COMMENT ON COLUMN listings.num_favorers IS 'Mirror of latest listings_stats.num_favorers';
COMMENT ON COLUMN listings.etsy_state IS 'Mirror of latest listings_stats.etsy_state (Etsy''s lifecycle state: active, sold_out, removed, etc.)';
COMMENT ON COLUMN listings.tags IS 'Mirror of latest listings_stats.tags (Etsy listing tags array)';
COMMENT ON COLUMN listings.etsy_last_modified_at IS 'Etsy''s own last_modified_timestamp — useful for detecting upstream edits between snapshots';
COMMENT ON COLUMN listings.last_snapshot_at IS 'When monitor-listings.ts last refreshed mirror columns on this row';

-- (b) listings_stats — append-only time series of every snapshot
CREATE TABLE IF NOT EXISTS listings_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  views INTEGER,
  num_favorers INTEGER,
  price_cents INTEGER,
  etsy_state TEXT,
  title TEXT,
  tags JSONB,
  etsy_last_modified_at TIMESTAMPTZ,
  raw JSONB
);

CREATE INDEX IF NOT EXISTS listings_stats_listing_snapshot_idx
  ON listings_stats (listing_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS listings_stats_snapshot_idx
  ON listings_stats (snapshot_at DESC);

COMMENT ON TABLE listings_stats IS 'Time-series snapshots of Etsy listing state captured by monitor-listings.ts. Append-only; never UPDATE rows here.';
COMMENT ON COLUMN listings_stats.raw IS 'Full Etsy API response for future-proofing — query new fields from history without re-fetching';
