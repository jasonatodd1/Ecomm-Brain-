-- Migration 0008: add artwork_flat asset kind
-- Flat product artwork on a neutral background (no room scene) — distinct from
-- hero/lifestyle mockups and size_grid deliverables graphics.

ALTER TABLE assets DROP CONSTRAINT assets_kind_check;

ALTER TABLE assets ADD CONSTRAINT assets_kind_check CHECK (
  kind IN (
    'hero',
    'lifestyle',
    'whats_included',
    'size_grid',
    'lifestyle_detail',
    'artwork_flat',
    'source_file',
    'print_variant',
    'master',
    'transparent',
    'ratio_guide',
    'crop_marks_pdf'
  )
);

COMMENT ON COLUMN assets.kind IS
  'What this asset is. CHECK-constrained; includes artwork_flat (flat print-on-background, no room scene).';
