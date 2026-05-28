-- Migration 0012: opportunity scanner results (attackability scoring engine)
-- One row per (run_date, keyword). Server-write-only; RLS off, same posture as
-- niche_bakeoff_results / listings_stats / product_briefs.

create table if not exists opportunity_scores (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  keyword text not null,
  -- Composite + three pillars (0-100).
  opportunity_score numeric,
  attackability numeric,
  demand numeric,
  ai_fit numeric,
  -- Headline raw signals (also mirrored in raw_signals jsonb for detail).
  demand_pool numeric,           -- modeled: sum(est_monthly_sales) across analyzed listings
  median_reviews numeric,        -- median review_count of top 10
  status text not null check (status in ('scored', 'excluded')),
  reason text,                   -- exclusion reason(s); null when scored
  wedge text,                    -- named attackable gap + product angle (Sonnet)
  rationale text,                -- one-line rationale (Sonnet)
  -- Detail bags.
  sub_scores jsonb default '{}'::jsonb,      -- invert_median_reviews, soft_ratio, youth_signal, seo_gap, specificity_gap
  raw_signals jsonb default '{}'::jsonb,     -- per-listing facts + estimate flags + analyzed_count etc.
  model_meta jsonb default '{}'::jsonb,      -- models used, token cost, est flags
  created_at timestamptz default now(),
  unique (run_date, keyword)
);

create index if not exists opportunity_scores_run_score_idx
  on opportunity_scores (run_date, opportunity_score desc nulls last);

create index if not exists opportunity_scores_keyword_idx
  on opportunity_scores (keyword);
