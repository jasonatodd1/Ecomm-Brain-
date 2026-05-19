# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus
- [ ] (none — Research Agent + Etsy integration complete; next major milestone is Product Creation Agent)

## Backlog (committed, deferred)
- [ ] Drop dead keywords from seed list (digital planner, printable wall art, custom invitation template); investigate or remove gratitude journal printable (SerpApi failure case)
- [ ] `expense.ts` utility for programmatic cost logging (no more raw SQL inserts)
- [ ] Per-provider cost caps with daily limits (runaway-spend guardrail)
- [ ] Model router abstraction (Opus / Sonnet / Haiku / Gemini swap without code changes)
- [ ] Cron scheduling on Railway (after scoring engine validated)
- [ ] Scoring formula ceiling: multiple Google Trends keywords hitting confidence 1.000 — lost discrimination at top, needs refactor (higher ceiling, log scale, or different math)
- [ ] Google Trends velocity volatility: keywords can swing from +8% to +494% in one cycle. Need historical tracking and a stability score before trusting single-run velocity
- [ ] LLM cost tracking integration with cost_log table (currently logging cost.api_call activity events but not aggregating)
- [ ] Etsy 429 retry with exponential backoff (concurrency limit eliminated burst 429s; transient ones still possible — add retry honoring Retry-After header)
- [ ] niche_memory confidence-bump mechanism (currently stuck at 0.50 regardless of evidence_count; confidence should grow with re-confirmation)
- [ ] Monitor synthesis token usage to confirm headroom under max_tokens (one earlier run truncated at 4000; watch as briefs grow with richer data)

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

### Reddit Precision
- [x] Subreddit categorization (buyer / seller / mixed) added to collect-reddit.ts
- [x] Claude Haiku 4.5 intent classifier (src/lib/classify-intent.ts) for mixed/buyer subreddits
- [x] Reclassification script (src/jobs/reclassify-reddit-signals.ts) for backfilling existing signals
- [x] ANTHROPIC_API_KEY configured in .env.local and Railway

### Research Agent V1
- [x] Foundation schemas: agent_config, agent_runs, product_briefs, decisions_needed.status, niche_memory key-value columns (migration 0005)
- [x] PRINCIPLES.md created — living architecture doc
- [x] Research Agent built (brain/src/agents/research/): claims decision, pulls niche_memory, extracts keywords (Opus), queries Etsy (currently stubbed), pre-computes market aggregates in code, synthesizes brief (Opus), drift detection, writes opportunity_gaps to niche_memory, advances decision to brief_ready, full audit trail in agent_runs
- [x] Markdown renderer for human-readable briefs
- [x] First brief produced for planneraddicts decision (recommendation: proceed, confidence: 62% — capped honestly due to zero market data)

### Etsy Open API v3 Integration
- [x] Etsy Developer App approved (HillwardStudio Internal)
- [x] Etsy Open API v3 client (brain/src/lib/etsy-search.ts) with keystring:shared_secret auth (Feb 2026 requirement)
- [x] getShop() enrichment via /shops/{shop_id} for top_sellers (shop_name, shop_url, review_count, review_average)
- [x] Concurrency limiter (brain/src/lib/concurrency.ts): max 2 in-flight, 200ms stagger
- [x] Second research run on planneraddicts decision with real market data (111 listings, recommendation: PROCEED ~72% confidence)
- [x] niche_memory closed-loop verified: 4 opportunity gaps from v1 brief re-confirmed in v2 (evidence_count=2)
