-- Brain: autonomous e-commerce orchestrator
-- Migration 0001: initial schema
-- Run this in: Supabase Dashboard > SQL Editor > New query > paste > Run

create extension if not exists "vector";

-- =========================================================
-- signals: raw data points from external sources
-- (eRank, Pinterest, Google Trends, Reddit, TikTok, etc.)
-- =========================================================
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  keyword text not null,
  metric_type text not null,
  value numeric not null,
  metadata jsonb default '{}'::jsonb,
  collected_at timestamptz default now()
);

create index if not exists signals_keyword_idx on signals(keyword);
create index if not exists signals_source_collected_idx on signals(source, collected_at desc);

-- =========================================================
-- opportunities: synthesized niche/product opportunities
-- =========================================================
create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  niche text,
  confidence_score numeric check (confidence_score between 0 and 1),
  source_count integer default 0,
  velocity numeric,
  search_volume numeric,
  competition_score numeric,
  status text default 'new' check (status in ('new', 'investigating', 'committed', 'killed')),
  embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists opportunities_status_idx on opportunities(status);
create index if not exists opportunities_confidence_idx on opportunities(confidence_score desc);

-- =========================================================
-- listings: products in your store
-- =========================================================
create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  etsy_listing_id text unique,
  shopify_listing_id text unique,
  title text not null,
  description text,
  price_cents integer,
  status text default 'draft' check (status in ('draft', 'active', 'paused', 'killed')),
  opportunity_id uuid references opportunities(id),
  performance_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  killed_at timestamptz
);

create index if not exists listings_status_idx on listings(status);
create index if not exists listings_opportunity_idx on listings(opportunity_id);

-- =========================================================
-- activity: live feed of agent actions (dashboard subscribes)
-- =========================================================
create table if not exists activity (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent in ('intel', 'product', 'listing', 'customer_service', 'orchestrator', 'system')),
  action text not null,
  description text not null,
  severity text default 'info' check (severity in ('info', 'success', 'warning', 'error')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists activity_created_idx on activity(created_at desc);

-- =========================================================
-- decisions_needed: escalations awaiting your review
-- =========================================================
create table if not exists decisions_needed (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  context jsonb default '{}'::jsonb,
  urgency text default 'normal' check (urgency in ('low', 'normal', 'high', 'urgent')),
  resolved boolean default false,
  resolution text,
  resolution_notes text,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

create index if not exists decisions_unresolved_idx on decisions_needed(created_at desc) where resolved = false;

-- =========================================================
-- niche_memory: hypotheses with outcomes (the learning loop)
-- =========================================================
create table if not exists niche_memory (
  id uuid primary key default gen_random_uuid(),
  hypothesis text not null,
  prediction jsonb not null,
  actual_outcome jsonb,
  learnings text,
  related_opportunity_id uuid references opportunities(id),
  related_listing_id uuid references listings(id),
  embedding vector(1536),
  created_at timestamptz default now(),
  evaluated_at timestamptz
);

create index if not exists niche_memory_evaluated_idx on niche_memory(evaluated_at desc);

-- =========================================================
-- system_state: orchestrator runtime state (key-value)
-- =========================================================
create table if not exists system_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- =========================================================
-- cost_log: per-provider cost monitoring (Claude, Gemini, etc.)
-- =========================================================
create table if not exists cost_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  operation text not null,
  cost_cents numeric not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists cost_log_created_idx on cost_log(provider, created_at desc);

-- =========================================================
-- Enable realtime on tables the dashboard subscribes to
-- =========================================================
alter publication supabase_realtime add table activity;
alter publication supabase_realtime add table opportunities;
alter publication supabase_realtime add table decisions_needed;
alter publication supabase_realtime add table listings;

-- =========================================================
-- Seed initial system state
-- =========================================================
insert into system_state (key, value) values
  ('initialized_at', to_jsonb(now())),
  ('autonomy_caps', '{"daily_api_spend_cents": 2000, "max_price_adjustment_pct": 20, "max_new_listings_per_day": 10, "max_autonomous_price_cents": 7500}'::jsonb),
  ('agent_status', '{"intel": "stopped", "product": "stopped", "listing": "stopped", "customer_service": "stopped", "orchestrator": "stopped"}'::jsonb)
on conflict (key) do nothing;
