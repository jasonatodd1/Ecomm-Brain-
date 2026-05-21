# Competitive SEO Scoring

> Durable spec. Captures the strategic insight that surfaced while reviewing the first two HillwardStudio listings on 2026-05-21: the brain's actual edge is **supply-side gap analysis layered on top of demand-side signals.** Demand-only scoring puts us into red-ocean keyword fights against entrenched sellers with thousands of reviews. The real opening is keywords where demand exists AND the top-ranked incumbents have weak SEO — those are the niches we can credibly take.
>
> Living document. Update when scoring rules calibrate against real outcome data, when new dimensions of "good Etsy SEO" become measurable, or when a new store (Pinterest, Shopify) introduces its own SEO surface.

---

## 1. Purpose

The brain currently scores opportunities on **demand signals** — Google Trends interest/velocity (`collect-trends.ts`) and Reddit buyer-intent posts (`collect-reddit.ts`). Both answer "is anyone asking for this?" Neither answers "can we plausibly rank for it?" That second question is the one that determines whether a brief turns into a listing that gets seen.

The strategic edge this doc formalizes: **demand × (1 / supply quality)** is a better north-star than demand alone. A keyword with strong search volume AND top-10 listings averaging 60/100 on SEO fundamentals is a real opening for a new-shop zero-review entrant. A keyword with strong volume AND top-10 listings averaging 90/100 is a fight we lose by default.

Competitive SEO Scoring is the system that:
1. Measures any Etsy listing against a deterministic scoring rubric (§3).
2. Lets the **Research Agent** detect weak-incumbent keywords during market analysis and surface them as differentiated opportunities (§4).
3. Lets the **Listing Agent** quality-gate its own drafts against the same rubric before publishing (§5).

One scoring engine, two consumers — Research as the gap-detector, Listing as the pre-publish gate. The same rubric scoring incumbents in §4 is the rubric our own drafts have to beat in §5. That symmetry is the point.

---

## 2. Shared scoring engine

New library: **`brain/src/lib/etsy-seo-scoring.ts`** (interface only in this doc; implementation lands during Tuning Pass 2 or as its own milestone before the Listing Agent — see §6).

Both `src/agents/research/` and (future) `src/agents/listing/` import from this lib. Single source of truth for "what good Etsy SEO looks like." If a rule changes, it changes once and both agents pick it up.

### Public interface

```ts
// brain/src/lib/etsy-seo-scoring.ts

export interface SeoScoreBreakdownEntry {
  score: number;             // points earned for this rule
  max: number;               // max possible for this rule
  note: string;              // human-readable explanation: "Title 87 chars (target 100-140)"
}

export interface SeoScore {
  total: number;                                              // sum of dimension scores
  max: number;                                                // sum of dimension maxes
  percent: number;                                            // total / max (convenience field)
  weak_areas: string[];                                       // rule keys where score < max
  detailed_breakdown: Record<string, SeoScoreBreakdownEntry>; // keyed by rule name (see §3)
}

export interface EtsyListingRaw {
  // The shape returned by getListing() in src/lib/etsy-search.ts — the same struct
  // stored in listings_stats.raw. Concretely: title, description, tags[], state,
  // taxonomy_id, attributes[], materials[], shop_section_id, num_favorers, views,
  // created_timestamp, last_modified_timestamp, ...
  // Typed in src/lib/etsy-search.ts; re-exported here for ergonomics.
}

export interface ScoringContext {
  primary_keyword?: string;  // the keyword we care about ranking for — drives title/description checks
  niche_tag?: string;        // for future niche-specific weighting (e.g. planner tags differ from wall-art tags)
}

export function scoreEtsyListingSeo(
  listing: EtsyListingRaw,
  context: ScoringContext
): SeoScore;
```

### Design constraints

- **Pure function.** No DB writes, no network calls. Takes a listing struct + context, returns a score. Trivially unit-testable; the same input always produces the same output. Calling code (Research Agent, Listing Agent, future analytics) owns persistence.
- **Stateless re: store APIs.** All rules are evaluable against the data already in the listing struct + the context. Rules that *would* require a fresh API call (e.g. live attribute schema) belong in the Listing Agent's §4 verification flow in `LISTING_AGENT_REQUIREMENTS.md`, not here. The scoring engine asks "given what this listing currently says, how does it score?" — not "given what this listing *could* say if we re-fetched its taxonomy properties." That separation keeps the scorer cheap to call in bulk (10 listings per research keyword × N keywords per brief).
- **Deterministic, no LLM.** Every rule is mechanical (length, presence, regex, count). Bringing an LLM into scoring would re-introduce the same arithmetic-unreliability problem that pushed `aggregates.ts` to compute medians in code rather than asking the LLM. Same principle, applied to SEO scoring.
- **Versioned.** Once the rubric calibrates against outcome data, changing a weight changes every historical comparison. The engine returns `version` in `detailed_breakdown` (or as a top-level field — TBD at implementation) so stored scores can be re-evaluated when the rubric evolves.

---

## 3. Scoring rules (v1)

Starting weights are placeholders — every rule gets equal weight in v1, recalibrated from `listings_stats` outcome data once we have a few weeks of snapshots from real listings (ours + competitors we monitor). Total max for v1 = 100 points (10 rules × 10 points each).

| Rule key | What it measures | v1 scoring |
|---|---|---|
| `title_length` | Length of title in chars. Etsy max is 140; the practical sweet spot per top-seller analysis is 100–140. | 10 if 100–140; 7 if 80–99 or exactly 141–155 (over-cap or short); 4 if 50–79; 0 if <50. |
| `title_keyword_placement` | Where `context.primary_keyword` (or its longest substring) appears in the title. Etsy weights left-positioned keywords more heavily. | 10 if keyword starts the title (first 30 chars); 7 if anywhere else in title; 0 if absent. Skipped (rule not counted toward max) if `primary_keyword` not provided. |
| `tag_count` | Etsy allows exactly 13 tags; leaving slots empty wastes free signal. | 10 if 13; 7 if 11–12; 4 if 8–10; 0 if <8. |
| `tag_quality` | Per-tag length ≤20 chars (Etsy hard limit), no near-duplicates of title words (Etsy treats title + tags as one keyword pool — duplicating wastes slots), no obviously banned/spammy terms. | 10 if all 13 pass all checks; –1 per failing tag, floor 0. |
| `description_length` | Total description char count. Longer-form correlates with deeper buyer engagement AND gives the algorithm more text to index. | 10 if ≥2,000; 7 if 1,500–1,999; 4 if 1,000–1,499; 0 if <1,000. |
| `description_keyword_in_preview` | Whether `context.primary_keyword` (or longest substring match) appears in the first 160 chars of the description — the snippet Etsy renders in search results. | 10 if present in first 160 chars; 5 if elsewhere in description; 0 if absent. Skipped if `primary_keyword` not provided. |
| `description_scannable_structure` | Heuristic: ALL-CAPS section headers (≥2), bullet markers (≥3 lines starting with `-` or `•`), and FAQ markers (≥2 lines matching `/^Q\./` or `/^Q:/`). Buyers scan; structured descriptions correlate with longer dwell-time. | 10 if all 3 markers present; 7 if 2 of 3; 4 if 1 of 3; 0 if none. |
| `attribute_fill_rate` | Fraction of attribute slots filled. Needs the live taxonomy properties to know what `total` is — the engine accepts an optional `applicable_attribute_count` in `context` (passed in by the caller after fetching the property schema via `LISTING_AGENT_REQUIREMENTS.md` §3). If absent, the rule is skipped. | 10 if ≥80% filled; 7 if 60–79%; 4 if 40–59%; 0 if <40%. |
| `shop_section_assigned` | Whether `shop_section_id` is non-null. Shop sections improve cross-listing navigation AND Etsy uses them as a category signal. | 10 if assigned; 0 if not. |
| `ai_disclosure_compliance` | Heuristic: if the listing looks AI-generated (any image bears fal/Midjourney/SD signatures we can detect, OR description matches LLM-text fingerprints), the AI-disclosure flag must be set. | 10 if either (a) no AI signature detected, or (b) signature detected AND disclosure flag set; 0 if signature detected AND disclosure flag NOT set. Compliance, not aesthetic — this guards against Etsy penalties more than rewards good SEO. |

### Implementation notes for the eventual coder

- Many rules are "tier scoring" (10/7/4/0). Centralize as `scoreTier(value, [[≥thresh, points], …])` so the rule definitions stay readable.
- `tag_quality`'s "near-duplicate of title" check should normalize both sides (lowercase, strip punctuation, drop stopwords) before comparison — otherwise "wall art" in the title and "wall art" in a tag won't match.
- The scannable-structure regex tests are intentionally lenient. They reward presence of the *pattern*, not perfect adherence — chasing perfect would create false negatives on perfectly-good descriptions that happen to use 1 header instead of 2.
- `weak_areas` returns the rule keys where `score < max`, sorted descending by `max - score`. Callers can `weak_areas.slice(0, 3)` to surface the top-3 improvable dimensions.

---

## 4. Research Agent role — supply-side gap discovery

The Research Agent already does market analysis by searching Etsy for each extracted keyword and computing aggregates. Adding competitive SEO scoring is a natural extension of that flow — same data fetch, additional pass over the results.

### Flow change

```
existing: extract keywords → searchEtsy per keyword → computeAggregates → synthesize brief
new:      extract keywords → searchEtsy per keyword → computeAggregates → scoreCompetitorSeo → synthesize brief
                                                                          ↑ new step
```

Where `scoreCompetitorSeo` calls `scoreEtsyListingSeo()` for the top 10 results per keyword (already fetched, no extra API spend) and records the distribution.

### What lands in the brief

New structured field on `ProductBrief` (added during Tuning Pass 2 — see §6 build order):

```ts
brief.competitive_landscape: {
  per_keyword: [{
    keyword: string,
    top_results: [{
      listing_id: number,
      shop_name: string,
      title: string,
      seo_score: { total: number, max: number, percent: number, weak_areas: string[] },
      num_favorers: number,
      price_cents: number
    }],
    median_seo_percent: number,         // median score across the top 10
    weak_incumbents: number,            // count of top-10 results scoring < threshold (default 60%)
    opportunity_classification: 'red_ocean' | 'mixed' | 'weak_incumbents' | 'open_field'
    // red_ocean: median ≥80% AND weak_incumbents ≤2
    // mixed: median 60-79%
    // weak_incumbents: median <60% AND weak_incumbents ≥3
    // open_field: weak_incumbents ≥7  (the whole top-10 is weak — strong candidate for a new decision)
  }],
  summary: {
    keywords_red_ocean: number,
    keywords_weak_incumbents: number,
    keywords_open_field: number,
    primary_opportunity_keyword: string | null   // the keyword with the best opportunity_classification (weight: open_field > weak_incumbents > mixed > red_ocean)
  }
}
```

### Threshold for "weak incumbent"

V1 default: a single result scores "weak" if its `percent < 60%`. A keyword is flagged as "weak incumbents" if ≥3 of its top 10 are weak. These are starting numbers — §7 commits to recalibrating once we have outcome data.

### How synthesis uses it

The synthesis prompt (`src/agents/research/prompts.ts`) gains a section explaining the competitive landscape and instructing the LLM to:
- **Cite weak-incumbent gaps in `brief.reasoning`** when the competitive landscape is favorable. E.g. "5 of the top 10 results for 'minimalist a5 inserts' average 48% SEO score — primary gaps: 3 have <8 tags, 4 have descriptions under 1,000 chars, 2 have no shop section assigned. This is an opening for a clean, full-spec listing."
- **Lower recommended confidence** when the landscape is red-ocean even if demand signals are strong. A 90/100 incumbent field is a meaningful headwind for a zero-review shop.
- **Suggest specific differentiation moves** keyed to the incumbents' weak areas. If top results are missing FAQs, the brief should call out FAQ inclusion as a competitive lever. If they're under-titled, the brief should push to use the full 140 chars.

This is where competitive scoring closes the loop with the existing differentiation-angle synthesis — it provides empirical evidence for *which* angles are actually free for the taking.

### Optional: surface entirely new opportunities

Keywords classified as `open_field` (≥7 of top 10 score weak) are stronger signals than any individual Google Trends or Reddit row — they directly indicate "demand exists AND nobody is serving it well." When the Research Agent encounters one in the course of analyzing a brief, it should:

- Insert a `signals` row of new type `etsy_seo_gap` with the keyword + score distribution as metadata.
- Optionally promote it to a `decisions_needed` row if the demand-side signals (search volume, listing count, median favorers) also clear thresholds — i.e. it's not just an empty niche but a *neglected* one.

The `etsy_seo_gap` signal type ships when the Listing Agent ships (per §6 build order), not earlier — there's no point surfacing gaps the system can't credibly act on.

---

## 5. Listing Agent role — pre-publish quality gate

The Listing Agent's job is to produce a publish-ready package (per `LISTING_AGENT_REQUIREMENTS.md`). Competitive SEO scoring gives it a deterministic answer to "is this draft actually competitive?"

### Pre-publish gate

After the Listing Agent assembles a `ListingPackage` (title, description, tags, attributes, shop section, etc.), it scores its own draft via the same `scoreEtsyListingSeo()` function. Decision tree:

1. **Draft scores ≥ ceiling-of-incumbents.** Approve for publish (or for operator preview, in `--preview` mode).
2. **Draft scores within 10 points of ceiling-of-incumbents but has gaps the agent can fix automatically.** Re-iterate: ask Opus to revise the specific weak areas (e.g. lengthen description, add FAQ entries, add ALL-CAPS section header). Re-score. Up to 2 retry passes; record both attempts in `agent_runs.metadata.draft_iterations[]`.
3. **Draft cannot be made competitive after retries.** Block publish, write a `decision_needed` row with the score breakdown and the gap analysis, escalate to the operator. This is the "agent knows when to ask for help" branch — much better than publishing a draft that loses by default.

The "ceiling-of-incumbents" target is the **median score of the top 5 listings** for the brief's primary keyword as captured in `brief.competitive_landscape`. The Listing Agent doesn't need to refetch — it reads what Research already produced. (If `competitive_landscape` is absent, e.g. brief predates Tuning Pass 2, the agent falls back to a flat 75% target.)

### Post-publish drift monitoring

`monitor-listings.ts` already snapshots live state daily. Adding `scoreEtsyListingSeo()` to that flow gives a per-listing time series of SEO health. New columns or a new `listings_seo_scores` table (TBD at implementation):

```sql
ALTER TABLE listings_stats ADD COLUMN seo_score_total int;
ALTER TABLE listings_stats ADD COLUMN seo_score_max int;
ALTER TABLE listings_stats ADD COLUMN seo_score_breakdown jsonb;
```

Then a daily check: any listing whose score has dropped >10 points week-over-week (e.g. tags edited down, description truncated, attribute slots lost) gets a `decisions_needed` row flagged "listing.seo_drift_detected." That's how we catch our own listings drifting weak before traffic shows it.

---

## 6. Build order

The competitive scoring engine sequences with the Tuning Pass 2 work that `LISTING_AGENT_REQUIREMENTS.md` §7 enumerates. Concrete order:

1. **Tuning Pass 2 — schema first (NOW).** Add `brief.competitive_landscape` to the `ProductBrief` schema with a *placeholder* shape: record top-3 incumbents per keyword (title, listing_id, num_favorers) but skip the SEO scoring fields. This unblocks the rest of Tuning Pass 2 (audience.persona, listing.description structuring, etc. — already enumerated in the Listing Agent spec §7) without waiting on the scorer. The synthesis prompt at this stage can still reason about incumbents qualitatively.
2. **Implement `scoreEtsyListingSeo()`.** Either as the final step of Tuning Pass 2 or as its own milestone before the Listing Agent — both work. Backfill `competitive_landscape.per_keyword[].top_results[].seo_score` and `median_seo_percent` and `opportunity_classification` retroactively for the next research run (existing briefs stay as-is; new briefs get the richer field).
3. **Wire competitive scoring into research synthesis.** Update the synthesis prompt (`prompts.ts`) to consume the new fields and surface weak-incumbent gaps in `brief.reasoning`. Expected effect: briefs for keywords with weak top-10 incumbents become noticeably more confident and more specific in their differentiation calls.
4. **Score post-publish snapshots in `monitor-listings.ts`.** Once the scorer exists, the marginal cost of running it on every snapshot is ~zero (pure function over data we already have). Adds the §5 drift-monitoring capability for free.
5. **Listing Agent imports the scorer for pre-publish gating** (per §5). This is the step where competitive scoring closes the loop end-to-end: Research finds the gap → Listing publishes against it → Listing self-checks it actually beat the incumbents → Monitor watches for drift.
6. **Add `etsy_seo_gap` as a new signal type.** Only after the Listing Agent ships. Before that, "we discovered a weak-incumbent niche" is information the system can't act on autonomously — surfacing it earlier just creates a backlog of unactioned `decisions_needed` rows.

---

## 7. Open questions to revisit when we have data

These are deliberately deferred — calibrating them on speculation is worse than calibrating them on a few weeks of real listings_stats data.

- **Right weight on each scoring dimension.** Starting equal in v1. Once we have outcome data (views, favorers, conversion) tied to score breakdowns for both our listings and snapshotted competitor listings, regress weights against outcomes. Expectation: title-keyword-placement and tag_count will turn out to weigh more than e.g. ai_disclosure_compliance. Don't pre-commit; calibrate.
- **Threshold for "weak."** Starting at 60% in v1. The right number is the percentile that empirically separates listings that get organic traffic from listings that don't, in the categories we care about. Will likely vary by category (planner-category competition profile is different from wall-art-category).
- **Whether to detect SEO weakness via Etsy's own visibility signals.** Direct rule scoring (this doc) measures what the listing *says*. Indirect signals — low views relative to listing age, low favorer:view ratio, languishing in search results despite full tags — measure what the listing *achieves*. Both have value: direct scoring works at scale (we can score 100 competitor listings cheaply), indirect scoring is harder to game and works on listings even when the visible attributes look good. v2 candidate: a second scoring function `inferEtsyListingVisibility(listing, snapshots)` that uses the time-series data we'll already be accumulating in `listings_stats` for our own listings (and that we'd need separate scraping/monitoring to get for competitors — moves the discovery work outside the Etsy v3 API).
- **Whether to score Pinterest, Shopify on the same engine.** The principle ports; the rules don't (Pinterest has no tags-as-Etsy-knows-them, Shopify has no shop sections in the Etsy sense). The Listing Agent's `LISTING_AGENT_REQUIREMENTS.md` §8 already commits to per-store adapters; per-store scorers (`scorePinterestPinSeo`, `scoreShopifyProductSeo`) following the same `Score → { total, max, weak_areas, detailed_breakdown }` contract are the natural extension.
- **Whether `scoreEtsyListingSeo()` should accept a custom rubric.** Today the rules are hardcoded; later we may want category-specific or shop-specific overrides ("this shop's planner listings should weight tags higher than its wall-art listings"). Defer until there's evidence we actually need it; meanwhile keep the rubric global so improvements compound across the whole system.
