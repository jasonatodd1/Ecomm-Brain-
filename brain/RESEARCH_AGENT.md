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

## 3. Reviews mining (PART A)

**Endpoint:** `GET /v3/application/listings/{listing_id}/reviews`  
**Auth:** Same `x-api-key: ${KEYSTRING}:${SHARED_SECRET}` as other public endpoints. Verified accessible without user OAuth scope (May 2026).

**Concurrency:** `mapWithLimit(2, 200ms)` — same posture as listing/shop fetches.  
**429 handling:** Logged, non-blocking; partial sample returned. Retry-After backoff remains backlog (`TODO.md`).

**Caps:** ~50 most recent reviews per incumbent (~150 total max across top 3).

**Signal filter:** 3-star-and-below OR text matching wishlist/complaint patterns (`wish it had`, `would love`, `missing`, `needed`, `if only`, `should have`, `lacks`, `wanted`, etc.).

**Copyright rule:** Verbatim review text is stored in `raw_research` signal metadata for audit only. The published brief and markdown **never** contain direct quotes. Haiku paraphrases recurring themes into `buyer_pain_signals.paraphrased_examples`.

**Graceful degradation:** Zero reviews → note in `reviews_mined`, skip signal extraction for that incumbent. Few reviews (<5) → flagged as insufficient in stats.

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

Top-level brief field (research-v3):

```ts
interface DifferentiationThesis {
  competitor_offerings: Array<{
    incumbent_id: string;
    product_features: ProductFeatures;
  }>;
  buyer_pain_signals: Array<{
    theme: string;
    frequency_indicator: string;
    paraphrased_examples: string[];  // NEVER verbatim Etsy review text
  }>;
  our_differentiation: string;  // specific + grounded; honest if unsupported
  positioning: string;
  one_line_claim: string;       // hook/title-ready sentence
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

## 7. Cost model (typical v3 run)

| Step | Model / API | Est. cost |
|---|---|---|
| Keyword extraction | Opus | ~$0.05 |
| Etsy search + listing fetches | Etsy Open API | $0 |
| Review fetches (≤6 calls) | Etsy Open API | $0 |
| Product features (×3) | Haiku | ~$0.012 |
| Pain signal paraphrase | Haiku | ~$0.006 |
| Brief synthesis | Opus | ~$0.30 |
| **Total** | | **~$0.37** |

---

## 8. CLI

```bash
npm run seed:meal-planner    # seed Trends anchor decision (idempotent)
npm run research -- --decision-id=<uuid>
npm run research:meal-planner  # after seeding
```

Implementation: `src/agents/research/index.ts`, `incumbent-intel.ts`, `competitive.ts`, `prompts.ts`.
