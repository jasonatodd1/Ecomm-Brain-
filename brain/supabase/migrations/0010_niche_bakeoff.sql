-- Migration 0010: niche bake-off results (isolated from opportunities pool)

create table if not exists niche_bakeoff_runs (
  id uuid primary key default gen_random_uuid(),
  run_label text not null unique,
  treatment text not null default 'baseline',
  pinterest_enabled boolean not null default false,
  keyword_count integer not null default 0,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists niche_bakeoff_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references niche_bakeoff_runs(id) on delete cascade,
  keyword text not null,
  niche text not null,
  is_anchor_niche boolean not null default false,
  producibility text not null check (producibility in ('digital', 'physical-POD', 'dropship')),
  google_demand numeric,
  pinterest_demand numeric,
  external_demand numeric,
  incumbent_engagement numeric,
  demand_combined numeric,
  gap_classification text,
  incumbent_seo_median numeric,
  supply_weakness numeric,
  white_space_score numeric,
  quadrant text,
  result_count integer,
  coherence_score numeric,
  flags jsonb default '[]'::jsonb,
  gap_analysis jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (run_id, keyword)
);

create index if not exists niche_bakeoff_results_run_ws_idx
  on niche_bakeoff_results (run_id, white_space_score desc nulls last);

create index if not exists niche_bakeoff_results_run_niche_idx
  on niche_bakeoff_results (run_id, niche);
