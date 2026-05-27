# Listing Agent — Requirements

> Durable spec. Captures lessons learned while publishing the first two HillwardStudio listings by hand on 2026-05-21 (planner `4508059444`, bunny `4508704536`). Source of truth for what the Listing Agent must do — and what the Research Agent must produce — before either can be automated end-to-end.
>
> Living document. Update whenever a manual publish reveals a new attribute-schema quirk, store rule, or asset gap the agent will need to handle.

## Implementation status — v1 (2026-05-22)

> **v1 shipped — package generator + manual publish.** `npm run list:package -- --brief-id=<uuid>` produces a full `PublishPackage` plus an operator-review markdown at `brain/packages/<date>-<brief_id>-etsy.md`. Validated end-to-end against both Tuning Pass 2 briefs (bunny SEO 91% / planner 97% — both beat their incumbent benchmarks; Opus pass never fired; total cost $0.00 for the two-product validation run).
>
> | Section | v1 capability | v1 status |
> |---|---|---|
> | §2 Inputs | `product_briefs` + `listings` + `assets` + `niche_memory` + Etsy taxonomy fetched per run | ✅ built |
> | §3 Store-schema fetch | `getTaxonomyNodes()` + `getTaxonomyProperties()` cached to disk (24h / 7d) + in-memory | ✅ built |
> | §3 Shop sections / shipping profiles | Fetch + auto-create on publish | ⏸ Phase 2 (needs OAuth) |
> | §4 Allowed-value verification | `mapSemanticToAllowed()` exact → token → curated semantic → null (blank over wrong) | ✅ built |
> | §5 `ListingPackage` output | Title + description + tags + taxonomy + attributes + materials + image_manifest + SEO score + gaps | ✅ built (no shop_section_id resolution / no publish_payload yet — see Phase 2) |
> | §5 `--preview` mode | Writes `agent_runs.metadata.package` + operator markdown at `brain/packages/<date>-<brief_id>-etsy.md` | ✅ built (operator pastes by hand instead of going through `decision_needed`) |
> | §5 `--publish` mode | OAuth POST to `/v3/application/shops/{shop_id}/listings` | ⏸ Phase 2 |
> | §5 Auto-trigger missing-asset generation | Emits generation hints + ready-to-run `npm run gen` skeleton per missing slot | ✅ built as hints (auto-trigger is Phase 2 — operator runs the command) |
> | §6 Asset registry | `assets` table + 4 producers + `link:asset` CLI | ✅ built (separate commit, prerequisite for v1) |
> | §7 Research Agent Tuning Pass 2 | `attribute_intent` + structured `listing.description` + `image_spec` + `shop_section_suggestion` + `competitive_landscape` | ✅ built (separate commit, prerequisite for v1) |
> | §7.5 Research Agent Tuning Pass 3 | `differentiation_thesis` (reviews mining + product features + load-bearing alignment) | ✅ built — see `RESEARCH_AGENT.md` |
> | §8 Multi-store architecture | `src/agents/listing/` + `adapters/etsy.ts` shape | ✅ built for Etsy; Pinterest / Shopify deferred |
> | §9 Logging | `agent_runs` (`agent='listing'`) + per-step `activity` rows | ✅ built |
> | Pre-publish SEO gate | `scoreEtsyListingSeo()` against incumbent benchmark from `brief.competitive_landscape`, ONE Opus pass on `weak_areas` if below | ✅ built (capped at 1 pass per spec — never recurses) |
>
> **Phase 2 (deferred per principle #7):** OAuth flow + `--publish` mode + shop-section auto-create + auto-trigger missing-asset generation. Gated on N≥5 consecutive clean previews approved without operator edits per (store + taxonomy) combination.
>
> **v1 limitations identified during validation (tracked in `brain/TODO.md` → Backlog):**
> 1. Style-descriptor ordering — agent picks first-match across descriptors, so for the bunny brief "vintage" wins over "cottagecore" and lands on `Home style=Victorian` rather than the closer `Country & farmhouse`. Fix: rank by lift score, or have Research Agent emit descriptors in priority order, or bias toward the brief's `differentiation_angle` keyword.
> 2. `Art subject` discovery — agent currently skips it on the bunny because `audience_descriptors` doesn't contain "rabbit" / "bunny" / "animal". The hand-built bunny listing has `Art subject=Animal`. Fix: derive subject candidates from `product.name`, `product.design.required_elements`, and primary keyword nouns.
> 3. `Pattern` free-text — agent surfaces as `free_text_not_mapped` instead of auto-filling. Fix: optionally emit the top 1–2 style descriptors as Pattern verbatim.
>
> None are blockers — all surface transparently in the agent's `gaps[]` and skipped-properties table; operator can patch each in seconds at publish time.

---

## 1. Purpose

The Listing Agent takes a `(brief_id, store)` pair and returns a complete publish-ready listing package — title, tags, description, attributes, categories, materials, shop-section assignment, image manifest, and price — fully validated against the destination store's live schema. In `--publish` mode it also performs the OAuth-authenticated POST to the store's API and writes the resulting listing record back to Supabase. The agent is store-agnostic at the core: a single `ListingAgent` class orchestrates brief → package, and per-store adapters (`EtsyAdapter`, `PinterestAdapter`, `ShopifyAdapter`) handle API auth, field limits, vocabulary mapping, and publish endpoints. The agent never asks a human for input mid-run; if it cannot produce a valid value for a slot, it leaves it blank rather than guessing, and surfaces the gap in `agent_runs.metadata` for operator review.

---

## 2. Inputs (autonomous queries)

The agent fetches everything it needs from Supabase + the destination store. No file uploads, no operator parameters beyond `(brief_id, store)`. Inputs the agent must pull:

- **`product_briefs`** row by `brief_id` — full structured brief from the Research Agent (see §7 for required shape after Tuning Pass 2).
- **`listings`** row by `opportunity_id = product_briefs.opportunity_id` — if a draft already exists for this opportunity on this store, the agent updates rather than creates. Idempotency contract: re-running the agent for the same `(brief_id, store)` produces the same package and either updates the existing draft or no-ops.
- **`assets`** table (see §6) filtered by `product_brief_id` or `listing_id` — the registry of every generated/uploaded image with kind/dims/source/local_path/cdn_url. Drives the image manifest in §5.
- **`niche_memory`** rows for `brief.niche_tag` — cumulative learnings (which tags converted, which descriptors got rejected by attribute schemas, which size/format combinations sold). The agent reads before acting and writes back after — same closed-loop contract as the Research Agent (PRINCIPLES principle #1, #4).
- **Store-specific reference data** — see §3.

The agent never reads from the filesystem outside the `assets` registry and never accepts ad-hoc CLI flags for content overrides. Every content decision is traceable to a brief field, a niche-memory entry, or a store-schema constraint.

---

## 3. Store-specific reference data (fetched dynamically per run)

### Etsy

- `GET /v3/application/seller-taxonomy/nodes` — full taxonomy tree. Source of truth for the numeric `taxonomy_id` the agent must POST as `taxonomy_id` on `createDraftListing`.
- `GET /v3/application/seller-taxonomy/nodes/{taxonomy_id}/properties` — **the** source of truth for which attribute slots exist for that category AND, for constrained-vocabulary properties, the exact `possible_values` array each property accepts. This endpoint is what makes §4 enforceable; without it the agent is guessing.
- `GET /v3/application/shops/{shop_id}/sections` — current shop sections. Listing Agent matches `brief.listing.shop_section_suggestion` against this list; if no match, creates a new section via `POST /v3/application/shops/{shop_id}/sections` only if the brief is confident enough (>0.7 — TBD threshold) and the section name is well-formed, otherwise leaves blank.
- `GET /v3/application/shops/{shop_id}/shipping-profiles` and `GET /v3/application/shops/{shop_id}/return-policies` — required for physical listings; for digital (`is_digital=true`, `type=download`) shipping profile is omitted, return policy is set to the shop's default digital policy.

**Caching:** taxonomy + properties responses are cached in Supabase (new table `store_schema_cache(store, endpoint, response_jsonb, fetched_at, ttl_seconds)`; TTL ≥ 24h for taxonomy, ≥ 7d for property schemas). The agent invalidates the cache and refetches whenever a publish 4xx response surfaces an `invalid attribute` error, then retries once.

### Competitive SEO scoring is a separate concern

The store-schema fetches above answer "what attribute slots exist and what values are allowed?" — a per-listing publish-time question. The orthogonal question "how good is this listing's SEO?" is owned by a separate shared library, `brain/src/lib/etsy-seo-scoring.ts`, fully specified in `brain/COMPETITIVE_SEO_SCORING.md`.

The Listing Agent is a **downstream consumer** of that scoring engine, not its owner. The engine is shared with the Research Agent (which uses it to detect weak-incumbent keyword opportunities at brief time — see `COMPETITIVE_SEO_SCORING.md` §4). The Listing Agent's specific responsibilities are:

- Score its own draft package via `scoreEtsyListingSeo()` before publish, using the median score of the top 5 incumbents from `brief.competitive_landscape` as the target ceiling (see `COMPETITIVE_SEO_SCORING.md` §5).
- If the draft scores below the ceiling, iterate with Opus on the specific `weak_areas` returned by the scorer (max 2 retry passes recorded in `agent_runs.metadata.draft_iterations[]`).
- If iteration cannot close the gap, block publish and escalate via a `decision_needed` row rather than ship a draft that loses to incumbents by default.
- After publish, score every `monitor-listings.ts` snapshot so drift week-over-week becomes visible (see `COMPETITIVE_SEO_SCORING.md` §5 — drift monitoring).

Keeping ownership in the shared lib rather than in the Listing Agent itself is what makes the contract symmetric: the same rubric that scores incumbents in research is the rubric our drafts have to clear at publish.

### LESSON LEARNED TODAY (2026-05-21)

Etsy attribute schemas **vary by taxonomy node** — sometimes dramatically. Hardcoded recommendations from the brief and from my prior listing-input mapping cost real edit time today:

- **"Recipient"** exists as a property for many wall-art / gift categories but **does NOT exist for the Digital Prints taxonomy node the bunny listing landed under.** Recommending `Recipient = Babies` was wasted advice — the slot literally isn't present on that listing form.
- **"Materials"** is **constrained-vocabulary** for some categories (notably planners / journals — the A5 planner listing showed a curated dropdown), so free-text values like `"Digital Download"`, `"PDF"`, or `"Printable"` from the brief or my recommendations were rejected. The schema only accepts values from its `possible_values` array, which for the planner taxonomy is a much shorter, paper/craft-flavored list.
- Implication: **never recommend an Etsy attribute value without first having fetched that taxonomy's properties response and checked `possible_values`.** A spec-time hardcoded list of "good Etsy attributes" is a liability, not an asset.

This is the central reason §4 exists as a hard requirement, not a guideline.

### Pinterest / Shopify (placeholders — adapters not yet built)

- **Pinterest:** Boards list (`GET /v5/boards`), Pin format constraints (image dims, character limits for title/description, allowed link domains for the destination URL).
- **Shopify:** product type taxonomy (`GET /admin/api/.../products.json` schema), tags (free-text, no enum), publication channels, metafield schema for the active theme.

Both will reuse the same caching pattern and the same §4 verification discipline. Adapter responsibility, not core-agent responsibility.

---

## 4. Allowed-value verification — REQUIREMENT

This is the single most important contract in this spec. It applies uniformly to every attribute slot, every store.

**The agent MUST, before writing any value to an attribute slot:**

1. Look up the property in the cached store-schema response for the destination category.
2. If the property is **not present** for that category → skip the slot. Do not warn the user. Do not invent the property. Log `attribute.skipped_missing_property` activity row with the property name + taxonomy_id.
3. If the property is present and has a `possible_values` array → the agent's proposed value MUST appear in that array (case-insensitive, whitespace-trimmed equality).
4. If the proposed value is **not** in `possible_values` → run a semantic-substitution step:
   - Embed-distance (or LLM-classified) closest match from `possible_values` to the proposed descriptor.
   - Acceptance threshold: the substitute must be a reasonable semantic neighbor, not just the nearest string match. Worked examples:
     - `"Cottagecore"` → if absent, accept `"Country"` (close cultural neighbor) or `"Rustic"` (close visual neighbor); reject `"Modern"` (semantic opposite).
     - `"Scandinavian"` → if absent, accept `"Minimalist"`; reject `"Boho"`.
     - `"Digital Download"` in a constrained Materials property → if absent, accept `"Paper"` (since the buyer will print on paper) or leave blank if no reasonable physical-medium match exists.
   - Log the substitution in `agent_runs.metadata.attribute_substitutions[]` with `{ slot, proposed, substituted, reason, taxonomy_id }`.
5. If no value clears the semantic-substitution bar → **leave the slot blank.** A blank slot is always better than a wrong slot. Log `attribute.skipped_no_match` activity row.

**Properties this applies to (non-exhaustive, all Etsy):** `style`, `color`, `materials`, `occasion`, `recipient`, `room`, `subject`, `instrument`, `device_compatibility`, `pattern`, `holiday`, and every future property Etsy adds. The agent treats the live `possible_values` response as authoritative; it never carries its own hardcoded list.

**Free-text properties** (e.g. Etsy `materials` in some categories, Shopify `tags`) are exempt from §4 — they still get format validation (length, char set, count) per the adapter but skip the `possible_values` check because there is no enum.

**Rationale for "blank over wrong":** every wrong attribute is one extra reason Etsy's algorithm classifies the listing into a category where the buyer isn't shopping. The cost of a blank slot is one missed signal. The cost of a wrong slot is mis-categorization. Asymmetric.

---

## 5. Outputs (what the agent produces autonomously)

For each `(brief_id, store)` run, the agent emits a `ListingPackage` object — fully validated, ready to either preview or POST. Fields:

- **`title`** — pulled from `brief.listing.title`, validated against the store's char limit (Etsy: ≤140; truncates intelligently at a `|` boundary if over).
- **`description`** — full body text generated by Opus from the structured brief field (see §7 `listing.description`). Renders the structured schema into store-appropriate plain text (Etsy: ALL-CAPS section headers, dash bullets, no markdown). Hook in first 160 chars contains the primary keyword. Total length 2,000–3,500 chars on Etsy. **Worked examples to reproduce or exceed:** the two listings currently live (see §10).
- **`tags`** — pulled from `brief.listing.etsy_tags`, validated against store rules. Etsy: exactly 13 tags, ≤20 chars each, no exact duplicates of title words (Etsy treats title and tags as one keyword pool — duplicating is wasted slots). Validation pass: rejects, dedupes, and asks the brief synthesizer for replacements rather than silently passing 12.
- **`taxonomy_id`** (Etsy) — mapped from `brief.listing.taxonomy_breadcrumb` (e.g. `["Paper & Party Supplies","Paper","Paper Calendars"]`) against the cached `seller-taxonomy/nodes` tree. If the breadcrumb has no exact match → walks up the tree until a match is found and logs `taxonomy.fallback_to_parent`. If the breadcrumb is missing entirely → uses the closest match in the existing `niche_memory` or fails the run with `taxonomy.unresolvable`.
- **`attributes[]`** — populated by §4 only. Each entry `{ property_id, value_ids, scale_id? }`, formatted per the store API.
- **`materials[]`** — Etsy: per §4 (constrained in some categories, free-text in others). Adapter decides which path based on the property schema response.
- **`shop_section_id`** — mapped from `brief.listing.shop_section_suggestion`. See §3.
- **`is_digital`**, **`type`**, **`who_made`**, **`when_made`** — pulled from brief constants or defaults; for digital products these are deterministic (`is_digital=true`, `type=download`, `who_made=i_did`, `when_made=2020_2026`).
- **`price`** — pulled from `brief.product.pricing.price_cents`. The agent never overrides pricing; pricing is a Research Agent decision (per PRINCIPLES — humans escalate at >$75; agents publish at brief-set price).
- **`image_manifest[]`** — ordered list of asset slots the listing needs (Etsy supports up to 10 photos + 1 video). Slot kinds derived from `brief.listing.image_spec` (see §7). For each slot:
  - If a matching asset exists in the `assets` table → reference it (local_path or cdn_url for upload).
  - If no matching asset → emit a `generation_request` (kind, dimensions, prompt anchors from `brief.design.mood_keywords` + `brief.design.style`, reference image if applicable) and **auto-trigger** `generateImage(opts)` from `src/tools/generate-image.ts`. Then `upscaleImage` if the slot needs print resolution. New assets are UPSERTed into the `assets` table per §6.
- **`publish_payload`** — the final, store-formatted JSON ready for the destination API. Always built; only POSTed when `--publish` is set.

**Run modes:**
- `--preview` (default) — write the full package to `agent_runs.metadata.preview_package`, write `decision_needed` row with the rendered package + diff vs current live listing if one exists. Human reviews, approves, then re-runs with `--publish`.
- `--publish` — POST to the store, capture the returned listing record, INSERT/UPDATE `listings`, write `listing.published` activity row, link assets to the new `listing_id`.

**Preview-first is the default.** Per principle #7 ("build, validate, automate"), the agent earns publish autonomy by accumulating clean previews the operator approves; once N consecutive previews are approved without edits for a given store + taxonomy combination, `--publish` becomes the default for that combination. (N TBD; suggest 5.)

---

## 6. Backfill prerequisite — `assets` table + manual linking CLI ✅ BUILT

> **Status:** Shipped. Migration `0007_assets.sql` is applied; all 4 asset producers (`generate-image.ts`, `upscale-image.ts`, `build-print-bundle.ts`, `resize-print-variants.ts`) auto-write into the registry via the shared `brain/src/lib/assets.ts` helper; `npm run link:asset` handles manual / pre-pipeline entries; both live listings backfilled (12 rows total, 0 missing-disk warnings). This section is preserved as the design spec — the implementation diverges slightly (see the **Implementation notes** at the bottom).

The image manifest in §5 needs an asset registry the agent can query. Today, generated/upscaled assets are written to `dist/gen/` and logged in `activity` as `image.generated` / `image.upscaled`, but there's no first-class table for "what assets exist, for what listing/brief, of what kind, at what resolution." That's a Listing Agent blocker.

### New table: `assets`

```sql
CREATE TABLE assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,           -- 'hero' | 'lifestyle' | 'whats_included' | 'size_grid' | 'detail' | 'video' | 'thumbnail' | 'master' | 'print_variant'
  listing_id      uuid REFERENCES listings(id) ON DELETE SET NULL,
  product_brief_id uuid REFERENCES product_briefs(id) ON DELETE SET NULL,
  local_path      text,                    -- filesystem path under brain/dist/gen/ or products/.../
  cdn_url         text,                    -- once uploaded to fal CDN, Etsy CDN, or other host
  dimensions      jsonb NOT NULL,          -- { width, height, dpi? }
  source          text NOT NULL,           -- 'fal.flux-pro' | 'fal.clarity' | 'puppeteer' | 'manual_upload' | 'etsy_cdn'
  fal_request_id  text,
  metadata        jsonb DEFAULT '{}',      -- prompt, seed, cost_usd, parent_asset_id (for upscales/variants), reference_image_ids, ...
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assets_listing_id_idx ON assets(listing_id);
CREATE INDEX assets_product_brief_id_idx ON assets(product_brief_id);
CREATE INDEX assets_kind_idx ON assets(kind);
```

Migration `0007_assets.sql` will create this. RLS off (server-write only, same posture as `agent_runs` / `product_briefs`).

### Gen + upscale tools UPSERT into `assets`

Both `src/tools/generate-image.ts` and `src/tools/upscale-image.ts` get an additional write to the `assets` table on success, in the same transaction-ish flow as the existing `activity` row. Existing `activity` rows stay (they're the chronological log); the new `assets` row is the queryable registry. CLI gains an optional `--brief-id=<uuid>` and `--kind=<...>` so generations done while iterating on a specific product land linked.

### Manual linking CLI: `npm run link:asset`

For assets generated outside the system (the bunny PNG and the planner PDF were both produced before the asset-registry concept existed and before the fal tools were wired). Spec:

```
npm run link:asset -- \
  --listing-id=<uuid>           # or --etsy-listing-id=<numeric>
  --kind=hero|lifestyle|...
  --path=brain/products/.../hero.png
  [--source=manual_upload]      # default
  [--dimensions=WxH]            # auto-detected via sharp if omitted
```

Idempotent: keyed on `(listing_id, kind, local_path)`. The two existing HillwardStudio listings need to be linked to their currently-live assets via this CLI before the Listing Agent ships, so the asset history is complete.

### Implementation notes (shipped)

- **Migration:** `supabase/migrations/0007_assets.sql`. Diverges from the spec on two columns: dimensions are stored as separate `width INTEGER` / `height INTEGER` columns instead of a `dimensions jsonb` object (cheaper to index/query for the common "find images at least 5008×6680" pattern), and `kind` / `source` use `TEXT` with `CHECK` constraints (favored flexibility over a Postgres enum so adding a new kind is a one-line ALTER instead of a typed-enum migration dance).
- **Shared helper:** `brain/src/lib/assets.ts` exports `insertAsset()` (soft-fail — prints `[ASSET_INSERT_FAILED]` and continues, so a registry insert failure never aborts a file that's already on disk), `findAssetByPath()` (used by `link:asset` for idempotency), and `ASSET_KINDS` / `ASSET_SOURCES` arrays plus TS union types that stay in sync with the migration's `CHECK` constraints.
- **Producer integration:** `generate-image.ts` defaults `kind='hero'` (override via `--kind`); `upscale-image.ts` defaults `kind='master'`; `build-print-bundle.ts` emits one row per deliverable (master / 5×print_variant / crop_marks_pdf / transparent / ratio_guide, all `source='build_bundle'`); `resize-print-variants.ts` emits one `print_variant` row per sized JPG (`source='resize_print'`). All four also accept `--product-brief-id` and `--listing-id` flags so the FK columns get populated at creation time.
- **`npm run link:asset`:** `brain/src/tools/link-asset.ts`. Supports both `--listing-id=<uuid>` and `--etsy-listing-id=<numeric>` (auto-resolves to the uuid via `listings.etsy_listing_id` lookup). Auto-reads `width`/`height` via sharp for raster images (PDFs and non-images leave dims null). Idempotent on `(kind, local_path)` — re-runs print `~ already linked` and exit 0 instead of inserting a duplicate. Writes an `activity` row with `action='asset.linked'` on every successful insert.
- **Backfill complete:** 12 rows total for the 2 live listings (11 for bunny `etsy_listing_id=4508704536`, 1 for planner `etsy_listing_id=4508059444`). See `brain/TODO.md` → Done → "Asset Registry" for the full per-kind breakdown.

---

## 7. Research Agent Tuning Pass 2 — prerequisites

The Listing Agent cannot work against the current brief shape — too many fields it needs are absent, and the ones present (`description_angles`, `etsy_attributes`) are advisory text rather than the structured contract the agent needs. Tuning Pass 2 of the Research Agent must ship the following schema changes to `ProductBrief` **before** the Listing Agent is built. These are contract changes — downstream agents must be updated in lockstep.

### `audience.persona` — first-class field

Currently buried in `audience.who` prose. Promote to a structured object:

```ts
audience: {
  persona: {
    name: string,                  // e.g. "The A5 binder minimalist"
    description: string,           // 1-paragraph profile
    pain_points: string[],
    motivations: string[],
    aesthetic_preferences: string[]
  },
  // ... existing audience fields stay
}
```

Drives description voice and attribute selection. The bunny and planner descriptions written today were written against an implicit persona; making it explicit means the Listing Agent can ask Opus "write a description in this persona's voice" with no ambiguity.

### `listing.description` — structured, not prose-angles

Replace the current `description_angles: string[]` (advisory, requires a human to assemble) with the actual structured description the Listing Agent will render:

```ts
listing: {
  description: {
    hook: string,                   // 130-160 chars, primary keyword inside
    body_sections: [{               // 2-5 sections
      heading: string,              // rendered as ALL CAPS on Etsy
      body: string                  // 1-3 paragraphs of prose
    }],
    faq: [{ q: string, a: string }],// 5-7 entries; first ones derived from customer-facing brief.risks, last from standard digital-download friction
    cta: string                     // 1-2 sentences + shop mention
  },
  // ... other listing fields below
}
```

The two descriptions for bunny + planner currently in the AI_HANDOFF (see §10) are the gold-standard shape — they should be reproducible by Opus given this schema and the rest of the brief.

### `listing.attribute_intent` — SEMANTIC descriptors only

This is the single biggest schema change of Tuning Pass 2 and the direct response to today's "Recipient doesn't exist on Digital Prints / Materials is constrained on planners" lesson. **The Research Agent must never enumerate raw store-specific attribute values.** Instead it emits semantic descriptors that the Listing Agent maps to each store's live `possible_values` per §4.

Replace `listing.etsy_attributes: { style: string[], ... }` with:

```ts
listing: {
  attribute_intent: {
    style_descriptors: string[],     // e.g. ["vintage", "cottagecore", "watercolor", "storybook"]
    audience_descriptors: string[],  // e.g. ["babies", "gender-neutral", "nursery", "new parents"]
    occasion_descriptors: string[],  // e.g. ["baby shower", "newborn gift", "nursery decor"]
    color_descriptors: string[],     // e.g. ["warm neutral", "sage green", "off-white", "soft beige"]
    materials_intent: string[]       // e.g. ["digital download", "printable", "watercolor illustration"] — Listing Agent decides whether the destination property is free-text or constrained
  }
}
```

These are inputs to §4's verification step. The Listing Agent runs each descriptor through the live store schema, semantic-substitutes where needed, and skips where no match exists.

**Why this matters:** today's bunny brief recommended `etsy_attributes.recipient = ["Babies","Children"]`. That recommendation cost edit time because Recipient doesn't exist on the Digital Prints taxonomy. The brief had no way to know that. Under the new schema, the brief emits `audience_descriptors = ["babies","children"]` and the Listing Agent does the lookup, finds Recipient absent, and skips the slot silently — zero wasted effort, zero wrong recommendations.

### `listing.image_spec` — explicit asset manifest

Currently the brief has `design.mood_keywords` and that's it for visual direction. The Listing Agent needs an explicit slot manifest:

```ts
listing: {
  image_spec: [{
    kind: 'hero' | 'lifestyle' | 'whats_included' | 'size_grid' | 'detail',
    purpose: string,                 // 1-sentence: what this image needs to communicate
    dims_recommended: { width: number, height: number, dpi?: number },
    style_notes: string              // 1-2 sentences anchoring tone, composition, references
  }]
}
```

Minimum recommended slots per listing (Etsy supports 10):
- 1 hero (square-crop primary)
- 1-2 lifestyle (product in a real room / on a real desk)
- 1 what's-included (annotated breakdown of file count, formats, page count)
- 1 size-grid (for wall art) OR 1 page-preview-grid (for planners)
- 1 lifestyle detail (close-up or zoomed-in styling shot)

The Listing Agent walks this manifest, checks the `assets` table for matches, and auto-triggers generation per §5 for the unfilled ones.

### `listing.shop_section_suggestion` — name string

Single string field. The agent matches against the shop's existing sections via the Etsy API (§3). If close fuzzy match → assign existing. If no match and the suggestion is well-formed → create. If ambiguous → leave blank.

```ts
listing: {
  shop_section_suggestion: string   // e.g. "Nursery Wall Art" or "Planner Inserts"
}
```

### `differentiation_thesis` — load-bearing product-gap axis (research-v3)

Tuning Pass 3 adds a top-level brief field that is a **design constraint on the asset**, not just listing copy. See `RESEARCH_AGENT.md` for the full dual-axis methodology (SEO-gap + product-gap).

```ts
differentiation_thesis: {
  competitor_offerings: Array<{ incumbent_id: string; product_features: ProductFeatures }>,
  buyer_pain_signals: Array<{
    theme: string,
    frequency_indicator: string,
    paraphrased_examples: string[]  // NEVER verbatim Etsy review text
  }>,
  our_differentiation: string,  // specific + grounded; honest if unsupported
  positioning: string,
  one_line_claim: string
}
```

**Copyright rule:** Buyer pain signals are synthesized from Etsy reviews via Haiku paraphrase only. The brief and operator markdown must never contain direct review quotes.

**Downstream contract:** When `differentiation_thesis` is present, these fields must reflect it — a generic `description.why_this_one` or `image_spec` that ignores the thesis is a bug:

- `listing.description.hook` / `why_this_one` → articulate `our_differentiation`
- `listing.image_spec[]` → visual proof of `positioning`
- `listing.attribute_intent` → descriptors reinforce positioning
- `product.design.required_elements` / `product.format.includes` → deliver the differentiated product

The Listing Agent should treat `one_line_claim` as the hook anchor and verify image slots communicate the positioning before declaring the package ready.

---

## 8. Multi-store architecture

### Shape

```
src/agents/listing/
  index.ts            -- ListingAgent.run({ briefId, store, mode })
  package.ts          -- buildListingPackage(brief, schema, assets, niche_memory) → ListingPackage
  description.ts      -- renderDescription(brief, store) — calls Opus + per-store text formatter
  tags.ts             -- validateAndDedupeTags(brief, store)
  attributes.ts       -- §4 verification + semantic substitution
  images.ts           -- image_spec → assets lookup → auto-trigger generation
  adapters/
    etsy.ts           -- EtsyAdapter: auth, schema fetch + cache, taxonomy mapping, publish POST
    pinterest.ts      -- (deferred)
    shopify.ts        -- (deferred)
  types.ts            -- ListingPackage, AdapterContract
```

### Adapter contract (each store implements)

```ts
interface ListingAdapter {
  store: 'etsy' | 'pinterest' | 'shopify';
  fetchTaxonomy(): Promise<TaxonomyTree>;
  fetchPropertiesForTaxonomy(id: string): Promise<PropertyDef[]>;
  fetchShopSections?(): Promise<ShopSection[]>;
  fetchShippingProfiles?(): Promise<ShippingProfile[]>;

  rules: {
    title_max_chars: number;
    tag_count_exact?: number;       // Etsy: 13
    tag_count_max?: number;
    tag_max_chars: number;
    description_min_chars: number;
    description_max_chars: number;
    description_format: 'plaintext' | 'markdown' | 'html';
    images_max: number;
    video_supported: boolean;
  };

  mapAttribute(intent: AttributeIntent, schema: PropertyDef): AttributeValue | null;  // §4 logic
  renderDescription(structured: StructuredDescription): string;                       // per-store formatter
  buildPublishPayload(pkg: ListingPackage): unknown;
  publish(payload: unknown): Promise<{ external_id: string; url: string; raw: unknown }>;
}
```

### Build order

1. **EtsyAdapter** — the only store that matters today. Both live listings are Etsy. The asymmetric value is here.
2. **PinterestAdapter** — both research briefs flag Pinterest as the highest-leverage external traffic source for HillwardStudio (nursery + planner both index well on Pinterest organic). Implementing this adapter unlocks the "auto-create 5-10 SEO pins per listing" play from the AI_HANDOFF §10 next-priorities. Adapter scope is small: Pin = image + title + description + destination URL + board assignment. No taxonomy, no attributes, no shop sections.
3. **ShopifyAdapter** — deferred until HillwardStudio outgrows Etsy or expands to a standalone storefront. Not on the validation path to first $1k/mo.

---

## 9. Logging

The agent uses the existing `agent_runs` / `activity` discipline (PRINCIPLES principle #5, #8).

### `agent_runs`

One row per `(brief_id, store, mode)` invocation. Captures:
- `agent` = `'listing'`
- `status` = `running | succeeded | failed`
- `cost_usd` (sum of Opus description draft + any image generation triggered + any image upscale triggered)
- `metadata` includes:
  - `preview_package` (mode=preview) or `published_listing_id` (mode=publish)
  - `attribute_substitutions[]` — every §4 substitution made, with `{ slot, proposed, substituted, reason, taxonomy_id }`
  - `attributes_skipped[]` — every property left blank, with reason
  - `assets_generated[]` — any auto-triggered fal calls, with cost + dims + asset_id
  - `cache_hits` / `cache_misses` for the store schema fetches

### `activity`

One row per discrete artifact produced or decision made:

| `action` | When written |
|---|---|
| `description.drafted` | Opus completes the description body |
| `tags.validated` | Tag set passes adapter rules |
| `attributes.filled` | §4 pass completes (also writes `attribute.skipped_*` rows individually) |
| `image.assigned` | Asset matched from registry to manifest slot |
| `image.requested` | Asset missing from registry, fal generation triggered (paired with the existing `image.generated` row from the gen tool) |
| `shop_section.assigned` / `shop_section.created` / `shop_section.skipped` | Shop-section resolution outcome |
| `taxonomy.resolved` / `taxonomy.fallback_to_parent` / `taxonomy.unresolvable` | Taxonomy mapping outcome |
| `listing.preview_ready` (preview mode) | Final package ready, decision_needed row written |
| `listing.published` (publish mode) | Store API returned a listing_id |

All rows carry `agent='listing'`, the `brief_id`, the `store`, and the `run_id` linking back to `agent_runs`.

---

## 10. Today's worked examples (gold standard)

The agent must be able to reproduce or improve on the manual work done on 2026-05-21 for these two listings. They are the empirical floor; any agent run that produces a noticeably weaker package than these for an equivalent brief is a regression.

### A5 Monthly Calendar Printable

- **Etsy listing ID:** `4508059444`
- **Brief ID:** `0834bacd-0727-4487-9ef3-ccd0a1c4f34c`
- **Opportunity ID:** `c3fa0a4d…` (planneraddicts Reddit buyer)
- **Live state @ first snapshot:** $3.49, 13 tags, `active`, 6 views / 0 favorers
- **Key manual learnings captured here:**
  - "Materials" property on the planner taxonomy is constrained-vocabulary — free-text values like `"Digital Download"` / `"PDF"` were rejected.
  - The Research Agent's `etsy_attributes` recommendations had to be filtered against the live property schema; several were dropped.
- **Gold-standard description:** the planner description in `brain/AI_HANDOFF.md` (Listing 2 in the description-generation chat earlier today). The Tuning Pass 2 schema must produce this shape.

### Vintage Bunny Nursery Wall Art

- **Etsy listing ID:** `4508704536`
- **Brief ID:** `ea836ab6-0938-40cf-8523-0694774c12c5`
- **Opportunity ID:** `d7750211…` (nursery wall art printable)
- **Live state @ first snapshot:** $4.49, 12 tags, `active`, 4 views / 0 favorers
- **Key manual learnings captured here:**
  - "Recipient" property does **not** exist on the Digital Prints taxonomy node this listing landed under. The Research Agent had recommended `recipient = ["Babies","Children"]`; the slot wasn't there to fill.
  - IP-protection language ("no Peter Rabbit, no Winnie the Pooh") had to be added to FAQ to address the brief's `risks[3]` — not present in the original `description_angles`.
  - "Hand-painted" claims from the brief had to be softened to "watercolor sketch" to avoid conflicting with Etsy's AI-disclosure flag, since the asset was fal-generated.
- **Gold-standard description:** the bunny description in `brain/AI_HANDOFF.md` (Listing 1). The Tuning Pass 2 schema must produce this shape, including the IP-protection FAQ entry and the responsible provenance language.

### Why both matter

Two listings, two different taxonomies, two different schema-shape lessons in the same day. The pattern is: **the Etsy attribute schema is a runtime fact, not a design-time fact.** Any spec that tries to encode it statically — including the Research Agent's `etsy_attributes` field today — will be wrong some non-trivial fraction of the time. §3 + §4 are the system's response to that reality. §7's `attribute_intent` schema is how the Research Agent stays useful without trying to predict the unpredictable.

---

## Open questions / TBD

- Threshold for "confident enough" to auto-create a new shop section vs. leave blank. Suggest 0.7 (matches research-confidence convention).
- Threshold for "N consecutive clean previews → publish becomes default" per store + taxonomy. Suggest 5.
- Whether the semantic-substitution step in §4 uses embedding distance (cheap, deterministic) or LLM classification (richer, costs ~$0.001/call). Defer until first implementation; lean embedding for cost predictability.
- Whether to model the Pinterest pin set as a separate "listing" record or as N child rows of the parent Etsy listing. Defer until PinterestAdapter is in scope.
- Whether the asset registry should also cover videos. Etsy supports listing videos and HillwardStudio listings could meaningfully benefit; out of scope for v1 but the table schema in §6 includes `kind='video'` so adding it later is non-breaking.
