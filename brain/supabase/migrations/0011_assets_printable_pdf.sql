-- Migration 0011: add printable_pdf asset kind
--
-- For digital-download products where the PDF IS the deliverable that buyers
-- download (e.g. the meal planner), as distinct from:
--   - source_file: canonical master artwork BEHIND a deliverable
--   - crop_marks_pdf: print-shop bundle with crop marks (wall-art bundles)
--   - ratio_guide: single-page size reference (wall-art companion)
--
-- A printable_pdf is the customer-facing deliverable for printable products
-- like planners, trackers, charts, lists. Multiple printable_pdf rows per
-- product_brief_id is the norm (variants: paper size × week-start × ...).

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
    'crop_marks_pdf',
    'printable_pdf'
  )
);

COMMENT ON COLUMN assets.kind IS
  'What this asset is. CHECK-constrained; includes printable_pdf ' ||
  '(customer-facing PDF deliverable for printable products — planners, trackers, charts).';
