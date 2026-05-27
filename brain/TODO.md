# Brain TODO

> Living document. Update when items are completed, priorities shift, or new work is committed to.

## Current Focus

### Meal planner asset v1 (shipped 2026-05-27)
- [x] **Parameterized HTML/CSS/Puppeteer template** — single source in `products/hillward-meal-planner/templates/index.html` parameterized by `data-start` (sun/mon) and `data-size` (letter/a4) attributes flipped by `src/render/meal-planner.ts` before each PDF render. 4 SKUs (`meal-planner-{sun|mon}-{letter|a4}.pdf`) rendered in ~5s total. `npm run build:meal-planner`.
- [x] **`printable_pdf` asset kind** — migration 0011 + `assets.ts` constant. Distinct from `source_file` (master file behind a deliverable): a `printable_pdf` IS the customer-facing PDF for printable products (planners, trackers, charts).
- [x] **4 SKUs linked to brief** `cb213bf4-5225-4bc9-b4ac-67f2167c9b8f` via `link:asset` — all four `printable_pdf` rows present in `assets`.
- [ ] **Visual iteration v1 → v2** — manual operator review loop (visual feedback loop's known flaws mean we don't trust autonomous iteration on design yet).
- [ ] **Listing photos** for hero / lifestyle / whats_included / lifestyle_detail slots (image_spec from v5 brief).
- [ ] **Listing Agent → publish** for meal planner once photos and final asset land.

### Research Agent v3.2 + meal planner v5 brief (shipped 2026-05-27)
- [x] **Multi-wedge differentiation thesis** — `differentiation_thesis.wedges[]` with per-wedge grounding tags (`buyer-voice-backed` / `partial-buyer-voice-backed` / `incumbent-inferred` / `speculative`). Each wedge cites supporting_evidence + counter_evidence so the grounding discipline does not depend on careful prose. Wedge type taxonomy: workflow / customization / aesthetic / audience / pricing / other. See `RESEARCH_AGENT.md` §4.
- [x] **Meal planner v5 brief** — `npm run resynth:meal-planner-v5` re-synthesizes v4's data into a multi-wedge thesis (no new data collection). Lead wedge = workflow `incumbent-inferred`; second wedge = customization `partial-buyer-voice-backed` (backed by password-protection + inflexible-entry pain; honest counter-evidence: analytics buyers are not the audience). Asset spec unchanged.
- [ ] **Asset creation decision** — proceed on meal planner v5 brief (multi-wedge thesis is sharper but same asset).

### Research Agent v3.1 + meal planner v4 brief (shipped 2026-05-27)
- [x] **Incumbent relevance filter** — product-gap analysis now classifies candidate pool via Haiku and operates on relevance-confirmed same-niche incumbents only. SEO-gap analysis unchanged (top-by-favorers). Pool: 20→40 with expansion; target 3 relevant; honest data_thinness reporting (high/medium/low). See `RESEARCH_AGENT.md` §3.
- [x] **Meal planner v4 brief** — re-run on relevance-filtered set surfaced MyLifePlans/PlansByChloe/MarrMarStudio (real meal planners) with 12 buyer-voice signal reviews vs v3's 3. Single-page+aisle-grouped thesis confirmed and refined.

### Research Agent v3 + meal planner brief (shipped 2026-05-22)
- [x] **Research Agent upgrade** — reviews mining (`getListingReviews`), Haiku product feature extraction, load-bearing `differentiation_thesis` (research-v3). See `RESEARCH_AGENT.md`.
- [x] **Meal planner printable v3 brief** — `npm run seed:meal-planner` + `npm run research:meal-planner`.

### White-space engine (proof-of-mechanism shipped 2026-05-22)
- [x] **White-space triangulation scoring** — `npm run score:whitespace` runs gap engine standalone on candidate-pool opportunities; persists gap fields (migration 0009). Smoke-tested on 9 seed candidates.
- [x] **Broad Trending Now collector** — `npm run collect:trending-now` (15 consumer categories, hours=168, Haiku product+IP gate, Pass C in `score-opportunities.ts`). First broad run: 2175 deduped → 600 classified → 6 kept → 16 candidates gap-scored.
- [x] **Niche bake-off baseline run** — `npm run bakeoff` (20 keywords × 9 niches, Etsy+Google, neutral WS scoring + digital decision-hurdle). v1 (broken Google leg): `bakeoff-baseline-no-pinterest-2026-05-26T23-39-41`. v2 (fresh Trends per keyword): see latest `bakeoff-baseline-v2-google-fixed-*` run. See `NICHE_BAKEOFF.md`.
- [ ] **Niche bake-off Pinterest treatment** — re-run with Pinterest demand slot populated; diff vs v2 baseline.
- [ ] **Pinterest comparison + product #3 pick** — after bake-off treatment review.

### Drive first sale (both listings live, daily monitor capturing baseline)
- [ ] Run `npm run monitor:listings` daily by hand for 3–5 days before scheduling cron — confirms baseline behavior, surfaces edge cases (state changes, sold_out, tag edits, etc.) per principle #7
- [ ] First sale (validation milestone) — both listings active, awaiting market signal

### Use the Listing Agent (just shipped) on real briefs
- [x] Generate marketing assets for the bunny's listing photos — 6 fal UI photos + programmatic size guide registered in `products/hillward-nursery-bunny/listing-photos/`. **Image manifest 5/5 ready** (hero, lifestyle, whats_included, size_grid, lifestyle_detail).
- [ ] Generate marketing assets for the planner's 5 missing image slots (all of them — only the source PDF is registered today).
- [ ] **Description reconciliation (bunny):** analysis complete — brief v2 description wins on SEO (94% vs 73%) and structure; apply manually with deliverables corrected to **5 JPGs only** (8×10–24×36). See commit report / chat for per-section verdict.
- [ ] Decide Phase 2 OAuth + auto-publish gate (per principle #7: N≥5 clean previews approved without edits before `--publish` becomes default per taxonomy).

### Design Agent + visual loop (capability test shipped 2026-05-22)
- [x] **`refine:graphic` loop** — render → vision critique → revise → re-render; keep-best-so-far; parse robustness. See `DESIGN_AGENT_REQUIREMENTS.md`.
- [x] **Bunny size guide v2** — hand-built couch scale reference (`sofa.svg`), 13 px/in honest scale, `size_grid` PNG re-rendered. Full spec in `DESIGN_AGENT_REQUIREMENTS.md` §7.
- [ ] **Locked-asset injection** — render-time includes so the loop cannot redraw curated SVGs (blocker for autonomous refine).
- [ ] **Few-shot critic anchoring** — known-good/bad reference PNGs in vision prompt (blocker for autonomous refine).
- [ ] **Design Agent v1** — brief `image_spec` → template select → fill → render → optional refine → `link:asset`. See `DESIGN_AGENT_REQUIREMENTS.md`.

## Data-Quality Bugs (open)
- _All three fixed; see "Data-Quality Bug Fixes" section in Done._

## Backlog (committed, deferred)
- [ ] **Listing Agent Phase 2 — OAuth + auto-publish.** v1 is package-generator-only (operator pastes into Etsy by hand). Phase 2: OAuth flow → `POST /v3/application/shops/{shop_id}/listings`. Gated on N≥5 consecutive clean previews approved without operator edits per (store + taxonomy) combo, per principle #7. Includes the store-section auto-create / `--publish` mode from `LISTING_AGENT_REQUIREMENTS.md` §5.
- [ ] **Listing Agent improvements identified during v1 validation:**
  - [ ] Style-descriptor ordering: agent picks first-match across descriptors → for the bunny, "vintage" wins over "cottagecore", landing on `Home style=Victorian` instead of `Country & farmhouse`. Either (a) preference-rank semantic-substitution candidates by lift score, (b) have the Research Agent emit `style_descriptors` ordered by intended priority, or (c) bias substitution toward the brief's `differentiation_angle` keyword.
  - [ ] `Art subject` discovery — agent currently skips it on the bunny brief (audience_descriptors don't contain "rabbit"/"bunny"/"animal"). Should derive subject candidates from `product.name`, `product.design.required_elements`, and the primary keyword's nouns. Today's hand-built bunny listing has `Art subject=Animal`; v1 doesn't reach it.
  - [ ] `Pattern` is free-text on Digital Prints — agent currently surfaces as `free_text_not_mapped`. Should optionally emit the top 1-2 style descriptors as Pattern verbatim when listing-level free-text materials are also being emitted.
- [ ] Drop dead keywords from seed list (digital planner, printable wall art, custom invitation template); investigate or remove gratitude journal printable (SerpApi failure case)
- [ ] `expense.ts` utility for programmatic cost logging (no more raw SQL inserts)
- [ ] Per-provider cost caps with daily limits (runaway-spend guardrail)
- [ ] Model router abstraction (Opus / Sonnet / Haiku / Gemini swap without code changes)
- [ ] Cron scheduling on Railway (after scoring engine validated AND after 3–5 days of manual `monitor:listings` runs validate output — listings monitor is the most immediate cron candidate; collectors next)
- [ ] Scoring formula ceiling: multiple Google Trends keywords hitting confidence 1.000 — lost discrimination at top, needs refactor (higher ceiling, log scale, or different math)
- [ ] Google Trends velocity volatility: keywords can swing from +8% to +494% in one cycle. Need historical tracking and a stability score before trusting single-run velocity
- [ ] **Demand stability score** for bake-off / whitespace ranking — re-pull or longer-window confirmation for borderline niches (single-window Trends velocity is volatile; meal planner ext_demand swung 1.0→0 across runs)
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
- [ ] **Pinterest adapter for Listing Agent.** Both v2 briefs flag Pinterest as the highest-leverage external traffic source for HillwardStudio. Adapter scope: Pin = image + title + description + destination URL + board assignment. Reuses the v1 Etsy adapter pattern (`src/agents/listing/adapters/etsy.ts`).
- [ ] **Listing Agent v1 — DONE (shipped in the `feat: Listing Agent v1` commit).** Package generator (Etsy-only): brief → PublishPackage + operator-review markdown at `brain/packages/<date>-<brief_id>-etsy.md`. Live-taxonomy attribute mapping (codifies §4 of `LISTING_AGENT_REQUIREMENTS.md` — blank > wrong), pre-publish SEO gate that beats incumbent benchmark before declaring ready, image manifest matching brief.listing.image_spec against the assets registry with generation hints for misses. CLI: `npm run list:package -- --brief-id=<uuid>`. See Done section for full breakdown.
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

## Done

### Broad Trending Now collector (`feat: broad Trending Now collector` commit)
- [x] **`collect-trending-now.ts`** + `npm run collect:trending-now` — SerpApi `engine=google_trends_trending_now`, 15 consumer categories (IDs verified at runtime against SerpApi JSON), `hours=168`, `geo=US`, dedupe by query with category union.
- [x] **Haiku gate** — `classify-trend-relevance.ts`: PRODUCT vs NOISE + hard IP block; logs every query to `activity`.
- [x] **Pass C** — `score-opportunities.ts` scores `google_trends_trending_now` / `trending_now` signals into opportunities (niche from category, log-scaled volume + velocity confidence).
- [x] **Whitespace cap** — `score:whitespace --limit=40` ranks candidates by demand before Etsy gap scoring.
- [x] **First broad run** — 2175 deduped, 600 classified (default `--classify-limit=600`), 6 kept, 16 total candidates gap-scored in 64s.

### White-space triangulation scoring (`feat: white-space triangulation scoring` commit)
- [x] **`src/lib/whitespace-scoring.ts`** — demand × supply-quality matrix: `demand_combined = 0.35×external + 0.65×incumbent_engagement`; `supply_weakness` from gap classification + SEO median; `white_space_score = demand × supply_weakness`; quadrants WHITE_SPACE / RED_OCEAN / DEAD_ZONE / MATURE.
- [x] **`src/jobs/score-whitespace.ts`** + `npm run score:whitespace` — scores candidate-pool opportunities (no listing, no brief): Etsy search → `computeCompetitiveLandscape` → triangulation → persist on `opportunities`.
- [x] **`competitive.ts` extended** — top incumbents now carry `num_favorers`, `views`, `shop_review_count`; landscape entries carry `median_favorers`, `median_views`, `median_shop_reviews`.
- [x] **Migration 0009** — whitespace columns + indexes on `opportunities`.
- [x] **Smoke test** — 9 candidates scored in ~34s (~9 search + ~77 listing + ~60 shop Etsy calls; 5 listing + 3 shop 429s, still usable).

### Bunny size-guide listing photo (`feat: bunny size-guide listing photo` commit)
- [x] **`size-guide.html`** — programmatic size comparison graphic matching `whats-included.html` visual language (cream `#EDE8E1`, sage `#6B7F5E`, Inter typography, HillwardStudio header/footer). **v2 (2026-05-22):** couch scale reference via `templates/assets/furniture/sofa.svg`, 13 px/in honest scale, hand-built (loop not trusted for curated assets). Rendered → `listing-photos/size-guide.png` (2000×2000). Registered as `size_grid`. See `DESIGN_AGENT_REQUIREMENTS.md`.

### Bunny listing photos registered (`chore: register bunny's 6 listing photos + add artwork_flat asset kind` commit)
- [x] **6 listing photos** saved to `products/hillward-nursery-bunny/listing-photos/` and registered in `assets` (5 new rows + 1 whats_included path update). Mapping: `hero.jpg` (primary shelf mockup), `lifestyle-crib.jpg`, `lifestyle-corner.jpg`, `lifestyle-shelf.jpg` → `lifestyle_detail` (no console shot was in attachments — 6th attachment was a planner page, ignored), `artwork-flat.jpg` (from master source), `whats-included.png` (updated existing row from `dist/whats-included.png`). New asset kind `artwork_flat` via migration `0008_assets_artwork_flat.sql`.
- [x] **Registry count for bunny listing:** 17 assets total — listing-photos set complete (hero, 2× lifestyle, lifestyle_detail, artwork_flat, whats_included, size_grid) + deliverables + source_file. Listing Agent image manifest: **5/5 ready**.

### Listing Agent v1 (`feat: Listing Agent v1` commit)
- [x] **Etsy taxonomy + attribute infrastructure** (`brain/src/lib/etsy-taxonomy.ts`, `brain/src/lib/attribute-mapping.ts`). `getTaxonomyNodes()` + `getTaxonomyProperties(id)` with file-based cache under `dist/.cache/etsy-taxonomy/` (24h TTL nodes / 7d properties) + in-memory cache per process; `mapBreadcrumbToTaxonomyId(crumbs)` with parent-fallback (logs `taxonomy.fallback_to_parent` when the brief's category breadcrumb doesn't match the live tree exactly). `mapSemanticToAllowed(descriptors, property)` implements `LISTING_AGENT_REQUIREMENTS.md` §4 — tier 1 exact normalized equality → tier 2 whole-token containment → tier 3 curated semantic-substitution map (cottagecore→country, scandinavian→minimalist, "digital download"→Paper, etc.) → null. Never force-picks. `mapSemanticToAllowedMany` handles multi-valued properties (Etsy Occasion, Material multi, Art subject, Holiday) with value-id dedupe.
- [x] **Listing Agent core** (`brain/src/agents/listing/`). `index.ts` orchestrator: loads brief + listing + assets + niche memory → resolves taxonomy → fetches taxonomy properties → renders Etsy plaintext description via the Tuning Pass 2 `renderBriefAsEtsyDescription` → validates title (≤140, intelligent `|`-boundary trim) → validates tags (Etsy hard rules: ≤20 chars, ≤13, no exact duplicates; title-overlap is a SOFT scorer penalty per Rule 4, not a reject) → maps attributes against live taxonomy via Part A → builds 10-slot image manifest from brief.listing.image_spec against assets registry → scores draft via `scoreEtsyListingSeo()` → if below incumbent benchmark, runs ONE Opus improvement pass on `weak_areas` and re-scores → assembles gaps[] and returns `PublishPackage`. Adapter `adapters/etsy.ts` carries title/tag/image-slot rules + descriptor-to-property routing + property block-list (TeeShirtSize / Device / Fabric / Custom1-2 / etc. auto-skipped). Renderer `render-markdown.ts` emits a self-contained operator-review markdown showing gaps at top, SEO score with per-rule breakdown, title + tags + taxonomy + attributes with substitution notes + skip table + materials + shop section + image manifest with hints + the full Etsy-pasteable description. Opus improve pass `improve.ts` is single-shot, cost-bounded ($0.10/pass), only triggers when below benchmark.
- [x] **CLI + audit trail.** `npm run list:package -- --brief-id=<uuid> [--listing-id=<uuid>] [--store=etsy]`. One `agent_runs` row per (brief_id, store) with full input/output trace; full PublishPackage embedded in `metadata.package` for replay. Discrete `activity` rows with `agent='listing'` at every step: `listing.resolved`, `assets.loaded`, `taxonomy.resolved` / `taxonomy.fallback_to_parent`, `taxonomy.properties_fetched`, `description.rendered`, `title.validated`, `tags.validated`, `attributes.mapped`, `image_manifest.built`, `package.scored`, `package.rescored` (only on Opus pass), `listing.preview_ready`.
- [x] **Validation against both v2 briefs.** Bunny `a70b9002` → SEO **91%** (82/90) vs incumbent median **66%** for "nursery printable art" — **BEATS by 25 pts**; taxonomy resolved exactly to 2078 (Digital Prints); 6 attributes mapped (Material multi → Paper, Primary/Secondary color → Green, Home style → Victorian, Occasion = Baby shower exact, Room → Nursery), 26 skipped (block-listed irrelevants + 3 free-text + 4 with no descriptor match); **`Recipient` correctly NOT mapped** (property doesn't exist on taxonomy 2078 — exactly the May 21 manual-lesson fix); 1/5 image slots ready (whats_included from registry), 4 missing with style-notes + ready-to-run `npm run gen` hints. Planner `535b3e36` → SEO **97%** (87/90) vs incumbent median **68%** for "a5 monthly calendar printable" — **BEATS by 29 pts**; **taxonomy fell back to 354 parent** (brief's "Planners & Planner Accessories" leaf doesn't exist in Etsy's tree — matches live planner's actual `taxonomy_id=354`); 4 attributes mapped (Material multi → Paper, Primary/Secondary color → White, Occasion → Back to school), 17 skipped (no Style / Home style / Room / Art subject on 354 — exactly the May 21 manual lesson); 0/5 image slots ready (only source_file is registered). Both runs Opus-free (deterministic draft already beats benchmark); total cost **$0.00**.
- [x] **Worse-than-human findings (transparently surfaced).** Bunny: live human listing has `Art subject=Animal` — v1 agent skips it because `audience_descriptors` doesn't contain "rabbit"/"bunny"/"animal"; logged as a backlog item (subject-discovery from product.name). Bunny `Home style` lands on Victorian (because "vintage" comes first in style_descriptors and substitutes to Victorian) when "Country & farmhouse" (from cottagecore) is closer to the brief's intent; logged as backlog (style-descriptor ordering / preference-rank semantic candidates). Pattern free-text not auto-filled; logged. Otherwise the agent **matches or exceeds the manual work** on every other dimension validated.

### Asset Registry (`feat: asset registry` commit)
- [x] **Migration 0007 — `assets` table.** Columns: `id`, `kind` (text + CHECK over 11 values), `listing_id` (FK → `listings.id`, nullable), `product_brief_id` (FK → `product_briefs.id`, nullable), `local_path`, `cdn_url`, `width`, `height`, `source` (text + CHECK over 8 values), `fal_request_id`, `metadata` (jsonb default `{}`), `created_at`. Indexes on `(listing_id) WHERE NOT NULL`, `(product_brief_id) WHERE NOT NULL`, and composite `(kind, listing_id)` for the dominant Listing Agent query "find the hero for listing X". RLS off — server-write-only, same posture as `listings_stats` / `product_briefs` / `agent_runs`.
- [x] **All 4 asset producers auto-write into `assets` in addition to their existing activity rows.** `generate-image.ts` → kind=hero default + `--kind` / `--listing-id` flags, source=`fal_generated`, cdn_url=fal URL, dims from sharp post-verify. `upscale-image.ts` → kind=master default + `--kind` / `--listing-id` flags, source=`fal_upscaled`. `build-print-bundle.ts` → one row per deliverable: master→`master`, sized JPGs→5×`print_variant`, print-bundle PDF→`crop_marks_pdf`, transparent PNG→`transparent`, ratio-guide→`ratio_guide` (all `source=build_bundle`). `resize-print-variants.ts` (legacy CLI) → one `print_variant` row per sized JPG, `source=resize_print`. All writes go through the shared `src/lib/assets.ts` helper which prints `[ASSET_INSERT_FAILED]` and continues on failure (file is already on disk; losing the registry row is recoverable via `link:asset`, but crashing after the artifact landed would be worse).
- [x] **Shared `src/lib/assets.ts` helper** — `insertAsset()` (soft-fail, used by producers), `findAssetByPath()` (used by `link:asset` for idempotency), exported `ASSET_KINDS` / `ASSET_SOURCES` arrays + TypeScript union types kept in sync with the migration's CHECK constraints.
- [x] **`npm run link:asset` CLI** (`src/tools/link-asset.ts`). Args: `--listing-id` OR `--etsy-listing-id` (auto-resolves to listings.id uuid via Supabase lookup) OR `--product-brief-id` (one required), `--kind` (required, validated against `ASSET_KINDS`), `--path` (required, must exist on disk), `--source` (default `manual_upload`, validated against `ASSET_SOURCES`), `--width` / `--height` (optional, auto-read via sharp for raster images), `--cdn-url`, `--fal-request-id`, `--metadata='<json>'`. Idempotent on `(kind, local_path)` — re-runs print `~ already linked` and exit 0. Writes activity row with `action='asset.linked'` on success.
- [x] **Bunny + planner backfill complete** (12 rows total, 0 missing-disk warnings). Bunny: 1×`source_file` (master/bunny 10.png, source=`fal_ui`) + 9 deliverables (1×`master`, 1×`crop_marks_pdf`, 1×`transparent`, 1×`ratio_guide`, 5×`print_variant` — all `source=build_bundle`) + 1×`whats_included` (dist/whats-included.png, source=`render_graphic`) = 11 assets for `etsy_listing_id=4508704536`. Planner: 1×`source_file` (dist/planner-v1.pdf, source=`render_planner`) for `etsy_listing_id=4508059444`. The planner's prior versioned PDFs (v2/v3 referenced in the requirements doc) aren't on disk — only v1 — so only v1 was linked. Auto-dimension detection confirmed (e.g., bunny 8x10 variant correctly read as 5008×6260 after the 4:5 ratio crop). Idempotency smoke-tested by re-running master link — clean no-op.

### Data-Quality Bug Fixes (`fix(data-quality)` commit)
- [x] **Bug 1 — `opportunities.niche` null on every row.** Fixed in `brain/src/jobs/score-opportunities.ts`: added `niche` to `OpportunityUpsert`, written on every upsert. Reddit opps inherit the subreddit (already in signal metadata as `subreddit`); Google Trends opps get `DEFAULT_NICHE = 'general'` (mirrors the Research Agent's `nicheTag` fallback in `src/agents/research/index.ts`). Backfill: `UPDATE opportunities SET niche = CASE WHEN metadata->>'source'='reddit' THEN metadata->>'subreddit' ELSE 'general' END`. Result: **opps with non-null niche: 0 → 11** (9 'general', 2 'planneraddicts').
- [x] **Bug 2 — `opportunities.source_count` stuck at 1.** Fixed in `brain/src/jobs/score-opportunities.ts`: added `buildTrendsSourceCountIndex` + `buildRedditSourceCountIndex` helpers that count matching rows in the already-fetched `signals` array (no extra DB hits). Google Trends opps count by `(source='google_trends', keyword=opp.name)` — bumps once per metric_type per collection run. Reddit opps count by `(source='reddit', metric_type='buyer_intent_post', metadata.post_id)` — bumps when the same buyer post is re-classified across runs. Also added Reddit dedupe-by-`post_id` so re-observed posts produce one upsert (highest-upvote sample). Backfill ran the same logic via SQL; **first pass** counted 0 for Reddit opps because the 2 pre-existing rows lacked `post_id` in metadata (they pre-date the new code) — **two-step fix** first joined opp.metadata ← signal.metadata via `post_url` to populate `post_id`, then re-ran the count. Result: **opps with source_count > 1: 0 → 9** (the 9 trends keywords; both Reddit posts legitimately stay at 1, observed once).
- [x] **Bug 3 — Reddit `post_url` missing from `signals.metadata`.** Fixed in `brain/src/jobs/collect-reddit.ts`: renamed metadata key `url` → `post_url` on the per-post buyer-signal insert so signal vocabulary now matches what opportunities have always carried. `score-opportunities.ts` reads `metadata.post_url` with `metadata.url` as a one-cycle fallback for any signals that pre-date the fix and slip through backfill. Backfill: `UPDATE signals SET metadata = jsonb_set(metadata, '{post_url}', metadata->'url') WHERE source='reddit' AND metadata ? 'url' AND NOT (metadata ? 'post_url')`. Result: **reddit signals with post_url: 0 → 16** (all individual posts; the 7 `new_post_count` aggregate rows correctly stay without a URL since they don't represent a single post).
- [x] **Edge case surfaced during backfill** — the 2 pre-existing Reddit opportunities (seeded manually before the new code ever ran) lacked `metadata.post_id`; future-run source_count would have returned 0 for them. Backfill restores it by joining on the now-consistent `post_url` key — proves out the design that `post_url` is the canonical cross-table join key for Reddit signals.

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
- [x] `resize-print-variants.ts` + `npm run resize:print` — 5 print sizes (8×10, 11×14, 16×20, 18×24, 24×36) from a 5008×6680 master via `sharp.extract`. Now delegates to the shared `src/lib/print-bundle.ts` lib (single source of truth for `PRINT_SIZES`, crop coords, and sharp ops).
- [x] **Full deliverable bundle (`build-print-bundle.ts` + `npm run build:bundle`).** Reads a master image and produces every artifact a v2 wall-art brief promises a buyer: master JPG at 300 DPI + 5 sized JPG variants in `sized/` + multi-page print-bundle PDF with crop marks at each trim corner + transparent PNG (background removed via `fal-ai/birefnet/v2` at the Dynamic 2304×2304 variant with `refine_foreground=true`; output preserves full 5008×6680 input resolution) + single-page ratio-guide PDF (US Letter, legend with all 5 sizes + ratios + frame recommendations + scale comparison diagram). Outputs land at `products/<slug>/deliverables/` (gitignored — binaries). One `activity` row per deliverable (`agent='product', action='asset.built'`) carrying kind / path / size / duration / cost / per-kind metadata. Smoke-tested 2026-05-21: bunny pipeline ran in 41.7s end-to-end, $0.00 fal cost (birefnet is free), 140.2 MB total, transparent PNG corners verified fully transparent (alpha=0).
- [x] Shared `src/lib/print-bundle.ts` library — pure-function builders (`buildMasterJpg`, `buildSizedJpgVariants`, `buildPrintBundlePdf`, `buildRatioGuidePdf`) + canonical `PRINT_SIZES` catalog with imperial trim dims, source-pixel crop coords, and ratio labels. PDFs built via `pdf-lib`.
- [x] `fal.ts` extended with `birefnet` model alias (`fal-ai/birefnet/v2`), `estimateBirefnetCost()` (returns 0 — fal's pricing page lists this model as free), and `removeBackground(opts)` helper that uploads input, calls fal, downloads the transparent PNG.
- [x] `ProductBrief.product.format.deliverables[]` schema field (enum kinds: `master_jpg | sized_jpg_set | print_bundle_pdf | transparent_png | ratio_guide_pdf`) added in Tuning Pass 2 follow-up. Legacy `includes` free-text preserved for buyer-facing copy. Listing Agent will verify every entry against `products/<slug>/deliverables/` before publishing — closes the "brief claims something the pipeline can't produce" gap.

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
