# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus

### HillwardStudio A5 Monthly Planner v1 — manual fulfillment via code pipeline
- [x] Code-based PDF rendering pipeline (Puppeteer + HTML/CSS)
- [ ] Real 28-page template authored by Claude
- [ ] Iteration to production-ready quality
- [ ] Listing photos via fal.ai
- [ ] Etsy shop setup (in parallel)
- [ ] Listing creation and publish

## Data-Quality Bugs (open)
- [ ] `opportunities.niche` field is null on every row — likely scoring engine omission
- [ ] `opportunities.source_count` stuck at 1 across all rows — scoring engine doesn't aggregate signals across collection runs (re-confirmation should bump this)
- [ ] Reddit `post_url` missing from `signals.metadata` — only lives on the opportunity row, breaks signal→opportunity traceability for Reddit signals

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
- [ ] CLI tool to render any brief from Supabase by ID (`npm run brief -- --id=<uuid>`) — replaces committing markdown to git
- [ ] Decide on `brain/briefs/` git tracking strategy (currently committed; canonical lives in Supabase). Consider gitignore + CLI render tool.

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

### Research Agent Tuning Pass 1
- [x] Synthesis prompt v2 (brain/src/agents/research/prompts.ts): 6 improvements — (1) positive-title rule forbidding "NOT a X" negations, (2) explicit volume-vs-premium pricing choice with competitive citation, (3) MVP scoping default for first-in-niche products, (4) RISK MITIGATIONS forbidding community-rule violations (no subreddit cross-posting), (5) NEW SHOP CONTEXT acknowledging HillwardStudio's 0-review reputation deficit, (6) cross-category field annotations for sizes/page_count/includes so the schema works for wall art and SVG bundles, not just planners
- [x] v4 brief produced (0834bacd-0727-4487-9ef3-ccd0a1c4f34c): MVP scope (28 pages, A5 only, undated), volume pricing ($3.49 vs v3's $6.50), positive-framed title, new-shop risk HIGH-severity, zero community-rule violations

### Cross-Category Validation
- [x] Seeded second research decision: nursery wall art printable (decision 2af0ba72, opportunity d7750211)
- [x] NUL-byte / control-char sanitizer added to brain/src/lib/etsy-search.ts (`sanitizeForJsonb`) — fixes Postgres jsonb rejecting raw Etsy listing data ("Empty or invalid json" error on wall-art listings)
- [x] Nursery wall art brief produced (ea836ab6-0938-40cf-8523-0694774c12c5, PROCEED 0.62): cross-category prompt annotations all worked — page_count=1, sizes=imperial print sizes (8x10"…24x36"), includes=file/size variants, NOT planner conventions. Vintage bunny print, volume pricing $4.49, IP-protection risk noted (Beatrix Potter), Pinterest as growth lever
