-- Migration 0013: opportunity scanner v2 provenance + incomplete status.
--
-- The scanner is now two-phase (auto shortlist -> manual eRank pull -> real
-- scoring). Two changes to opportunity_scores (migration 0012):
--   1. data_source: where demand + attackability came from. Protects the
--      labeled-outcome layer — eRank-verified rows must never be silently
--      mixed with biased API-derived numbers.
--        - 'erank_verified'  : demand + attackability both from the eRank pull
--        - 'api_preliminary' : not eRank-sourced (e.g. excluded at AI-fit gate)
--        - 'incomplete'      : went through eRank phase but a pillar was blank
--   2. status now also allows 'incomplete' (a blank eRank field -> that pillar
--      is UNKNOWN and excluded from the composite; the row can't be 'scored').

alter table opportunity_scores
  add column if not exists data_source text;

alter table opportunity_scores
  drop constraint if exists opportunity_scores_status_check;

alter table opportunity_scores
  add constraint opportunity_scores_status_check
  check (status in ('scored', 'excluded', 'incomplete'));

alter table opportunity_scores
  drop constraint if exists opportunity_scores_data_source_check;

alter table opportunity_scores
  add constraint opportunity_scores_data_source_check
  check (data_source is null or data_source in ('erank_verified', 'api_preliminary', 'incomplete'));
