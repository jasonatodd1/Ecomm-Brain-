# Brain TODO

> Living document. **Open work only** — Current Focus, Backlog, Future. Shipped work lives in `CHANGELOG.md`; the "why"/architecture lives in `PRINCIPLES.md`.
> **Discipline (principle #10):** every commit that completes a backlog item checks it off and moves the entry to `CHANGELOG.md` in the same commit. Don't let a "Done" pile accumulate here — if this file stops being scannable, it stops being read.

## Current Focus

### Drive first sale (3 listings live, daily monitor capturing baseline)
- [ ] Run `npm run monitor:listings` daily by hand for 3–5 days before scheduling cron — confirms baseline behavior, surfaces edge cases (state changes, sold_out, tag edits, etc.) per principle #7
- [ ] First sale (validation milestone) — 3 listings active (meal planner + A5 calendar + bunny), awaiting market signal

### Open product/listing follow-ups
- [ ] **Description reconciliation (bunny):** analysis complete — brief v2 description wins on SEO (94% vs 73%) and structure; apply manually with deliverables corrected to **5 JPGs only** (8×10–24×36). See commit report / chat for per-section verdict.
- [ ] Decide Phase 2 OAuth + auto-publish gate (per principle #7: N≥5 clean previews approved without edits before `--publish` becomes default per taxonomy).

### Design Agent + visual loop
- [ ] **Locked-asset injection** — render-time includes so the loop cannot redraw curated SVGs (blocker for autonomous refine).
- [ ] **Few-shot critic anchoring** — known-good/bad reference PNGs in vision prompt (blocker for autonomous refine).
- [ ] **Design Agent v1** — brief `image_spec` → template select → fill → render → optional refine → `link:asset`. See `DESIGN_AGENT_REQUIREMENTS.md`.

## Backlog (committed, deferred)

### Listing Agent
- [ ] **Listing Agent Phase 2 — OAuth + auto-publish.** v1 is package-generator-only (operator pastes into Etsy by hand). Phase 2: OAuth flow → `POST /v3/application/shops/{shop_id}/listings`. Gated on N≥5 consecutive clean previews approved without operator edits per (store + taxonomy) combo, per principle #7. Includes the store-section auto-create / `--publish` mode from `LISTING_AGENT_REQUIREMENTS.md` §5.
- [ ] **Listing Agent improvements identified during v1 validation:**
  - [ ] Style-descriptor ordering: agent picks first-match across descriptors → for the bunny, "vintage" wins over "cottagecore", landing on `Home style=Victorian` instead of `Country & farmhouse`. Either (a) preference-rank semantic-substitution candidates by lift score, (b) have the Research Agent emit `style_descriptors` ordered by intended priority, or (c) bias substitution toward the brief's `differentiation_angle` keyword.
  - [ ] `Art subject` discovery — agent currently skips it on the bunny brief (audience_descriptors don't contain "rabbit"/"bunny"/"animal"). Should derive subject candidates from `product.name`, `product.design.required_elements`, and the primary keyword's nouns. Today's hand-built bunny listing has `Art subject=Animal`; v1 doesn't reach it.
  - [ ] `Pattern` is free-text on Digital Prints — agent currently surfaces as `free_text_not_mapped`. Should optionally emit the top 1-2 style descriptors as Pattern verbatim when listing-level free-text materials are also being emitted.
  - [ ] **Photo selection / `display_order` consumption** — meal planner validation: the image manifest matched only **4 of 7** available photos because it maps by asset `kind` and ignores `assets.metadata.display_order`. Should consume `display_order` and fill all available slots in intended sequence (queue-style), not first-match-by-kind, so a fully-shot 7-photo set isn't silently truncated. Surfaced in `products/hillward-meal-planner/listing-package-v1.md` operator notes.
  - [ ] **`differentiation_thesis.wedges[]` consumption** — meal planner validation: the agent reads the thesis only via prose fields, not the structured `wedges[]` array (research-v3.2). Multi-wedge positioning landed in the copy by luck of the prose, not by design. Should iterate `wedges[]` (with grounding tags) so the strongest/most-grounded wedge deterministically drives title, first description line, and tag priority.
- [ ] **Pinterest adapter for Listing Agent.** Both v2 briefs flag Pinterest as the highest-leverage external traffic source for HillwardStudio. Adapter scope: Pin = image + title + description + destination URL + board assignment. Reuses the v1 Etsy adapter pattern (`src/agents/listing/adapters/etsy.ts`). _(This is Pinterest as a distribution/listing channel — distinct from Pinterest-as-demand-discovery, which is retired; the demand path is folded into the paid keyword-volume tool item below.)_

### Cost + infrastructure
- [ ] **Cost tracking + caps (consolidated).** One workstream, built in order: (1) `expense.ts` utility for programmatic cost logging — no more raw SQL inserts; (2) aggregate the existing `cost.api_call` activity events into the `cost_log` table; (3) per-provider daily cost caps as a runaway-spend guardrail. Caps depend on the aggregation existing, which depends on the utility.
- [ ] Model router abstraction (Opus / Sonnet / Haiku / Gemini swap without code changes)
- [ ] Cron scheduling on Railway (after scoring engine validated AND after 3–5 days of manual `monitor:listings` runs validate output — listings monitor is the most immediate cron candidate; collectors next)
- [ ] Etsy 429 retry with exponential backoff (concurrency limit eliminated burst 429s; transient ones still possible — add retry honoring Retry-After header)

### Discovery + scoring quality
- [ ] Drop dead keywords from seed list (digital planner, printable wall art, custom invitation template); investigate or remove gratitude journal printable (SerpApi failure case)
- [ ] Scoring formula ceiling: multiple Google Trends keywords hitting confidence 1.000 — lost discrimination at top, needs refactor (higher ceiling, log scale, or different math)
- [ ] **Demand stability score (consolidated).** Single-window Google Trends velocity is volatile — keywords swing +8%→+494% in one cycle, and meal planner `ext_demand` swung 1.0→0 across runs. Need historical velocity tracking + a stability score (re-pull or longer-window confirmation for borderline niches) before trusting single-run velocity for bake-off / whitespace ranking.
- [ ] niche_memory confidence-bump mechanism (currently stuck at 0.50 regardless of evidence_count; confidence should grow with re-confirmation)
- [ ] Monitor synthesis token usage to confirm headroom under max_tokens (one earlier run truncated at 4000; watch as briefs grow with richer data)
- [ ] **Paid keyword-volume tool** (eRank / Marmalead / SerpApi-equivalent) for real search-volume data, per principle #6 (paid APIs over fragile scraping). **Also closes the Pinterest demand slot** and **Etsy autocomplete-as-discovery** (probed 2026-05-28 — blocked): the only viable paths to real buyer-language keywords + volume are a gated partner API or a paid SEO tool. Unofficial endpoint `https://www.etsy.com/suggestions_ajax.php?extras=EXTRA&version=10&search_query=<term>` still exists and returns `{ results: [{ query }] }` in a browser, but **default Node/Railway fetch gets DataDome 403/captcha**; spoofed browser headers are fragile and likely worse from datacenter IPs. Do not build `collect-etsy-autocomplete.ts`. Probe: `npx tsx scripts/probe-etsy-autocomplete.ts`. (Pinterest-as-distribution is the separate Listing Agent adapter above.)

### Repo hygiene
- [ ] **Brief CLI render + git strategy (consolidated).** Build `npm run brief -- --id=<uuid>` to render any brief from Supabase by ID, then gitignore `brain/briefs/` (canonical copy already lives in Supabase). Do both together: the CLI replaces committing brief markdown to git, so nothing is lost when the tracked copies are dropped.
- [ ] **`deliverables/` directory hygiene** — confirm every product's `products/<slug>/deliverables/` is gitignored (binaries) and that the asset registry, not git, is the source of truth for what shipped. Audit for any stray committed binaries that slipped past `.gitignore`.

## Future (after first sale validation)
- [ ] Product creation agent (design generation via Recraft/Ideogram/Flux, PDF assembly)
- [ ] **Competitive SEO Scoring engine — remaining work after v1.** v1 scorer + Research Agent integration shipped (10 rules, deterministic, no LLM; per-keyword classification on every new brief). Two follow-ups remain — both gated on a Listing Agent existing:
  - [ ] Score every `monitor-listings.ts` snapshot and surface week-over-week drift (`COMPETITIVE_SEO_SCORING.md` §5).
  - [ ] Add `etsy_seo_gap` as a new signal type — only when Listing Agent ships and can act on the gap (`COMPETITIVE_SEO_SCORING.md` §6 step 6).
- [ ] Dashboard on Vercel (Supabase Realtime)
- [ ] Orchestrator (cadence-driven job scheduling instead of git-push-driven)
- [ ] Proactive notifications (Telegram bot, daily email digest, weekly strategic brief)
- [ ] Customer service agent
- [ ] Pricing optimization / A/B testing
- [ ] Backup strategy for Supabase

---

_Shipped work → `CHANGELOG.md` (newest-first). Architecture & rationale → `PRINCIPLES.md`._
