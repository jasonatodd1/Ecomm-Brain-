-- Migration 0009: white-space triangulation enrichment on opportunities
-- Populated by src/jobs/score-whitespace.ts (demand × supply-quality matrix).

alter table opportunities
  add column if not exists gap_classification text
    check (gap_classification in ('red_ocean', 'mixed', 'weak_incumbents', 'open_field')),
  add column if not exists incumbent_seo_median numeric,
  add column if not exists incumbent_engagement numeric check (incumbent_engagement between 0 and 1),
  add column if not exists supply_weakness numeric check (supply_weakness between 0 and 1),
  add column if not exists demand_combined numeric check (demand_combined between 0 and 1),
  add column if not exists white_space_score numeric check (white_space_score between 0 and 1),
  add column if not exists quadrant text
    check (quadrant in ('WHITE_SPACE', 'RED_OCEAN', 'DEAD_ZONE', 'MATURE')),
  add column if not exists gap_analysis jsonb default '{}'::jsonb;

create index if not exists opportunities_white_space_score_idx
  on opportunities (white_space_score desc nulls last);

create index if not exists opportunities_quadrant_idx
  on opportunities (quadrant)
  where quadrant is not null;
