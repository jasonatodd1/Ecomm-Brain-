# AI Handoff — Brain Project

> Paste this entire document into a fresh Claude conversation to pick up where the previous one left off. Verify-flagged items (`[VERIFY]`) are values the AI could not confirm from code/Supabase alone and should be re-checked by the operator.

Last updated: 2026-05-20 (Wed). Reflects state after commit `21bbf8f` (`fix: add root node_modules/ to gitignore`).

---

## 1. SYSTEM OVERVIEW

**What this is:** An autonomous end-to-end e-commerce orchestrator called "the brain." It is responsible for everything a digital-product Etsy shop owner does — discover opportunities, research them, design the product, list it, run customer service, and iterate on results — with a human (Jason) acting as strategic overseer rather than operator.

**Shop:** HillwardStudio on Etsy. Digital products only (printable planners, wall art, SVG bundles, etc.). No physical inventory, no ads.

**Goal:** $1,000 / month profit, ad-free. Validation milestones, in order:
1. First sale
2. Break-even (~40–60 sales/mo at current price points)
3. Net profit at the $1k/mo target

**Current approach:** Research → Brief → Product → List → Validate. Each agent in this pipeline is built as a manual script first, validated for output quality, then scheduled. Closed-loop feedback (sales, reviews, customer messages) flows back upstream into scoring weights, prompts, and design heuristics — but the loops aren't connected yet because there are no live listings to feed them.

We are currently at the **Product → List** stage for the first two products. The Research Agent has been validated and produced briefs for both. Discovery and Scoring run autonomously. Design, Listing, Customer Service, and Optimization agents are all not yet built.

---

## 2. SHOP STATE

- **Shop name:** HillwardStudio
- **Shop URL:** `https://www.etsy.com/shop/HillwardStudio` [VERIFY — code does not pin the canonical URL]
- **Seller account:** opened
- **Live listings:** **0.** The `listings` table is empty. Nothing is published to Etsy yet.
- **Reviews:** 0 (new shop — explicit risk factor in every brief)
- **Monitoring status:** N/A — nothing to monitor until first listing goes live

**Products in flight (pre-listing):**

| Product | Folder | Brief | Status |
|---|---|---|---|
| A5 Monthly Planner (28pg, undated, MVP) | `brain/products/hillward-a5-monthly/` | `eed67089` decision → brief `0834bacd` (proceed, 0.72) | HTML template authored (v3 — SVG dot grid, editorial cover). Not yet rendered to final PDF for upload. |
| Nursery Bunny Print | `brain/products/hillward-nursery-bunny/` | `2af0ba72` decision → brief `ea836ab6` (proceed, 0.62) | `bunny 10.png` master image present. Five print-size variants (8x10, 11x14, 16x20, 18x24, 24x36) generated via `npm run resize:print`. `whats-included.html` listing graphic authored. Not yet listed. |

---

## 3. TECH STACK

### Data
- **Supabase** (Postgres + RLS). 11 tables in `public`:
  - `signals` (553 rows) — raw collector output
  - `opportunities` (11) — scored signals
  - `decisions_needed` (2) — surfaced for agent action; both `brief_ready`
  - `product_briefs` (5) — Research Agent output
  - `listings` (0) — Etsy listings created (empty)
  - `niche_memory` (22) — learnings keyed by `niche_tag` (`planneraddicts`: 17, `general`: 5)
  - `agent_config` (0) — tunable params per agent (no rows seeded yet; presence-only read in Research Agent)
  - `agent_runs` (7) — every agent execution with cost/status/timings
  - `activity` (244) — chronological event log
  - `cost_log` (1) — spend tracking (under-utilized; LLM costs currently logged as `cost.api_call` activity events, not aggregated to this table — see TODO)
  - `system_state` (3) — global caps/flags/mode
- **RLS:** enabled on 8 tables; **disabled** on `agent_config`, `agent_runs`, `product_briefs` (these are server-write-only, but Supabase advisor flags this — open security item if anon key ever gets exposed)

### Compute
- **Railway** — Node 20, `us-west2`, GitHub auto-deploy from `main`. Single service named `brain` [VERIFY service name]. Currently runs `npm run start` = `collect-trends`. Cron not yet configured.

### Source
- **GitHub** — repo `Ecomm-Brain-`. Main branch auto-deploys to Railway.

### Languages & runtime
- **Node.js 20+**, **TypeScript**, ESM (`"type": "module"`). Run via `tsx` (no build step).
- `typecheck` script: `tsc --noEmit`.

### Key libraries
- `@anthropic-ai/sdk` ^0.96.0
- `@supabase/supabase-js` ^2.45.4
- `dotenv` ^16.4.5
- `puppeteer` ^25.0.4 (PDF + PNG rendering)
- `sharp` ^0.34.5 (print-size variant generation)
- `tsx` ^4.19.1
- `typescript` ^5.6.2

### Models
- **Claude Opus 4.7** (`claude-opus-4-7`) — Research Agent keyword extraction + brief synthesis. ~$0.25 per research run.
- **Claude Haiku 4.5** — Reddit intent classification (`src/lib/classify-intent.ts`). ~$0.001 per classification.
- **Claude Sonnet 4.6** — reserved for future "routine work" per PRINCIPLES.md, not yet used in code.

### External APIs
- **SerpApi** — Google Trends collector. 9 working seed keywords (1 dead).
- **Reddit** OAuth — collector for 7 subreddits.
- **Etsy Open API v3** — public listing search + shop enrichment. Auth: `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` (Feb 9, 2026 format change). Etsy Developer App `HillwardStudio Internal` is approved.

### Environment variables (`.env.local` + Railway Variables)

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SERPAPI_KEY=
ANTHROPIC_API_KEY=
ETSY_API_KEYSTRING=
ETSY_SHARED_SECRET=
```

All six are required by at least one job; missing vars throw at module load with a clear error.

### MCPs connected in Cursor
- Supabase (read + execute SQL)
- Railway (needs `mcp_auth` re-trigger when stale)
- Vercel (for the future dashboard — no Vercel project yet)

---

## 4. CODEBASE MAP

Root: `brain/`. All paths below are relative to that.

### `src/agents/research/` — Research Agent V1
- **`index.ts`** — orchestrator. Claims a decision atomically, loads `niche_memory` for the niche, reads `agent_config` (presence-only in V1), calls Opus to extract 4–6 Etsy keywords, searches Etsy per keyword (concurrency-limited via `mapWithLimit`, dedupes by `listing_id`/`url`), computes market aggregates in code (`aggregates.ts`), calls Opus again to synthesize the brief, runs `reconcileNumericDrift` (LLM stats are unreliable → always overwrite with computed values, log drift), inserts to `product_briefs`, renders markdown, writes opportunity gaps back to `niche_memory` (creates new rows or bumps `evidence_count`), saves markdown to disk under `briefs/`, advances decision status `open → researching → brief_ready`, records `agent_runs` row with `succeeded`/`failed` + cost. Failure path releases the claim and marks the run failed.
- **`types.ts`** — the `ProductBrief` schema (downstream agents consume these fields literally — changing them is a contract break). `DecisionRecord`, `EtsySearchResult`, `NicheMemoryRow` interfaces.
- **`prompts.ts`** — two prompt builders. `buildKeywordExtractionPrompt` (asks for 4–6 keywords in 3 layers: exact / related / broader). `buildSynthesisPrompt` (tuning pass 1 applied: positive-title rule, volume-vs-premium pricing choice, MVP scoping default, RISK MITIGATIONS forbidding community-rule violations, NEW SHOP CONTEXT for HillwardStudio's 0-review deficit, cross-category field annotations).
- **`aggregates.ts`** — `computeAggregates`. Pure math over Etsy search results: `listings_analyzed`, `median_price`, `price_range` (p25/p50/p75 via linear-interp percentile), `median_favorers`, and top-5-seller enrichment via parallel `getShop()` fan-out (concurrency-limited).
- **`render-markdown.ts`** — turns a `ProductBrief` into a human-readable markdown document.

### `src/jobs/` — executable entrypoints
- **`collect-trends.ts`** — SerpApi Google Trends collector. 10 seed keywords (1 returns no data: `gratitude journal printable`). Writes `interest_score`, `velocity`, `rising_related_count` rows into `signals`. 1s politeness gap between keywords.
- **`collect-reddit.ts`** — Reddit OAuth collector. 7 subreddits, categorized as `buyer` / `seller` / `mixed`. Regex-prefilters buyer-intent posts. For `mixed`/`buyer` subs, sends candidate posts to Haiku 4.5 classifier (`classify-intent.ts`). Stores high-confidence buyer posts in `signals`. Surfaces strong signals as `decisions_needed` rows.
- **`score-opportunities.ts`** — scoring engine MVP. Pulls last 7 days of signals. Pass A scores Google Trends keywords (interest × velocity, capped); Pass B scores individual Reddit buyer posts (upvotes-weighted). Upserts to `opportunities`. Known limits: confidence ceiling saturates at 1.000 for top Google Trends keywords, `source_count` stuck at 1 (doesn't aggregate across runs), `niche` field never populated.
- **`research-decision.ts`** — CLI runner for the Research Agent. `--decision-id=<uuid>` arg; default falls back to the planneraddicts seed via `context->>post_url` lookup. Exits process explicitly after 500ms drain.
- **`seed-planneraddicts-decision.ts`** — one-shot seed for the first decision (r/planneraddicts "Looking for something I can't find" post — explicit A5 monthly buyer-intent).
- **`reclassify-reddit-signals.ts`** — backfill script that re-runs the Haiku classifier over existing Reddit signals to upgrade precision without re-collecting.

### `src/tools/`
- **`resize-print-variants.ts`** — `npm run resize:print <input.png> [output-dir]`. Reads a 5008×6680 master PNG and produces five print-size JPGs (`HillwardStudio-BunnyPrint-{8x10,11x14,16x20,18x24,24x36}.jpg`) via `sharp.extract` with per-size crop coordinates baked into a `VARIANTS` array. Validates input dimensions; fails loud if master is too small. JPEG quality 80.

No `generate-image.ts` yet — image generation (fal.ai / Recraft / Ideogram / Flux) is on the future roadmap.

### `src/render/`
- **`planner.ts`** — `npm run render:planner`. Headless Puppeteer renders `products/hillward-a5-monthly/template/index.html` to `dist/planner-v1.pdf` at A5 with `preferCSSPageSize`. Waits for `document.fonts.ready` so Google Fonts (`Inter`) embed correctly. Creates `dist/` if missing (gitignored).
- **`render-graphic.ts`** — `npm run render:graphic <input.html> <output.png>`. Generic PNG/JPEG screenshot tool for listing assets. Used for the bunny "What's Included" graphic at 2000×2000.

### `src/lib/`
- **`supabase.ts`** — `service_role` Supabase client. Loads `.env.local` at import time; throws on missing creds. `auth.persistSession: false`. Server-side only.
- **`etsy-search.ts`** — Etsy Open API v3 wrapper. `searchEtsy(keyword, { limit })` against `/v3/application/listings/active`. `getShop(shop_id)` against `/v3/application/shops/{shop_id}` for seller enrichment. Uses `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` (post Feb-2026 auth requirement). `sanitizeForJsonb` strips NUL bytes and other control chars from raw Etsy listing data before persisting (fixes Postgres jsonb rejection observed on wall-art listings).
- **`concurrency.ts`** — `mapWithLimit(items, limit, staggerMs, fn)`. Async pool with bounded concurrency and per-task stagger. Etsy uses `limit=2, staggerMs=200` (~5 req/sec sustained, well under Etsy's 10 req/sec ceiling). Preserves input order.
- **`log.ts`** — `log({ agent, action, description, severity?, metadata? })`. Writes to stdout (for Railway log tail) **and** the `activity` table. On insert failure, prints `[ACTIVITY_LOG_FAILED]` to stderr — never swallows the error. Agents enum: `intel | product | listing | customer_service | orchestrator | system`.
- **`classify-intent.ts`** — Haiku 4.5 classifier. Returns `{ intent: 'buyer' | 'seller' | 'other', confidence, reasoning }`. Lazy singleton client. Used by `collect-reddit.ts` for `mixed`/`buyer` subreddits.

### `products/`
- **`hillward-a5-monthly/template/index.html`** — full 28-page A5 monthly planner template (cover + 24 monthly spreads + 3 notes pages). v3 iteration: SVG-rendered dot grid, larger dot radius, Inter ExtraLight cover, editorial layout, priorities sidebar, system marks, weekend tint. Inline CSS, Google Fonts.
- **`hillward-nursery-bunny/master/bunny 10.png`** — the master illustration. 5008×6680 px [VERIFY], serves as input to `resize:print`.
- **`hillward-nursery-bunny/template/whats-included.html`** — 2000×2000 listing graphic ("What's Included" eyebrow + product summary). Rendered via `render:graphic`.
- `products/*/dist/` is gitignored — regenerable from templates.

### Other top-level files
- `brain/PRINCIPLES.md` — architecture canon
- `brain/TODO.md` — tactical work list
- `brain/README.md` — Day-1/Day-2 setup guide (older — predates Research Agent, Etsy v3, etc.)
- `brain/briefs/` — generated brief markdowns (currently tracked in git; backlog item to switch to a CLI render tool)
- `brain/supabase/migrations/` — `0001_init.sql`, `0002_rls.sql`, `0003_opportunities_unique_name.sql`, `0005_foundation_schemas.sql` (0004 absent)

---

## 5. PIPELINE STATE

| Agent | Status | Notes |
|---|---|---|
| Discovery — Google Trends collector | **Built + autonomous** | Last run 2026-05-20 21:31 UTC succeeded (9/10 keywords). |
| Discovery — Reddit collector | **Built + autonomous** | OAuth + intent classifier wired. |
| Scoring | **Built, MVP validated** | Known scoring-formula ceiling issues — see open data-quality bugs in §7. |
| Research Agent V1 | **Built + validated** | 5 briefs produced across 2 niches (planneraddicts, general/nursery wall art). Closed-loop with `niche_memory` verified: 4 opportunity gaps from brief v1 were re-confirmed in v2 (`evidence_count=2`). Synthesis prompt has been through tuning pass 1. |
| Design Agent | **Not built** | Current products are designed manually in HTML/CSS by Claude in-chat, with operator review. Future: Recraft/Ideogram/Flux orchestration. |
| Listing Agent | **Not built** | Etsy publish is currently fully manual. Brief → listing copy/photos/tags will be the next pipeline stage once a product is published manually and feedback patterns are observed. |
| Customer Service | **Not built** | Blocked on first sale. |
| Optimization | **Not built** | Blocked on having performance data. |
| Orchestrator (cron) | **Not built** | Currently every job is git-push-driven (Railway redeploys on commit and runs `npm start`). Cron scheduling is on the backlog until the scoring engine is fully trusted. |

**What's validated end-to-end:** Signal collection → scoring → opportunity surfacing → research brief. Outputs are reproducible, audited (`agent_runs`), and cost-tracked.

**What's next:** ship the first product (A5 planner or nursery print — order TBD), publish it manually, observe Etsy-side feedback signals, then design the Listing Agent against real data.

---

## 6. KEY DECISIONS (top 10, why)

1. **Closed-loop architecture over pipeline architecture.** Every agent reads `niche_memory` before acting and writes learnings back. Avoids re-discovering the same insights every run. See PRINCIPLES principle #1.
2. **Best tool for the job, not the cheapest.** Opus 4.7 for synthesis (~$0.20/run × 5 runs so far ≈ $1) is far cheaper than the cost of a bad brief that leads to a bad product. Haiku 4.5 only for routine classification. See PRINCIPLES principle #6.
3. **All Etsy market stats computed in code, not by the LLM.** `aggregates.ts` computes medians and percentiles deterministically. The LLM's `market_summary` numbers are reconciled (drift logged, computed values always win). LLMs are unreliable at arithmetic over JSON arrays.
4. **Code-based PDF rendering via Puppeteer + HTML/CSS.** No paid design tools or PDF libraries. HTML is the design language Claude knows best; CSS `@page` + `preferCSSPageSize` handles A5/Letter trivially. Reuses the same renderer for listing graphics (PNG screenshots).
5. **Volume pricing ($3.49 planner, $4.49 nursery print) over premium pricing.** Direct trade-off vs the 0-review reputation deficit. We can't win on social proof, so we win on price-per-value at a sustainable margin. Each brief explicitly cites comparable competitors before locking pricing.
6. **MVP scoping default for first-in-niche products.** A5 planner shipped as 28 pages, A5 only, undated — not 80 pages with 4 sizes and dated 2026/2027. Reduces design surface, exposes real demand signal faster. Expansion (sizes, dated, bundles) is a v2 candidate listed in the brief.
7. **Single-shop, single-marketplace first.** HillwardStudio on Etsy only. Shopify, Pinterest, TikTok all deferred until Etsy is throwing off enough revenue to justify them.
8. **Etsy Open API v3 (free) over scraping or SerpApi Etsy engine.** Initially built a SerpApi-Etsy wrapper assuming the engine existed — it doesn't. Then built an Etsy v3 client with `x-api-key: keystring`; broke when Etsy changed to `keystring:shared_secret` in Feb 2026. Both were resolved, and PRINCIPLES principle #9 was added: verify external dependencies before integrating.
9. **Decision claiming + agent_runs audit trail are mandatory, not optional.** Every Research Agent run atomically claims its decision (UPDATE … WHERE status='open' RETURNING), records start/end/cost/error, and releases on success or failure. No black boxes, no orphaned claims. See PRINCIPLES principle #5.
10. **Manual-first, then automate.** Every new agent ships as a manual CLI script (`npm run research`), gets a few real runs reviewed by the operator, then is considered for cron scheduling. Cron is a reward for trust, not a default. See PRINCIPLES principle #7.

---

## 7. PENDING WORK (verbatim from `brain/TODO.md`)

### Current Focus

#### HillwardStudio A5 Monthly Planner v1 — manual fulfillment via code pipeline
- [x] Code-based PDF rendering pipeline (Puppeteer + HTML/CSS)
- [ ] Real 28-page template authored by Claude
- [ ] Iteration to production-ready quality
- [ ] Listing photos via fal.ai
- [ ] Etsy shop setup (in parallel)
- [ ] Listing creation and publish

### Data-Quality Bugs (open)
- [ ] `opportunities.niche` field is null on every row — likely scoring engine omission
- [ ] `opportunities.source_count` stuck at 1 across all rows — scoring engine doesn't aggregate signals across collection runs (re-confirmation should bump this)
- [ ] Reddit `post_url` missing from `signals.metadata` — only lives on the opportunity row, breaks signal→opportunity traceability for Reddit signals

### Backlog (committed, deferred)
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

### Future (after first sale validation)
- [ ] Product creation agent (design generation via Recraft/Ideogram/Flux, PDF assembly)
- [ ] Etsy listing automation (auto-publish, image upload, description, pricing)
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

---

## 8. PRINCIPLES

Canonical doc: `brain/PRINCIPLES.md`. Summary of the 10 core architectural principles:

1. **Closed-loop, not pipeline.** Information flows back upstream from sales/reviews/messages.
2. **Human as overseer, not operator.** Autonomy within defined limits; escalate on new categories, prices >$75, refunds, ad spend, low-confidence calls, pattern shifts.
3. **Agents are tunable without code changes.** Prompts, thresholds, weights live in `agent_config`.
4. **Shared memory is first-class.** `niche_memory` read before, written after.
5. **All work is auditable.** Every run → `agent_runs` with cost, confidence, model, time, outcome.
6. **Best tool for the job. Not the cheapest.** Opus for judgment, Haiku for classification, paid APIs over fragile scraping.
7. **Build, validate, automate.** Manual script → quality-validate → cron → feedback loop.
8. **No silent failures.** `[ACTIVITY_LOG_FAILED]` escalation; cost_log captures spend; loud errors, traceable, recoverable.
9. **Verify external dependencies before integrating.** Most wasted iteration in this project came from API assumptions (SerpApi-Etsy engine didn't exist; Etsy auth format changed). Probe before wrapping.
10. **Living docs must actually live.** TODO.md + PRINCIPLES.md are canonical only if kept current. Doc updates land in the same commit as the work.

---

## 9. KNOWN ISSUES

### Fixed (recently)
- **Railway `node_modules` warning** — root `node_modules/` was being included in Railway build context. Fixed in commit `21bbf8f` ("add root node_modules/ to gitignore"). Now `node_modules/` and `brain/node_modules/` are both ignored at the repo root.
- **Postgres jsonb rejection on wall-art listings** — Etsy returned raw NUL bytes / control chars in some `description` fields, causing `signals.metadata` inserts to fail with `Empty or invalid json`. Fixed via `sanitizeForJsonb` in `brain/src/lib/etsy-search.ts` (commit `1859387`).
- **Etsy v3 auth format** — `x-api-key` had to switch from `keystring` to `keystring:shared_secret` per Etsy's Feb 9, 2026 change. Fixed in commit `465690d`.

### Open
- **RLS disabled on 3 tables** — `agent_config`, `agent_runs`, `product_briefs`. Server-write-only by current design, but flagged by Supabase advisor. Not a live exposure unless the anon key ever leaks. Decision deferred until dashboard work begins.
- **All data-quality bugs** listed in §7.
- **Scoring formula ceiling saturation** at confidence 1.000 — lost discrimination at the top of the funnel.
- **`agent_config` table is empty.** Research Agent reads it for presence-only; no tunable params are actually externalized yet. First real config row should appear when prompts move out of source.

---

## 10. NEXT SESSION PRIORITIES

Based on the current state (two proceed-recommended briefs, zero live listings, design + listing agents not built), the top three things to do when conversation resumes:

1. **Publish the first listing.** Pick one product (recommendation: A5 monthly planner, since the template is further along and the brief confidence is higher at 0.72). Render the PDF (`npm run render:planner`), generate listing photos manually (or via fal.ai if quick), and publish to Etsy by hand. Insert the resulting Etsy listing into the `listings` table so downstream agents have something to read.
2. **Author the second product's listing inputs in parallel.** Bunny print already has master image, 5 print-size variants, and a "What's Included" graphic. Needs: listing title (use `brief.listing.title_template`), description (use `description_angles`), tags (use `etsy_tags`), main hero photo, and pricing per `brief.pricing.recommended` ($4.49).
3. **Decide whether to start scaffolding the Listing Agent now or wait for first-sale signal.** Per principle #7 ("build, validate, automate"), the manual listing should run end-to-end at least once before automating. Recommendation: ship both products manually, observe Etsy's behavior (search rank, favorites, conversion), then design the Listing Agent against that ground truth.

Secondary, if time allows: knock out the three data-quality bugs in §7 — they're blocking trustworthy scoring re-runs.

---

## 11. HOW TO START A NEW CONVERSATION

Paste **this entire document** into a fresh Claude conversation (Cursor, claude.ai, or API), then say:

> I'm continuing work on the brain project (autonomous Etsy orchestrator under HillwardStudio). The handoff document above describes the current state — please confirm you've read it, then tell me what you think the right next move is and why. The repo is at `/Users/jasontodd/Desktop/coding projects/Ecomm Bot/Ecomm-Brain-/brain`. Don't make any changes yet — start by reading `PRINCIPLES.md` and the latest few entries in `TODO.md` to make sure nothing has drifted, then propose the next concrete step.

For shorter pickups (small bug fix, isolated change), you can skip the full handoff and just paste the relevant section (§4 codebase map + the specific files involved).

If the conversation is going to do anything that touches Supabase or Railway: confirm the operator has run the Supabase MCP at least once in the session (it works via service role and shouldn't need re-auth), and re-trigger `mcp_auth` for Railway if it's stale.
