# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus

### Fix the 3 data-quality bugs (closes the discovery-pipeline loop before Listing Agent build)
- [ ] `opportunities.niche` field is null on every row — likely scoring engine omission
- [ ] `opportunities.source_count` stuck at 1 across all rows — scoring engine doesn't aggregate signals across collection runs (re-confirmation should bump this)
- [ ] Reddit `post_url` missing from `signals.metadata` — only lives on the opportunity row, breaks signal→opportunity traceability for Reddit signals

### Drive first sale (both listings live, daily monitor capturing baseline)
- [ ] Run `npm run monitor:listings` daily by hand for 3–5 days before scheduling cron — confirms baseline behavior, surfaces edge cases (state changes, sold_out, tag edits, etc.) per principle #7
- [ ] First sale (validation milestone) — both listings active, awaiting market signal

## Data-Quality Bugs (open)
- _All three currently in Current Focus above; fix lands next._

## Backlog (committed, deferred)
- [ ] **Asset pipeline gap (Listing Agent prerequisite).** v2 bunny brief claims deliverables that the current `resize-print-variants.ts` pipeline does NOT yet produce: master JPG at 300 DPI sized for all 5 print sizes (have JPGs but not packaged as one master + ratio guide), PDF with crop marks (not built), transparent PNG for layered/digital use (not built), 1-page print & ratio guide PDF (not built). Decide before the Listing Agent first publishes: either (a) expand `resize-print-variants.ts` + add `package-deliverables.ts` to produce the full claimed set, OR (b) constrain the brief schema (Research Agent's `whats_included`) to only claim files the pipeline produces today. Tracking item — no code action yet, but flag before Listing Agent ships.
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
- [ ] **Competitive SEO Scoring engine — remaining work after v1.** v1 scorer + Research Agent integration shipped in the `tune research agent (pass 2)` commit (10 rules, deterministic, no LLM; per-keyword classification on every new brief). Two follow-ups remain — both gated on a Listing Agent existing:
  - [ ] Score every `monitor-listings.ts` snapshot and surface week-over-week drift (`COMPETITIVE_SEO_SCORING.md` §5).
  - [ ] Add `etsy_seo_gap` as a new signal type — only when Listing Agent ships and can act on the gap (`COMPETITIVE_SEO_SCORING.md` §6 step 6).
- [ ] **Listing Agent** — full spec in `brain/LISTING_AGENT_REQUIREMENTS.md`. Store-agnostic core + per-store adapters (Etsy first, Pinterest next, Shopify deferred). Replaces the old "Etsy listing automation" placeholder. Consumes the shared SEO scoring engine (now built) as a downstream consumer per `LISTING_AGENT_REQUIREMENTS.md` §3. Remaining prerequisites:
  - [ ] Migration `0007_assets.sql` — new `assets` table (kind/listing_id/product_brief_id/dimensions/source/cdn_url/fal_request_id). Listing Agent prerequisite per §6 of the spec.
  - [ ] `gen` + `upscale` tools UPSERT into `assets` in addition to `activity` (per §6).
  - [ ] `npm run link:asset` CLI for backfilling assets generated outside the system — bunny + planner pre-date the gen tool and need linking before the agent ships (per §6).
  - [ ] Asset pipeline gap (see Backlog) — decide expand-pipeline vs constrain-schema before first agent publish.
  - _Research Agent Tuning Pass 2 prerequisite is DONE (shipped in the `tune research agent (pass 2)` commit)._
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

## Done

### Research Agent Tuning Pass 2 + Competitive SEO Scoring v1 (the `tune research agent (pass 2)` commit)
- [x] **`ProductBrief` schema extended** (`brain/src/agents/research/types.ts`, `agent_version='research-v2'`): top-level `audience { persona, primary_search_intent, decision_factors }`; structured `listing.description { hook, why_this_one, whats_included, print_sizes?, how_it_works, faq[], closing, attribute_vocabulary }`; semantic `listing.attribute_intent { style/audience/occasion/color/materials descriptors }`; `listing.image_spec[≥4]`; `listing.shop_section_suggestion`; `listing.competitive_landscape`. Legacy `description_angles` kept for backward compat with v1 briefs.
- [x] **Competitive SEO Scoring engine v1** (`brain/src/lib/etsy-seo-scoring.ts`): pure deterministic function, no DB / no LLM / no network. 10 v1 rules — 8 always evaluated (title_length, title_keyword_placement, tag_count, tag_quality, description_length, description_keyword_in_preview, description_scannable_structure, shop_section_assigned), 2 conditional (attribute_fill_rate needs taxonomy data, ai_disclosure_compliance needs signature detection — both skipped in v1 callers). Returns `{ total, max, percent, weak_areas, detailed_breakdown, version }`. `EtsyListingDetails` extended with `shop_section_id`.
- [x] **Competitive landscape wiring** (`brain/src/agents/research/competitive.ts`): per-keyword scoring of top-10 incumbents (concurrency-limited Etsy fetches deduped across keywords), classification per spec (`open_field` if all <50% > `weak_incumbents` if 3+ <60% > `red_ocean` if 3+ ≥80% > `mixed`), gap_summary per keyword. Integrated into `src/agents/research/index.ts` as Step 6.6 between aggregates and synthesis. Brief-level `competitive_landscape` + per-keyword classifications recorded in `agent_runs.metadata`.
- [x] **Synthesis prompt** (`brain/src/agents/research/prompts.ts`): new COMPETITIVE SEO LANDSCAPE input section, TUNING PASS 2 quality blocks for all 6 new schema fields, expanded output schema. `brief.reasoning` now required to cite a specific competitive_landscape figure as evidence for `differentiation_angle`. Generic shop closing line standardized across all v2 briefs (no per-product hardcoding). All Tuning Pass 1 improvements preserved (NEW SHOP CONTEXT, PRICING STRATEGY, MVP SCOPING, positive-framing titles, risk mitigations rules).
- [x] **Renderer** (`brain/src/agents/research/render-markdown.ts`): operator markdown extended with Audience Persona, Listing Description (inline Etsy-plaintext preview in code block), Attribute Intent, Image Spec, Shop Section, and Competitive SEO Landscape sections. New sibling `renderBriefAsEtsyDescription` emits publish-ready plain text (ALL CAPS headers, dashes for bullets, "Q./A." FAQ formatting, fixed section order, gracefully skips optional `print_sizes`).
- [x] **Validation re-runs**: planneraddicts (`eed67089`) → v2 brief `535b3e36` (proceed @ 0.72); nursery wall art (`2af0ba72`) → v2 brief `a70b9002` (proceed @ 0.72). Both produced sensible weak-incumbent classifications (spot-checked: Jesus portrait at 59% on "nursery wall art printable", neon sign at 46% on "baby room wall art", Pokéball sign at 29% on "nursery decor" — all genuinely off-topic for their keywords). Brief markdowns saved at `brain/briefs/2026-05-21-eed67089.md` and `brain/briefs/2026-05-21-2af0ba72.md` as worked-example evidence. Total cost $0.70.
- [x] **`sanitizeForJsonb` extended to strip lone UTF-16 surrogates** (`brain/src/lib/etsy-search.ts`). First v2 synthesis insert failed Postgres with "Empty or invalid json" because `description_preview` slicing landed inside a surrogate pair on 3 search results where sellers used mathematical-bold unicode (𝑾𝒉𝒂𝒕 𝒊𝒔). Fix walks the string char-by-char dropping unpaired high/low surrogates. Also exported as `sanitizeJsonbDeep` for use on synthesized brief inserts in `src/agents/research/index.ts`.
- [x] **Diagnostic `brief-attempt-*.json` dump on `save_brief` failure** (`src/agents/research/index.ts`). Writes the exact sanitized brief + raw_research that Supabase rejected to gitignored `brain/dist/` so future jsonb failures can be diagnosed without a $0.30 Opus re-run.
- [x] **`FAL_KEY` added to Railway Variables.** Out of `.env.local`-only territory; deployed jobs can now safely import `src/lib/fal.ts` without module-load crashes.

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
