# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus
- [ ] Validation/research agent for planneraddicts opportunity → product brief

## Backlog (committed, deferred)
- [ ] Reddit precision fix: filter false positives, weight by buyer vs seller subreddit, optionally add Claude intent classifier
- [ ] Drop dead keywords from seed list (digital planner, printable wall art, custom invitation template); investigate or remove gratitude journal printable (SerpApi failure case)
- [ ] `expense.ts` utility for programmatic cost logging (no more raw SQL inserts)
- [ ] Per-provider cost caps with daily limits (runaway-spend guardrail)
- [ ] Model router abstraction (Opus / Sonnet / Haiku / Gemini swap without code changes)
- [ ] Cron scheduling on Railway (after scoring engine validated)
- [ ] Anthropic API key in Railway env (needed before any LLM-using agent runs)

## Future (after first sale validation)
- [ ] Product creation agent (design generation via Recraft/Ideogram/Flux, PDF assembly)
- [ ] Etsy listing automation (auto-publish, image upload, description, pricing)
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

## Done

### Infrastructure
- [x] Supabase project with 8 tables (signals, opportunities, listings, activity, decisions_needed, niche_memory, system_state, cost_log) + RLS enabled
- [x] Railway service deployed (us-west2 region) with GitHub auto-deploy
- [x] HillwardStudio Etsy seller account opened
- [x] MCPs connected: Supabase (read-only), Railway, Vercel

### Signal Collection
- [x] SerpApi Google Trends collector (9 working keywords)
- [x] Reddit OAuth collector + buyer-intent regex (7 subreddits)
- [x] Resilient activity logger with `[ACTIVITY_LOG_FAILED]` escalation

### Scoring
- [x] Scoring engine MVP (Google Trends + Reddit passes, capped velocity, upserts to opportunities)
- [x] planneraddicts decision row seeded
