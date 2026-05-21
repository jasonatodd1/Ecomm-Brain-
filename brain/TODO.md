# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus

### Drive first sale (both listings live, daily monitor capturing baseline)
- [ ] Run `npm run monitor:listings` daily by hand for 3–5 days before scheduling cron — confirms baseline behavior, surfaces edge cases (state changes, sold_out, tag edits, etc.) per principle #7
- [ ] Add `FAL_KEY` to Railway Variables before any deployed code path imports `src/lib/fal.ts` (currently only in `.env.local`)
- [ ] First sale (validation milestone) — both listings active, awaiting market signal

## Data-Quality Bugs (open)
- [ ] `opportunities.niche` field is null on every row — likely scoring engine omission
- [ ] `opportunities.source_count` stuck at 1 across all rows — scoring engine doesn't aggregate signals across collection runs (re-confirmation should bump this)
- [ ] Reddit `post_url` missing from `signals.metadata` — only lives on the opportunity row, breaks signal→opportunity traceability for Reddit signals

## Backlog (committed, deferred)
- [ ] Drop dead keywords from seed list (digital planner, printable wall art, custom invitation template); investigate or remove gratitude journal printable (SerpApi failure case)
- [ ] `expense.ts` utility for programmatic cost logging (no more raw SQL inserts)
- [ ] Per-provider cost caps with daily limits (runaway-spend guardrail)
- [ ] Model router abstraction (Opus / Sonnet / Haiku / Gemini swap without code changes)
- [ ] Cron scheduling on Railway (after scoring engine validated AND after 3–5 days of manual `monitor:listings` runs validate output — listings monitor is the most immediate cron candidate; collectors next)
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
- [ ] **Competitive SEO Scoring engine** — full spec in `brain/COMPETITIVE_SEO_SCORING.md`. Shared library `brain/src/lib/etsy-seo-scoring.ts` consumed by BOTH Research Agent (supply-side gap discovery during market analysis) and Listing Agent (pre-publish quality gate + post-publish drift monitoring). Strategic edge: demand × (1/supply quality), not demand alone — turns the brain's market analysis into a competitive-gap detector instead of a demand-only signal.
  - [ ] Add `brief.competitive_landscape` to `ProductBrief` schema with placeholder shape (top-3 incumbents per keyword) — see `COMPETITIVE_SEO_SCORING.md` §6 step 1. Ships as part of Tuning Pass 2.
  - [ ] Implement `scoreEtsyListingSeo()` per `COMPETITIVE_SEO_SCORING.md` §2-§3 (10 rules, deterministic, no LLM, pure function). Either end-of-Tuning-Pass-2 or its own milestone before Listing Agent.
  - [ ] Wire competitive scoring into research synthesis prompt — flag weak-incumbent gaps in `brief.reasoning` (§4).
  - [ ] Score every `monitor-listings.ts` snapshot and surface week-over-week drift (§5).
  - [ ] Add `etsy_seo_gap` as a new signal type — only when Listing Agent ships (§6 step 6).
- [ ] **Listing Agent** — full spec in `brain/LISTING_AGENT_REQUIREMENTS.md`. Store-agnostic core + per-store adapters (Etsy first, Pinterest next, Shopify deferred). Replaces the old "Etsy listing automation" placeholder. Consumes the shared SEO scoring engine above as a downstream consumer per `LISTING_AGENT_REQUIREMENTS.md` §3.
  - [ ] Migration `0007_assets.sql` — new `assets` table (kind/listing_id/product_brief_id/dimensions/source/cdn_url/fal_request_id). Listing Agent prerequisite per §6 of the spec.
  - [ ] `gen` + `upscale` tools UPSERT into `assets` in addition to `activity` (per §6).
  - [ ] `npm run link:asset` CLI for backfilling assets generated outside the system — bunny + planner pre-date the gen tool and need linking before the agent ships (per §6).
  - [ ] Research Agent **Tuning Pass 2** — schema changes that must ship before the Listing Agent can be built (per `LISTING_AGENT_REQUIREMENTS.md` §7; also see `COMPETITIVE_SEO_SCORING.md` §6 for sequencing with the scoring engine):
    - [ ] Promote `audience.persona` to first-class structured field
    - [ ] Replace `listing.description_angles` with structured `listing.description = { hook, body_sections[], faq[], cta }`
    - [ ] Replace `listing.etsy_attributes` with semantic `listing.attribute_intent = { style_descriptors, audience_descriptors, occasion_descriptors, color_descriptors, materials_intent }` — Research Agent never enumerates raw store values
    - [ ] Add `listing.image_spec[]` — explicit slot manifest (hero / lifestyle / what's-included / size-grid / detail) with dims + style notes
    - [ ] Add `listing.shop_section_suggestion` — single name string
    - [ ] Add `listing.competitive_landscape` (per `COMPETITIVE_SEO_SCORING.md` §4) — bundled into Tuning Pass 2 so the schema + the scorer land together
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

## Done

### First Listings Live on Etsy (HillwardStudio)
- [x] A5 Monthly Calendar Printable — `etsy_listing_id` 4508059444 — $3.49 — opportunity `c3fa0a4d…` (planneraddicts Reddit buyer)
- [x] Vintage Bunny Nursery Wall Art — `etsy_listing_id` 4508704536 — $4.49 — opportunity `d7750211…` (nursery wall art printable)

### Listings Backfill + Daily Monitoring
- [x] Migration 0006 (`listings_monitoring`): mirror columns on `listings` (views, num_favorers, etsy_state, tags, etsy_last_modified_at, last_snapshot_at), unique index on `etsy_listing_id`, `listings_stats` time-series table with `raw` jsonb for future-proofing, indexes on `(listing_id, snapshot_at DESC)` and `(snapshot_at DESC)`
- [x] `getListing()` added to `brain/src/lib/etsy-search.ts` — reuses keystring:shared_secret auth, returns normalized struct + sanitized raw response; supporting helpers `sanitizeDeep` (recursive jsonb sanitization) and `priceToCents`
- [x] `seed-listings.ts` + `npm run seed:listings` — idempotent SELECT-then-INSERT by `etsy_listing_id`
- [x] `monitor-listings.ts` + `npm run monitor:listings` — concurrent (2 in-flight, 200ms stagger), inserts `listings_stats` first then updates mirror columns; activity row per snapshot (`listing.snapshotted`); separate warning if mirror UPDATE fails post-snapshot; exits non-zero on any failure
- [x] Both live listings seeded + first snapshot captured: A5 planner (6 views / 0 favorers / $3.49 / 13 tags / active), bunny print (4 views / 0 favorers / $4.49 / 12 tags / active)
- [x] `opportunity_id` wired on both listings for full signal → opportunity → listing traceability

### Image Generation Infra (fal.ai)
- [x] `brain/src/lib/fal.ts` — shared infra: configured client (auths via `FAL_KEY`), `MODEL_ALIASES` (`flux-pro`, `flux-pro-edit`, `clarity`), cost estimators, `resolveReferenceImage` (uploads local paths to fal CDN), `downloadImage`, `verifyAndCorrectDimensions` (layer 2/3 dimension guarantee — silent sharp correction <1.5×, throws if larger), output path builders (`buildAutoOutputPath`, `buildUpscaleOutputPath`, `indexOutputPath`), `formatFalValidationError` (extracts `err.body.detail[]`)
- [x] `brain/src/tools/generate-image.ts` + `npm run gen` — FLUX.2 Pro text-to-image and edit (multi-ref, up to 9). CLI + programmatic. Activity row per generation (`image.generated`)
- [x] `brain/src/tools/upscale-image.ts` + `npm run upscale` — Clarity Upscaler with faithful-tuning defaults (`creativity=0.1`, `resemblance=1.0`). Supports `--scale` or `--size` with sharp post-correction
- [x] Smoke tests passed end-to-end: vintage bunny generated at 1728×2304 ($0.075, 22s), upscaled to 5008×6680 ($0.10, 70s, dimensions exact, `corrected_from` null)
- [x] `buildAutoOutputPath` double-hyphen slug bug fixed (commit `0d1b419`)
- [x] Clarity `resemblance` default lowered from 1.5 → 1.0 (fal API requires ≤1)
- [x] `formatFalValidationError` helper surfaces fal 422 `body.detail[]` in both gen + upscale tools (no more silent "Unprocessable Entity")

### Code-based Asset Pipeline
- [x] Code-based PDF rendering (Puppeteer + HTML/CSS) for HillwardStudio A5 monthly planner — `npm run render:planner`
- [x] 28-page A5 planner template authored: cover + 24 monthly spreads + 3 notes pages; v3 with SVG dot grid, editorial cover, weekend tint, priorities sidebar
- [x] `render-graphic.ts` + `npm run render:graphic` — generic HTML → PNG/JPEG screenshot tool (format auto-detected from output extension; JPEG quality 92)
- [x] `resize-print-variants.ts` + `npm run resize:print` — 5 print sizes (8×10, 11×14, 16×20, 18×24, 24×36) from a 5008×6680 master via `sharp.extract`

### Infrastructure
- [x] Supabase project with 12 tables (signals, opportunities, listings, listings_stats, activity, decisions_needed, niche_memory, system_state, cost_log, agent_config, agent_runs, product_briefs) + RLS enabled on the core 8
- [x] Railway service deployed (us-west2 region) with GitHub auto-deploy
- [x] HillwardStudio Etsy seller account opened
- [x] MCPs connected: Supabase, Railway, Vercel

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
