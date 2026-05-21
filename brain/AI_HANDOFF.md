# AI Handoff — Brain Project

> Paste this entire document into a fresh Claude conversation to pick up where the previous one left off. Verify-flagged items (`[VERIFY]`) are values the AI could not confirm from code/Supabase alone and should be re-checked by the operator.

Last updated: 2026-05-21 (Thu, fifth refresh — late afternoon). Reflects state after Research Agent Tuning Pass 2 shipped: structured `listing.description` + `competitive_landscape` + the shared SEO scoring engine v1 (`brain/src/lib/etsy-seo-scoring.ts`) are all in production (the `tune research agent (pass 2)` commit). Every new brief now carries per-keyword competitive classifications and produces a publish-ready Etsy plaintext body via the new sibling renderer. Listing Agent prerequisites narrowed from four to two (asset registry + data-quality bugs).

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
- **Live listings:** **2.** Both went live shortly before this conversation; backfilled into Supabase via `npm run seed:listings` + first snapshot via `npm run monitor:listings`.
- **Reviews:** 0 (new shop — explicit risk factor in every brief; still applies)
- **Monitoring status:** built and manually validated. Daily snapshots via `monitor-listings.ts` are operator-triggered for now — cron deferred per principle #7 until 3–5 days of manual runs confirm baseline behavior.

**Live listings:**

| Product | Etsy ID | Price | Opportunity | Brief | First snapshot |
|---|---|---|---|---|---|
| A5 Monthly Calendar Printable with Notes Pages \| Minimalist Undated Planner Inserts… | `4508059444` | $3.49 | `c3fa0a4d…` (planneraddicts Reddit buyer) | `0834bacd` (proceed, 0.72) | 6 views / 0 favorers / 13 tags / `active` @ 2026-05-21 20:41 UTC |
| Vintage Bunny Nursery Wall Art Printable \| Watercolor Rabbit Sketch \| Gender Neutral Baby Room Decor… | `4508704536` | $4.49 | `d7750211…` (nursery wall art printable) | `ea836ab6` (proceed, 0.62) | 4 views / 0 favorers / 12 tags / `active` @ 2026-05-21 20:41 UTC |

URLs: [`hillwardstudio.etsy.com/listing/4508059444`](https://hillwardstudio.etsy.com/listing/4508059444) and [`etsy.com/listing/4508704536`](https://www.etsy.com/listing/4508704536).

---

## 3. TECH STACK

### Data
- **Supabase** (Postgres + RLS). 12 tables in `public` (added `listings_stats` via migration 0006):
  - `signals` (619+ rows) — raw collector output
  - `opportunities` (11) — scored signals
  - `decisions_needed` (2) — surfaced for agent action; both `brief_ready`
  - `product_briefs` (5) — Research Agent output
  - `listings` (2) — live Etsy listings (mirror columns extended in migration 0006: `views`, `num_favorers`, `etsy_state`, `tags`, `etsy_last_modified_at`, `last_snapshot_at`)
  - `listings_stats` (2) — **new in migration 0006.** Append-only time series of every snapshot. Includes `raw` jsonb with the full Etsy response for future-proofing. Indexed on `(listing_id, snapshot_at DESC)` and `(snapshot_at DESC)`.
  - `niche_memory` (22) — learnings keyed by `niche_tag` (`planneraddicts`: 17, `general`: 5)
  - `agent_config` (0) — tunable params per agent (no rows seeded yet; presence-only read in Research Agent)
  - `agent_runs` (7) — every agent execution with cost/status/timings
  - `activity` (260+) — chronological event log; now includes `image.generated` / `image.upscaled` from fal tools and `listing.snapshotted` / `listings.monitor_complete` from the monitor
  - `cost_log` (1) — spend tracking (under-utilized; LLM and image costs currently logged as `cost.api_call` / image-tool activity events, not aggregated to this table — see TODO)
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
- `@fal-ai/client` ^2.x (image generation + upscaling — added 2026-05-21)
- `dotenv` ^16.4.5
- `puppeteer` ^25.0.4 (PDF + PNG/JPEG rendering)
- `sharp` ^0.34.5 (print-size variant generation + dimension verification/correction in the fal pipeline)
- `tsx` ^4.19.1
- `typescript` ^5.6.2

### Models
- **Claude Opus 4.7** (`claude-opus-4-7`) — Research Agent keyword extraction + brief synthesis. ~$0.25 per research run.
- **Claude Haiku 4.5** — Reddit intent classification (`src/lib/classify-intent.ts`). ~$0.001 per classification.
- **Claude Sonnet 4.6** — reserved for future "routine work" per PRINCIPLES.md, not yet used in code.
- **FLUX.2 Pro** (`fal-ai/flux-2-pro`, `fal-ai/flux-2-pro/edit`) — text-to-image and image-to-image (multi-reference, up to 9 refs). ~$0.075 for a 1728×2304 image (4MP). Used by `src/tools/generate-image.ts`.
- **Clarity Upscaler** (`fal-ai/clarity-upscaler`) — diffusion-based upscaler with faithful-upscale tuning baked in (`creativity=0.1`, `resemblance=1.0`). ~$0.10 per upscale (compute-time billed, placeholder estimate). Used by `src/tools/upscale-image.ts`. Fallback for pixel-faithful: `fal-ai/aura-sr` (deterministic GAN, fixed 4x).

### External APIs
- **SerpApi** — Google Trends collector. 9 working seed keywords (1 dead).
- **Reddit** OAuth — collector for 7 subreddits.
- **Etsy Open API v3** — public listing search + shop enrichment. Auth: `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` (Feb 9, 2026 format change). Etsy Developer App `HillwardStudio Internal` is approved.
- **fal.ai** — hosted FLUX.2 Pro + Clarity Upscaler. Auth via `FAL_KEY` env var. Per-call cost; no monthly fee.

### Environment variables (`.env.local` + Railway Variables)

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SERPAPI_KEY=
ANTHROPIC_API_KEY=
ETSY_API_KEYSTRING=
ETSY_SHARED_SECRET=
FAL_KEY=
```

All seven are required by at least one job; missing vars throw at module load with a clear error. **NB:** `FAL_KEY` not yet added to Railway Variables (verify before any deployed job tries to import `src/lib/fal.ts`).

### MCPs connected in Cursor
- Supabase (read + execute SQL)
- Railway (needs `mcp_auth` re-trigger when stale)
- Vercel (for the future dashboard — no Vercel project yet)

---

## 4. CODEBASE MAP

Root: `brain/`. All paths below are relative to that.

### `src/agents/research/` — Research Agent (v2, Tuning Pass 2 shipped)
- **`index.ts`** — orchestrator. Claims a decision atomically, loads `niche_memory` for the niche, reads `agent_config` (presence-only in V1), calls Opus to extract 4–6 Etsy keywords, searches Etsy per keyword (concurrency-limited via `mapWithLimit`, dedupes by `listing_id`/`url`, keeps per-keyword maps alongside the deduped flat list). Step 6.5 computes market aggregates in code (`aggregates.ts`); Step 6.6 computes the competitive SEO landscape (`competitive.ts`). Calls Opus again to synthesize the brief (now `max_tokens: 12000` to accommodate the v2 schema), runs `reconcileNumericDrift` (LLM stats are unreliable → always overwrite with computed values, log drift), sanitizes brief + raw_research via `sanitizeJsonbDeep`, dumps both to gitignored `brain/dist/brief-attempt-*.json` for diagnostic insurance, inserts to `product_briefs` (now `agent_version='research-v2'`), renders markdown, writes opportunity gaps back to `niche_memory`, saves markdown to disk under `briefs/`, advances decision status `open → researching → brief_ready`, records `agent_runs` row with `succeeded`/`failed` + cost + per-keyword competitive classifications in metadata. Failure path releases the claim and marks the run failed.
- **`types.ts`** — the `ProductBrief` schema (downstream agents consume these fields literally — changing them is a contract break). v2 adds: top-level `audience { persona, primary_search_intent, decision_factors }`; structured `listing.description { hook, why_this_one, whats_included, print_sizes?, how_it_works, faq[], closing, attribute_vocabulary }`; semantic `listing.attribute_intent { style/audience/occasion/color/materials descriptors }`; `listing.image_spec[≥4]`; `listing.shop_section_suggestion`; `listing.competitive_landscape`. Legacy `description_angles` kept as optional summary. `DecisionRecord`, `EtsySearchResult`, `NicheMemoryRow` interfaces unchanged.
- **`prompts.ts`** — two prompt builders. `buildKeywordExtractionPrompt` (asks for 4–6 keywords in 3 layers: exact / related / broader). `buildSynthesisPrompt` (v2 — preserves all 6 Tuning Pass 1 improvements AND adds: a COMPETITIVE SEO LANDSCAPE input section that lists per-keyword classifications + top-3 incumbent scores + weak areas, TUNING PASS 2 quality blocks for each new field — including the 130-160 char hook with primary keyword inside, 5-7 FAQ entries with first 2-3 derived from `brief.risks`, semantic-only `attribute_intent`, verbatim `whats_included` from product.format.includes, and a generic shop-wide closing line. `brief.reasoning` now required to cite a specific competitive_landscape figure as evidence for `differentiation_angle`).
- **`aggregates.ts`** — `computeAggregates`. Pure math over Etsy search results: `listings_analyzed`, `median_price`, `price_range` (p25/p50/p75 via linear-interp percentile), `median_favorers`, and top-5-seller enrichment via parallel `getShop()` fan-out (concurrency-limited).
- **`competitive.ts`** — supply-side gap discovery (Tuning Pass 2). `computeCompetitiveLandscape({ keywords, resultsByKeyword, topN=10 })` takes the per-keyword search results already fetched in the agent flow, picks top-N by `num_favorers` per keyword, dedupes their listing_ids across keywords, fetches full `EtsyListingDetails` for each via `getListing()` (concurrency-limited 2 in-flight / 200ms stagger to match existing Etsy posture), scores each via `scoreEtsyListingSeo(details, { primary_keyword: k })`, classifies per spec (`open_field` if all <50% > `weak_incumbents` if 3+ <60% > `red_ocean` if 3+ ≥80% > `mixed`), and emits one `CompetitiveLandscapeEntry` per keyword carrying top-3 incumbents + scores + weak_areas + a synthesis-ready `gap_summary`. Owns classification thresholds and median/weak-area aggregation; does NOT own scoring rules — those live in `src/lib/etsy-seo-scoring.ts`.
- **`render-markdown.ts`** — two renderers. `renderBriefAsMarkdown` produces the operator markdown (now includes Audience Persona, Listing Description as inline Etsy-plaintext preview inside a code block, Attribute Intent, Image Spec, Shop Section, and Competitive SEO Landscape sections with per-keyword classifications + top-3 incumbent scores + weak areas). New sibling `renderBriefAsEtsyDescription` emits publish-ready plain text from `listing.description` (ALL CAPS section headers, dashes for bullets, numbered steps, "Q. /A. " FAQ formatting, fixed section order, gracefully skips optional `print_sizes`) — used by the markdown preview today and by the future Listing Agent for direct Etsy publish.

### `src/jobs/` — executable entrypoints
- **`collect-trends.ts`** — SerpApi Google Trends collector. 10 seed keywords (1 returns no data: `gratitude journal printable`). Writes `interest_score`, `velocity`, `rising_related_count` rows into `signals`. 1s politeness gap between keywords.
- **`collect-reddit.ts`** — Reddit OAuth collector. 7 subreddits, categorized as `buyer` / `seller` / `mixed`. Regex-prefilters buyer-intent posts. For `mixed`/`buyer` subs, sends candidate posts to Haiku 4.5 classifier (`classify-intent.ts`). Stores high-confidence buyer posts in `signals`. Surfaces strong signals as `decisions_needed` rows.
- **`score-opportunities.ts`** — scoring engine MVP. Pulls last 7 days of signals. Pass A scores Google Trends keywords (interest × velocity, capped); Pass B scores individual Reddit buyer posts (upvotes-weighted). Upserts to `opportunities`. Known limits: confidence ceiling saturates at 1.000 for top Google Trends keywords, `source_count` stuck at 1 (doesn't aggregate across runs), `niche` field never populated.
- **`research-decision.ts`** — CLI runner for the Research Agent. `--decision-id=<uuid>` arg; default falls back to the planneraddicts seed via `context->>post_url` lookup. Exits process explicitly after 500ms drain.
- **`seed-planneraddicts-decision.ts`** — one-shot seed for the first decision (r/planneraddicts "Looking for something I can't find" post — explicit A5 monthly buyer-intent).
- **`seed-listings.ts`** — `npm run seed:listings`. Idempotent SELECT-then-INSERT by `etsy_listing_id`. Currently seeds the two HillwardStudio listings (`4508059444` A5 planner, `4508704536` bunny print). All other fields left null — `monitor-listings.ts` populates them from Etsy on first run.
- **`monitor-listings.ts`** — `npm run monitor:listings`. Reads all rows from `listings` with non-null `etsy_listing_id`, fetches each via `getListing()` with `mapWithLimit(2, 200ms)` concurrency. Per listing: INSERT into `listings_stats` first (time series is source of truth), then UPDATE `listings` mirror columns. Logs `agent='listing'`, `action='listing.snapshotted'` per success and a run-level `listings.monitor_complete`. Separate warning row (`listing.mirror_update_failed`) if the mirror UPDATE fails after the time-series row already landed — prevents silent divergence. Exits non-zero if any listing failed. Designed for daily cron (deferred until manually validated).
- **`reclassify-reddit-signals.ts`** — backfill script that re-runs the Haiku classifier over existing Reddit signals to upgrade precision without re-collecting.

### `src/tools/`
- **`resize-print-variants.ts`** — `npm run resize:print <input.png> [output-dir]`. Reads a 5008×6680 master PNG and produces five print-size JPGs (`HillwardStudio-BunnyPrint-{8x10,11x14,16x20,18x24,24x36}.jpg`) via `sharp.extract` with per-size crop coordinates baked into a `VARIANTS` array. Validates input dimensions; fails loud if master is too small. JPEG quality 80.
- **`generate-image.ts`** — `npm run gen -- --prompt="..." [options]`. Dual-mode: CLI for human iteration, or `import { generateImage }` for future agents. Routes to FLUX.2 Pro text-to-image by default, or `flux-pro-edit` (image-to-image, multi-reference, up to 9 refs) when `--ref` is passed. Explicit `--size=WxH` is pinned via sharp post-correction (throws if drift > 1.5×). Auto-named outputs land under `dist/gen/<ts>-<slug>-NN.png`; `--count=N` runs N parallel variants with `seed, seed+1, …`. Every successful run writes an `activity` row with `agent='product'`, `action='image.generated'`, and rich jsonb metadata (model, prompt, fal request ID, dims, seeds, costs, optional `product_brief_id` linkage). Verbose fal `ValidationError` body is surfaced (no more silent `"Unprocessable Entity"`).
- **`upscale-image.ts`** — `npm run upscale -- --input=<path|url> [options]`. Same dual-mode pattern: CLI or `import { upscaleImage }`. Defaults to Clarity Upscaler with faithful-upscale tuning (`creativity=0.1`, `resemblance=1.0`, conservative against Clarity's defaults of 0.35/0.6). Accepts `--scale=N` or `--size=WxH` (size requires local input so dims can be read; computes scale + sharp-corrects to exact target). Smoke-tested 2026-05-21: 1728×2304 bunny → 5008×6680 in 70s, $0.10. Activity row written under `action='image.upscaled'` with input/output dims, factor, fal request ID, params, cost.

### `src/lib/` (continued — fal infra)
- **`fal.ts`** — shared fal.ai infrastructure consumed by both tools above AND by future agents. Exports: configured `fal` client (auths via `FAL_KEY`), `MODEL_ALIASES` map (`flux-pro` → `fal-ai/flux-2-pro`, `flux-pro-edit` → `…/edit`, `clarity` → `fal-ai/clarity-upscaler`) with `resolveModelId(aliasOrId)` passthrough, `estimateFluxProCost(w,h)` / `estimateClarityUpscaleCost()` for budgeting, `resolveReferenceImage(ref)` (uploads local paths to fal CDN, passes URLs through), `downloadImage(url, path)`, `verifyAndCorrectDimensions(path, w, h, {upscaleThreshold=1.5})` (Layer 2/3 dimension guarantee: silent sharp correction for small mismatches, throw for >1.5× drift), `buildAutoOutputPath(prompt, index, ext)` / `buildUpscaleOutputPath(inputPath, scale, ext)` / `indexOutputPath(base, index, total)` for naming, `formatFalValidationError(err)` (extracts `err.body.detail[]` into one human-readable line per offending field). Throws at module load if `FAL_KEY` is missing.

### `src/render/`
- **`planner.ts`** — `npm run render:planner`. Headless Puppeteer renders `products/hillward-a5-monthly/template/index.html` to `dist/planner-v1.pdf` at A5 with `preferCSSPageSize`. Waits for `document.fonts.ready` so Google Fonts (`Inter`) embed correctly. Creates `dist/` if missing (gitignored).
- **`render-graphic.ts`** — `npm run render:graphic <input.html> <output.{png,jpg}>`. Generic screenshot tool for listing assets. Output format is inferred from the file extension: `.jpg`/`.jpeg` → JPEG quality 92, anything else → PNG. Used for the bunny "What's Included" graphic at 2000×2000.

### `src/lib/`
- **`supabase.ts`** — `service_role` Supabase client. Loads `.env.local` at import time; throws on missing creds. `auth.persistSession: false`. Server-side only.
- **`etsy-search.ts`** — Etsy Open API v3 wrapper. Three public functions: `searchEtsy(keyword, { limit })` against `/v3/application/listings/active` (Research Agent); `getShop(shop_id)` against `/v3/application/shops/{shop_id}` for seller enrichment (Research Agent); `getListing(listing_id)` against `/v3/application/listings/{listing_id}` for daily snapshots AND competitive SEO scoring (Listings Monitor + Tuning Pass 2 `competitive.ts` — returns normalized `EtsyListingDetails` including `title`, `description`, `tags[]`, `shop_section_id`, `state`, `views`, `num_favorers`, `price_cents`, `last_modified_timestamp` plus sanitized full `raw` jsonb for `listings_stats.raw` and for any future fields the SEO scorer wants to evaluate without re-fetching). All three use `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` (post Feb-2026 auth requirement). Helpers: `sanitizeForJsonb` (single string — now also strips lone UTF-16 surrogates that arise when seller text containing mathematical-bold unicode is sliced mid-pair, OR when LLM output emits malformed surrogate sequences); `sanitizeDeep` (recursive object/array walk); `sanitizeJsonbDeep` (exported alias for use on synthesized brief inserts in the Research Agent); `priceToCents` (normalizes Etsy's `{amount, divisor}` to integer cents).
- **`etsy-seo-scoring.ts`** — shared SEO scoring engine v1 (Tuning Pass 2). `scoreEtsyListingSeo(listing: EtsyListingDetails, context: { primary_keyword?, niche_tag?, applicable_attribute_count?, filled_attribute_count?, ai_signature_detected?, ai_disclosure_flag? }) → SeoScore`. Pure deterministic function: no DB, no network, no LLM. Same input → same output, callable in bulk (10 results × N keywords per brief). 10 v1 rules — 8 always evaluated (`title_length`, `title_keyword_placement`, `tag_count`, `tag_quality`, `description_length`, `description_keyword_in_preview`, `description_scannable_structure`, `shop_section_assigned`), 2 conditional (`attribute_fill_rate` needs taxonomy `applicable_attribute_count` — future Listing Agent will populate this; `ai_disclosure_compliance` needs `ai_signature_detected` — future signature-detection infra will populate). Returns `{ total, max, percent, weak_areas (sorted desc by max−score), detailed_breakdown[ruleKey] = { score, max, note }, version }`. Exported `SCORER_VERSION = 'v1'`. Consumed today by `competitive.ts`; will also be consumed by the future Listing Agent as a pre-publish quality gate + post-publish drift monitor per `COMPETITIVE_SEO_SCORING.md` §5.
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
| Research Agent V2 | **Built + validated; competitive SEO lens shipped** | 7 briefs total across 2 niches (5 v1, 2 v2). Closed-loop with `niche_memory` verified: 4 opportunity gaps from brief v1 were re-confirmed in v2 (`evidence_count=2`). **Tuning Pass 2 shipped (the `tune research agent (pass 2)` commit):** structured `listing.description` (hook → why → includes → how → FAQ → closing) with a sibling Etsy-plaintext renderer for direct publish, semantic `attribute_intent` (never raw store values — Listing Agent maps to live `possible_values` per store), `image_spec[≥4]`, `shop_section_suggestion`, top-level `audience.persona`, and **competitive SEO lens** (`v1` scorer + per-keyword `open_field` / `weak_incumbents` / `mixed` / `red_ocean` classification on every new brief). `brief.reasoning` now required to cite specific competitive-landscape figures as evidence for `differentiation_angle`. Two follow-ups deferred until Listing Agent ships: scoring every `monitor-listings.ts` snapshot (drift detection), and an `etsy_seo_gap` signal type. |
| Design Agent | **Infra built, agent not yet built** | The image-generation primitives a Design Agent would call now exist and are validated end-to-end (FLUX.2 Pro text-to-image, FLUX.2 Pro edit for image-to-image, Clarity Upscaler for print-resolution enlargement). Both tools are dual-mode — usable as CLI today (`npm run gen`, `npm run upscale`) and importable as `generateImage(opts)` / `upscaleImage(opts)` from an agent tomorrow. Smoke-tested: a 1728×2304 watercolor bunny was generated via FLUX.2 Pro and upscaled to 5008×6680 (print-master size) via Clarity, with the activity log already storing all metadata downstream agents would need. HTML/CSS layouts (planner, listing graphics) are still designed manually in-chat. |
| Listing Agent | **Not built — spec'd; two of four prereqs cleared** | Full requirements in `brain/LISTING_AGENT_REQUIREMENTS.md` (10 sections + worked examples from manual publishes). Store-agnostic core + per-store adapters (Etsy → Pinterest → Shopify). Remaining prerequisites: (1) `assets` table + `link:asset` CLI to backfill bunny + planner assets generated outside the system (§6), (2) live store-schema fetch + caching so attribute values are verified against `possible_values` at runtime (§3, §4 — direct response to the lesson that Etsy attribute schemas vary by taxonomy). **Cleared in Tuning Pass 2 (the `tune research agent (pass 2)` commit):** Research Agent v2 schema (audience.persona, structured `listing.description`, semantic `attribute_intent`, `image_spec[]`, `shop_section_suggestion`, `competitive_landscape`) AND the shared `scoreEtsyListingSeo()` engine (`brain/src/lib/etsy-seo-scoring.ts`) — both upstream blockers removed. Per Backlog: also pending an asset-pipeline decision (expand `resize-print-variants.ts` to produce master JPG + transparent PNG + crop-marked PDF + ratio guide, OR constrain the brief schema so the agent only claims files the pipeline produces today). Etsy publish itself is currently fully manual. |
| Listings Monitoring | **Built + manual** | `seed-listings.ts` + `monitor-listings.ts` running locally on demand. Both live listings seeded, first snapshots captured (see §2 for current numbers). Cron deferred per principle #7 — 3–5 days of manual runs first to confirm baseline (state changes, sold_out, tag edits all behave predictably) before scheduling daily on Railway. The migration (0006) and `listings_stats` time series are ready to absorb cron'd snapshots whenever the operator promotes it. |
| Customer Service | **Not built** | Blocked on first sale. |
| Optimization | **Not built** | Blocked on having performance data — but `listings_stats` now starts accumulating that data immediately. After a week of snapshots, even a manual query can answer "views/day per listing" and "favoriting rate," which is the floor of optimization input. |
| Orchestrator (cron) | **Not built** | Currently every job is git-push-driven (Railway redeploys on commit and runs `npm start`). Cron scheduling is on the backlog. `monitor-listings.ts` is the most immediate cron candidate (daily); collectors follow once their scoring outputs are fully trusted. |

**What's validated end-to-end:** Signal collection → scoring → opportunity surfacing → research brief → image generation → image upscale-to-print → Etsy listing publish (manual) → daily snapshot into `listings_stats` with full signal-to-listing FK traceability via `opportunity_id`. Outputs are reproducible, audited (`agent_runs` + `activity`), and cost-tracked.

**What's next:** drive first sale. Run the monitor manually for a few days to baseline. Once a week of data exists, decide whether the lever is more traffic (Pinterest pin sets, Etsy SEO iteration) or conversion (listing photos, copy, pricing). The Listing Agent gets designed against that ground truth, not before.

---

## 6. KEY DECISIONS (top 10, why)

1. **Closed-loop architecture over pipeline architecture.** Every agent reads `niche_memory` before acting and writes learnings back. Avoids re-discovering the same insights every run. See PRINCIPLES principle #1.
2. **Best tool for the job, not the cheapest.** Opus 4.7 for synthesis (~$0.20/run × 5 runs so far ≈ $1) is far cheaper than the cost of a bad brief that leads to a bad product. Haiku 4.5 only for routine classification. See PRINCIPLES principle #6.
3. **All Etsy market stats computed in code, not by the LLM.** `aggregates.ts` computes medians and percentiles deterministically. The LLM's `market_summary` numbers are reconciled (drift logged, computed values always win). LLMs are unreliable at arithmetic over JSON arrays.
4. **Code-based PDF + listing-graphic rendering via Puppeteer + HTML/CSS; AI image generation via fal.ai (FLUX.2 Pro + Clarity).** Two complementary asset pipelines: structured/typographic work (planners, listing graphics) stays in Puppeteer-rendered HTML/CSS because HTML is the design language Claude is strongest in. Illustrative/photographic work (nursery prints, lifestyle mockups) goes through fal.ai because diffusion models are categorically better at it than CSS. Both pipelines write into `dist/gen/` (gitignored) and log to `activity` so downstream agents can locate generated assets uniformly. fal-side defaults are tuned for *faithful* output (Clarity `creativity=0.1`, `resemblance=1.0`) — the system can override when it wants creative reinterpretation; the floor is conservative.
5. **Volume pricing ($3.49 planner, $4.49 nursery print) over premium pricing.** Direct trade-off vs the 0-review reputation deficit. We can't win on social proof, so we win on price-per-value at a sustainable margin. Each brief explicitly cites comparable competitors before locking pricing.
6. **MVP scoping default for first-in-niche products.** A5 planner shipped as 28 pages, A5 only, undated — not 80 pages with 4 sizes and dated 2026/2027. Reduces design surface, exposes real demand signal faster. Expansion (sizes, dated, bundles) is a v2 candidate listed in the brief.
7. **Single-shop, single-marketplace first.** HillwardStudio on Etsy only. Shopify, Pinterest, TikTok all deferred until Etsy is throwing off enough revenue to justify them.
8. **Etsy Open API v3 (free) over scraping or SerpApi Etsy engine.** Initially built a SerpApi-Etsy wrapper assuming the engine existed — it doesn't. Then built an Etsy v3 client with `x-api-key: keystring`; broke when Etsy changed to `keystring:shared_secret` in Feb 2026. Both were resolved, and PRINCIPLES principle #9 was added: verify external dependencies before integrating.
9. **Decision claiming + agent_runs audit trail are mandatory, not optional.** Every Research Agent run atomically claims its decision (UPDATE … WHERE status='open' RETURNING), records start/end/cost/error, and releases on success or failure. No black boxes, no orphaned claims. See PRINCIPLES principle #5.
10. **Manual-first, then automate.** Every new agent ships as a manual CLI script (`npm run research`), gets a few real runs reviewed by the operator, then is considered for cron scheduling. Cron is a reward for trust, not a default. See PRINCIPLES principle #7.

---

## 7. PENDING WORK (verbatim from `brain/TODO.md`)

### Current Focus

#### Fix the 3 data-quality bugs (closes the discovery-pipeline loop before Listing Agent build)
- [ ] `opportunities.niche` field is null on every row — likely scoring engine omission
- [ ] `opportunities.source_count` stuck at 1 across all rows — scoring engine doesn't aggregate signals across collection runs (re-confirmation should bump this)
- [ ] Reddit `post_url` missing from `signals.metadata` — only lives on the opportunity row, breaks signal→opportunity traceability for Reddit signals

#### Drive first sale (both listings live, daily monitor capturing baseline)
- [ ] Run `npm run monitor:listings` daily by hand for 3–5 days before scheduling cron — confirms baseline behavior, surfaces edge cases (state changes, sold_out, tag edits, etc.) per principle #7
- [ ] First sale (validation milestone) — both listings active, awaiting market signal

### Data-Quality Bugs (open)
- _All three currently in Current Focus above; fix lands next._

### Backlog (committed, deferred)
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

### Future (after first sale validation)
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
- **`listings` schema couldn't store live Etsy state** — mirror columns missing, `title` was `NOT NULL` (originally meant for manual drafts), no time-series table for snapshots. Migration `0006_listings_monitoring` added mirror columns + relaxed `title` + created `listings_stats` (append-only with `raw` jsonb for future-proofing) + unique index on `etsy_listing_id` so seed is idempotent.
- **`node_modules/.package-lock.json` still tracked in git** — left over from before `node_modules/` was gitignored. Untracked in commit `3c98373` ("chore: untrack node_modules/.package-lock.json"). File remains on disk; just no longer noisy in `git status`.
- **Clarity `resemblance` range was outdated in `upscale-image.ts` defaults** — file's docstring claimed `0–3`, but fal's current Clarity schema requires `≤ 1`. Default `1.5` caused 422 on first smoke test. Fixed in commit `519bca0`: default lowered to `1.0`, docstring + CLI help corrected. Same commit also introduces `formatFalValidationError` (shared helper) so all fal `ValidationError` 422s now surface `err.body.detail[]` instead of a generic `"Unprocessable Entity"`.
- **`buildAutoOutputPath` produced double-hyphen filenames** when the 40-char slug slice landed mid-word. Fixed in commit `0d1b419` (trim trailing hyphens after slicing). Existing file `2026-05-21-1255-vintage-watercolor-bunny-scalloped-oval--01.png` predates the fix and keeps its name.
- **Railway `node_modules` warning** — root `node_modules/` was being included in Railway build context. Fixed in commit `21bbf8f` ("add root node_modules/ to gitignore"). Now `node_modules/` and `brain/node_modules/` are both ignored at the repo root.
- **Postgres jsonb rejection on wall-art listings** — Etsy returned raw NUL bytes / control chars in some `description` fields, causing `signals.metadata` inserts to fail with `Empty or invalid json`. Fixed via `sanitizeForJsonb` in `brain/src/lib/etsy-search.ts` (commit `1859387`).
- **Etsy v3 auth format** — `x-api-key` had to switch from `keystring` to `keystring:shared_secret` per Etsy's Feb 9, 2026 change. Fixed in commit `465690d`.

### Open
- **Etsy attribute schemas vary by taxonomy node** (lesson from publishing 2026-05-21). Recipient property doesn't exist on the Digital Prints taxonomy that the bunny landed under; Materials is constrained-vocabulary on the planner taxonomy and rejected free-text values like "Digital Download" / "PDF". This is a permanent design constraint, not a transient bug: any spec that tries to encode store attribute values at design time (including the Research Agent's current `etsy_attributes` field) will be wrong some non-trivial fraction of the time. Captured as the central motivation for `LISTING_AGENT_REQUIREMENTS.md` §3, §4, and the Tuning Pass 2 `attribute_intent` schema in §7.
- **`monitor-listings.ts` cron is intentionally deferred.** Per principle #7 ("build, validate, automate"), the monitor runs manually for 3–5 days before getting scheduled on Railway. Two snapshots in `listings_stats` so far (both from the same operator-triggered run on 2026-05-21). Once a few daily runs land cleanly, this is the most immediate cron candidate.
- **`FAL_KEY` not yet in Railway Variables.** Only in local `.env.local`. Any deployed job that imports `src/lib/fal.ts` will fail at module-load until this is added. Doesn't affect current cron-less, manual-only deploys, but worth knowing before any agent or job (including a future cron'd `monitor-listings`) starts depending on fal-side work.
- **RLS disabled on 3 tables** — `agent_config`, `agent_runs`, `product_briefs`. Server-write-only by current design, but flagged by Supabase advisor. Not a live exposure unless the anon key ever leaks. Decision deferred until dashboard work begins.
- **All data-quality bugs** listed in §7.
- **Scoring formula ceiling saturation** at confidence 1.000 — lost discrimination at the top of the funnel.
- **`agent_config` table is empty.** Research Agent reads it for presence-only; no tunable params are actually externalized yet. First real config row should appear when prompts move out of source.
- **Clarity Upscaler is diffusion-based**, so even at faithful tuning (`creativity=0.1`, `resemblance=1.0`) it can introduce small detail drift on fine illustrations. For pixel-faithful upscaling of clean line/vector-style art, fall back to `--model=fal-ai/aura-sr` (deterministic GAN, fixed 4x). Documented in `upscale-image.ts` docstring; not yet smoke-tested.
- **Other Clarity parameter ranges have not been independently re-verified** against the current fal schema. `creativity` (0.1), `guidance_scale` (4), `num_inference_steps` (20) all passed the recent smoke test, but a stricter combo could reveal more drift from the docstring. Worth cross-checking when next touching that file.

---

## 10. NEXT SESSION PRIORITIES

Tuning Pass 2 is in. Both listings are live and monitored. Listing Agent prerequisites are down to two (asset registry + data-quality bugs). Top three things to do when conversation resumes:

1. **Fix the 3 data-quality bugs (§7).** This is the immediate next item. `opportunities.niche` null on every row (scoring engine omission), `opportunities.source_count` stuck at 1 (no aggregation across runs), Reddit `post_url` missing from `signals.metadata` (breaks Reddit signal→opportunity traceability). All three live in `src/jobs/score-opportunities.ts` + `src/jobs/collect-reddit.ts`. Single commit: code fix + one-off backfill per bug + before/after sanity-check query. Knocking these out closes the loop on the discovery pipeline so the Listing Agent build doesn't inherit untrusted scoring data.
2. **Establish baseline + triage edge cases.** Run `npm run monitor:listings` once per day for 3–5 days. Watch for: (a) views/favorers monotonically increasing or plateauing per listing — informs whether traffic vs. conversion is the bottleneck; (b) `etsy_state` ever becoming non-`active` (sold_out, removed) so the monitor's behavior under that condition is observed before cron; (c) `etsy_last_modified_at` drifting forward unexpectedly (indicates we edited the listing on Etsy and should reconcile the brief). After ~5 clean runs, promote `monitor:listings` to Railway cron (daily). Per principle #7 — manual first.
3. **Begin Listing Agent build.** With Tuning Pass 2 + SEO engine shipped and (after #1) the data layer trustworthy, the remaining prereqs are concrete: migration `0007_assets.sql`, `gen`/`upscale` UPSERT into `assets`, `npm run link:asset` CLI for the bunny + planner manual assets. Per `LISTING_AGENT_REQUIREMENTS.md`. Also decide the asset-pipeline gap (see Backlog) — expand-pipeline vs constrain-schema — before the agent first publishes against a v2 brief that claims a transparent PNG + ratio-guide PDF the pipeline doesn't yet build.

Secondary, if time allows: consider Pinterest pin sets for both live listings as a complementary first-sale lever (no fal cost; mostly time), or use `npm run gen --ref=…` to produce lifestyle/in-context shots that complement the existing flat-art photos. Don't run multiple growth experiments in parallel — pick one the monitor baseline points to so attribution is clean.

---

## 11. HOW TO START A NEW CONVERSATION

Paste **this entire document** into a fresh Claude conversation (Cursor, claude.ai, or API), then say:

> I'm continuing work on the brain project (autonomous Etsy orchestrator under HillwardStudio). The handoff document above describes the current state — please confirm you've read it, then tell me what you think the right next move is and why. The repo is at `/Users/jasontodd/Desktop/coding projects/Ecomm Bot/Ecomm-Brain-/brain`. Don't make any changes yet — start by reading `PRINCIPLES.md` and the latest few entries in `TODO.md` to make sure nothing has drifted, then propose the next concrete step.

For shorter pickups (small bug fix, isolated change), you can skip the full handoff and just paste the relevant section (§4 codebase map + the specific files involved).

If the conversation is going to do anything that touches Supabase or Railway: confirm the operator has run the Supabase MCP at least once in the session (it works via service role and shouldn't need re-auth), and re-trigger `mcp_auth` for Railway if it's stale.
