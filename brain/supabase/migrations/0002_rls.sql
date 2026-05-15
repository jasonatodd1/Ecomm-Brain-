-- Brain: RLS migration
-- Migration 0002: enable Row Level Security + read policies
-- Run after 0001_init.sql in: Supabase Dashboard > SQL Editor

-- =========================================================
-- Enable RLS on all tables
-- =========================================================
-- With RLS enabled and no policies, all client-side access is denied
-- by default. The orchestrator writes via service_role, which bypasses
-- RLS automatically — so we only need read policies for the dashboard.

alter table signals enable row level security;
alter table opportunities enable row level security;
alter table listings enable row level security;
alter table activity enable row level security;
alter table decisions_needed enable row level security;
alter table niche_memory enable row level security;
alter table system_state enable row level security;
alter table cost_log enable row level security;

-- =========================================================
-- Read policies: authenticated users can read everything
-- =========================================================
-- Since this is a single-operator system, "authenticated" effectively
-- means "you" — only your magic-link email will be configured for auth.
-- The dashboard reads use these policies. All writes go through the
-- orchestrator (service_role, bypasses RLS) or future server-side API
-- routes that also use service_role.

create policy "authenticated read signals"
  on signals for select
  using (auth.role() = 'authenticated');

create policy "authenticated read opportunities"
  on opportunities for select
  using (auth.role() = 'authenticated');

create policy "authenticated read listings"
  on listings for select
  using (auth.role() = 'authenticated');

create policy "authenticated read activity"
  on activity for select
  using (auth.role() = 'authenticated');

create policy "authenticated read decisions_needed"
  on decisions_needed for select
  using (auth.role() = 'authenticated');

create policy "authenticated read niche_memory"
  on niche_memory for select
  using (auth.role() = 'authenticated');

create policy "authenticated read system_state"
  on system_state for select
  using (auth.role() = 'authenticated');

create policy "authenticated read cost_log"
  on cost_log for select
  using (auth.role() = 'authenticated');
