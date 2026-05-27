# Research Agent — Dual-Axis Methodology

> Durable spec for the Research Agent's market analysis. The agent produces structured `ProductBrief` rows consumed literally by Design, Listing, and Asset pipelines.
>
> **Schema version:** `research-v3` (May 2026). Prior versions: `research-v1` (base brief), `research-v2` (Tuning Pass 2 — structured listing, SEO landscape).

---

## 1. Two axes, one brief

| Axis | Question | Engine | Output field |
|---|---|---|---|
| **SEO-gap** (supply quality) | Can we rank against incumbents? | `scoreEtsyListingSeo` + `computeCompetitiveLandscape` | `listing.competitive_landscape` |
| **Product-gap** (differentiation) | What do incumbents ship vs what buyers wish they shipped? | Review mining + Haiku product feature extraction | `differentiation_thesis` |

Both axes feed synthesis. **Only the product-gap axis is load-bearing on asset design** — `differentiation_thesis` constrains `product.design.required_elements`, `product.format.includes`, `listing.image_spec`, and `listing.description.hook` / `why_this_one`.

See also: `COMPETITIVE_SEO_SCORING.md` (SEO-gap), `LISTING_AGENT_REQUIREMENTS.md` §7 (downstream contract).

---

## 2. Pipeline (research-v3)

1. Claim `decisions_needed` row (atomic).
2. Opus keyword extraction (4–6 Etsy search terms).
3. Etsy search per keyword (`searchEtsy`, 25 results each).
4. Market aggregates (`computeAggregates`).
5. Competitive SEO landscape (`computeCompetitiveLandscape`, top 10 scored, top 3 incumbents per keyword).
6. **Incumbent intel** (`runIncumbentIntel`, step 6.7):
   - Top 3 incumbents from primary keyword landscape entry (or highest-engagement keyword).
   - Fetch up to 50 recent reviews per incumbent via `GET /v3/application/listings/{listing_id}/reviews` (x-api-key only — no user OAuth).
   - Filter buyer-voice signals: rating ≤3 OR wishlist/complaint regex.
   - Haiku: structured `product_features` per incumbent from cached listing details.
   - Haiku: paraphrase recurring pain themes → `buyer_pain_signals` (no verbatim review text in brief).
7. Opus synthesis → full `ProductBrief` including `differentiation_thesis` + load-bearing downstream fields.
8. Persist to `product_briefs`, render markdown, write niche memory gaps.

---

## 3. Reviews mining + relevance filter (PART A + research-v3.1)

**Endpoint:** `GET /v3/application/listings/{listing_id}/reviews`  
**Auth:** Same `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` as other public endpoints. Verified accessible without user OAuth scope (May 2026).

**Concurrency:** `mapWithLimit(2, 200ms)` — same posture as listing/shop fetches.  
**429 handling:** Logged, non-blocking; partial sample returned. Retry-After backoff remains backlog (`TODO.md`).

**Caps:** ~50 most recent reviews per relevance-confirmed incumbent.

### Dual incumbent selection (research-v3.1)

Two lenses, separately selected, separately reported:

| Lens | Selection | Lives in | Why |
|---|---|---|---|
| **SEO-gap** | Top-N by `num_favorers` per keyword (unfiltered) | `competitive.ts` → `listing.competitive_landscape` | The question "what's actually ranking and how strong is its SEO" — an off-niche listing dominating the SERP IS a legitimate SEO observation. |
| **Product-gap** | Haiku-classified same-niche subset of combined-keyword candidate pool | `incumbent-intel.ts` → `differentiation_thesis.competitor_offerings` + `relevance_filter` | The question "what do *same-niche* competitors ship vs what buyers wish" — requires strict niche match or product features and buyer pain themes get poisoned by off-niche noise. |

### Relevance classifier

Haiku classifier (`claude-haiku-4-5-20251001`, ~$0.0005/call) takes:
- Niche definition (primary keyword + decision title/description)
- Listing context (title, tags from cache when available, 600-char description preview)

Prompt names INCLUDE patterns (sub-audience or variant of same product type) and EXCLUDE patterns (shares keywords but different category) so it generalizes to unseen niches. Output: `{ relevant: bool, reason: string }`.

### Pool & expansion

| Stop | Pool size | Action |
|---|---|---|
| 1 | top-20 by favorers across all keywords | classify in parallel (concurrency 4) |
| 2 | top-30 | expand if `<3` kept after stop 1 |
| 3 | top-40 (`MAX_CANDIDATE_POOL_SIZE`) | final expansion; flag `pool_exhausted=true` if still `<3` |

Combined-keyword pooling matters: it pulls heavyweights like MyLifePlans (6k+ favorers) to the top of the candidate list even when they don't dominate the primary keyword's SERP.

### Edge cases

- `<3` relevant after `maxPoolSize` → proceed with what we have; `pool_exhausted=true`; brief flags low product-gap confidence.
- 0 relevant → product-gap stage returns empty; brief states "SERP too off-niche — relying on SEO-gap axis only."
- Relevant incumbents have thin reviews → `data_thinness` set to `low` (≤9 signal reviews), `medium` (10–29), or `high` (≥30).
- Synthesis prompt requires `our_differentiation` to lead with `(buyer-voice-backed:` or `(incumbent-inferred:` so grounding is never hidden.

### Filter behavior validated (meal planner v4, 2026-05-27)

- Pool: 40 candidates from combined-keyword search results.
- Classified: 20 (target hit before reaching stop 3).
- Kept 3: `1386590527` MyLifePlans (40 reviews fetched), `1292678192` PlansByChloe (19), `1572689473` MarrMarStudio (16) — all confirmed same-niche.
- Dropped 12 examples: fitness planner with ancillary meal module, recipe cost calculator, FODMAP food chart, planner stickers, home management binder, life planner spreadsheet — all off-niche despite keyword overlap.
- Signal reviews: 12 (vs v3's 3 on unfiltered selection).
- Data thinness: `medium`.

**Signal filter:** 3-star-and-below OR text matching wishlist/complaint patterns.

**Copyright rule:** Verbatim review text in `raw_research` for audit only. Brief uses Haiku-paraphrased themes in `buyer_pain_signals.paraphrased_examples`.

---

## 4. Product feature extraction (PART B)

For each top-3 incumbent, Haiku extracts from already-fetched listing data (title, description, tags, price, photo count when available):

```ts
interface ProductFeatures {
  sections: string[];           // e.g. weekly grid, grocery list, snack section
  sizes: string[];              // US Letter / A4 / A5 / etc.
  formats: string[];            // PDF / JPG / editable Canva / etc.
  style_angle: string;        // minimalist / boho / vintage / etc.
  bundle_composition: string;   // single sheet vs multi-page bundle
  price_point: string;
  distinguishing_features: string[];
}
```

---

## 5. differentiation_thesis schema (PART C)

Top-level brief field (research-v3 / v3.1):

```ts
interface DifferentiationThesis {
  competitor_offerings: Array<{
    incumbent_id: string;
    product_features: ProductFeatures;
    relevance_reason?: string;  // v3.1 — why classifier kept this incumbent
  }>;
  buyer_pain_signals: Array<{
    theme: string;
    frequency_indicator: string;
    paraphrased_examples: string[];  // NEVER verbatim Etsy review text
  }>;
  our_differentiation: string;  // v3.1 prefix-tagged "(buyer-voice-backed:" or "(incumbent-inferred:"
  positioning: string;
  one_line_claim: string;
  relevance_filter?: RelevanceFilterReport;  // v3.1 — operator-facing filter audit
}

interface RelevanceFilterReport {
  candidate_pool_size: number;
  classified_count: number;
  kept_count: number;
  dropped_count: number;
  pool_exhausted: boolean;
  data_thinness: 'high' | 'medium' | 'low';
  classifications: Array<{ listing_id, title, num_favorers, relevant, reason }>;
}
```

---

## 6. Load-bearing alignment (PART D)

Synthesis prompt requires explicit thesis → downstream wiring:

| Downstream field | Must reflect thesis |
|---|---|
| `listing.description.hook` | `one_line_claim` + primary keyword |
| `listing.description.why_this_one` | `our_differentiation` specifically |
| `listing.differentiation_angle` | Aligned with `one_line_claim` |
| `listing.image_spec[]` | Visual proof of `positioning` |
| `listing.attribute_intent` | Descriptors reinforce positioning |
| `product.design.required_elements` | Concrete features delivering differentiation |
| `product.format.includes` | Bundle composition implied by thesis |

Post-synthesis: `warnThesisMisalignment()` logs when `why_this_one` token overlap with thesis is <15% (warn-only).

---

## 7. Cost model (typical v3.1 run)

| Step | Model / API | Est. cost |
|---|---|---|
| Keyword extraction | Opus | ~$0.05 |
| Etsy search + listing fetches | Etsy Open API | $0 |
| Relevance classifier (×20–40) | Haiku | ~$0.01–$0.02 |
| Review fetches (×3) | Etsy Open API | $0 |
| Product features (×3) | Haiku | ~$0.012 |
| Pain signal paraphrase | Haiku | ~$0.006 |
| Brief synthesis | Opus | ~$0.30 |
| **Total** | | **~$0.38** |

---

## 8. CLI

```bash
npm run seed:meal-planner    # seed Trends anchor decision (idempotent)
npm run research -- --decision-id=<uuid>
npm run research:meal-planner  # after seeding
```

Implementation: `src/agents/research/index.ts`, `incumbent-intel.ts`, `competitive.ts`, `prompts.ts`.
