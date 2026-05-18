-- Migration 0003: add unique constraint on opportunities.name
-- Required for ON CONFLICT (name) DO UPDATE upserts in the scoring engine

ALTER TABLE opportunities ADD CONSTRAINT opportunities_name_unique UNIQUE (name);
