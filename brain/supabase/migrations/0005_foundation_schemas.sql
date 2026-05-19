-- Migration 0005: foundation schemas
-- Adds coordination, agent infrastructure, memory, and product brief tables.
-- Run this in: Supabase Dashboard > SQL Editor

-- (a) Coordination columns on decisions_needed
ALTER TABLE decisions_needed
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS decisions_needed_status_idx ON decisions_needed (status);

ALTER TABLE decisions_needed
  ADD CONSTRAINT decisions_needed_status_check
  CHECK (status IN ('open', 'researching', 'brief_ready', 'product_ready', 'listed', 'failed', 'rejected'));

-- (b) agent_config table
CREATE TABLE IF NOT EXISTS agent_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_name, config_key)
);
CREATE INDEX IF NOT EXISTS agent_config_agent_idx ON agent_config (agent_name);

-- (c) agent_runs table
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  input_ref TEXT,
  output_ref TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cost_usd NUMERIC(10,4) DEFAULT 0,
  model_used TEXT,
  assumptions JSONB,
  metadata JSONB DEFAULT '{}'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_status_idx ON agent_runs (agent_name, status);
CREATE INDEX IF NOT EXISTS agent_runs_input_ref_idx ON agent_runs (input_ref);

-- (d) Extend niche_memory with key-value pattern columns
ALTER TABLE niche_memory
  ADD COLUMN IF NOT EXISTS niche_tag TEXT,
  ADD COLUMN IF NOT EXISTS memory_key TEXT,
  ADD COLUMN IF NOT EXISTS memory_value JSONB,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS evidence_count INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS niche_memory_niche_key_unique
  ON niche_memory (niche_tag, memory_key)
  WHERE niche_tag IS NOT NULL AND memory_key IS NOT NULL;

-- (e) product_briefs table
CREATE TABLE IF NOT EXISTS product_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID REFERENCES decisions_needed (id),
  brief JSONB NOT NULL,
  raw_research JSONB DEFAULT '{}'::jsonb,
  markdown TEXT,
  recommendation TEXT CHECK (recommendation IN ('proceed', 'pivot', 'pass')),
  confidence NUMERIC(3,2),
  cost_usd NUMERIC(10,4) DEFAULT 0,
  generated_at TIMESTAMPTZ DEFAULT now(),
  agent_version TEXT
);
CREATE INDEX IF NOT EXISTS product_briefs_decision_idx ON product_briefs (decision_id);
CREATE INDEX IF NOT EXISTS product_briefs_recommendation_idx ON product_briefs (recommendation);

-- (f) Drop deprecated resolved column on decisions_needed (status is canonical)
UPDATE decisions_needed SET status = 'rejected' WHERE resolved = true;
ALTER TABLE decisions_needed DROP COLUMN resolved;

-- (g) Relax niche_memory hypothesis/prediction NOT NULL for key-value pattern coexistence
ALTER TABLE niche_memory
  ALTER COLUMN hypothesis DROP NOT NULL,
  ALTER COLUMN prediction DROP NOT NULL;

COMMENT ON COLUMN niche_memory.hypothesis IS 'Testable prediction for outcome attribution; null if entry is general key-value knowledge';
COMMENT ON COLUMN niche_memory.memory_key IS 'For key-value pattern: stable identifier within niche_tag';
COMMENT ON COLUMN niche_memory.memory_value IS 'For key-value pattern: arbitrary structured value';
