# Niche bake-off

Compares **10 niches** (~2–8 buyer-phrase keywords each, 28 total) using the same white-space triangulation as production (`gap engine` + `whitespace-scoring.ts`). Does **not** write to `opportunities` or `signals` — results live in `niche_bakeoff_runs` / `niche_bakeoff_results`.

## Run types

| Run | Label pattern | Demand sources |
|-----|---------------|----------------|
| **v3 phrase-fix** (current) | `bakeoff-v3-phrasefix-<timestamp>` | Google Trends on **HEAD term** + Etsy competition on **specific phrase** (decoupled granularity) |
| **Baseline v2** | `bakeoff-baseline-v2-google-fixed-<timestamp>` | Fresh Google Trends on the **specific phrase** (both legs) + Etsy incumbent engagement |
| **Baseline v1** (deprecated) | `bakeoff-baseline-no-pinterest-<timestamp>` | Looked up pre-existing `signals` — most keywords got `ext_demand=0` (bug) |
| **Treatment** (future) | `bakeoff-treatment-pinterest-<timestamp>` | Google + **Pinterest** + Etsy incumbent engagement |

Pinterest slot is wired in `src/lib/bakeoff-demand.ts` (`pinterest_demand: null` baseline; treatment blends `0.45×google + 0.55×pinterest`).

## Demand axis (two-legged)

1. **Google (external)** — `fetchGoogleTrendDemand()` in `bakeoff-demand.ts` actively pulls SerpApi `engine=google_trends`, `data_type=TIMESERIES`, `date=today 1-m`, `geo=US` (same window as `collect-trends.ts`). Computes `google_demand` from 7-day interest average + velocity via `googleDemandFromSeedSignals()`. Raw interest + velocity stored in `gap_analysis` for audit. Real zeros are meaningful (low Trends demand).
2. **Etsy incumbent engagement** — from gap engine (`computeCompetitiveLandscape` → `scoreWhitespace`).

### Head-term / specific-phrase split (phrase-sensitivity fix, v3)

The two legs read keywords at **different granularity**, because each is reliable at a different one:

- **DEMAND leg → HEAD term.** Google Trends gives long-tail "...printable / template / digital" phrasings ~0 interest even when the underlying market is real (each query is normalized to its own peak, and thin queries return flat/empty timelines that score 0). Canonical false-negative: `nursery wall art printable` collapsed to DEAD_ZONE (WS 0.230) on a true-zero Trends reading despite being a niche we actively sell in. The demand leg now fetches Trends on the broad head term (`nursery wall art`), which registers real interest.
- **SUPPLY leg → SPECIFIC phrase.** Etsy competition is scored on the exact buyer phrase — that's what a listing actually ranks against in Etsy search. Unchanged.
- `white_space_score = demand_combined × supply_weakness` is **unchanged** (`demand_combined = 0.35×external + 0.65×incumbent_engagement`); we only feed the demand leg a better input.

**Head-term derivation** (`deriveHeadTerm()` in `bakeoff-keywords.ts`): deterministic strip of unambiguous digital-format modifier words (`printable(s)`, `template(s)`, `digital`, `pdf`, `editable`, `download(s)`, `instant download`, `digital download`) → keeps the core product noun phrase. Conservative on purpose: physical "print"/"set" and platform words (`svg`, `cricut`) are **not** stripped (they'd mangle the noun) — those use a per-keyword `head_term` override on the spec. Deterministic-strip-with-override = scalable default (we keep broadening seeds) + control where the strip is wrong. Falls back to the original phrase if stripping leaves nothing usable.

**Genuine dead zone vs artifact (validation):** the fix does **not** rescue real dead zones. If the head term is *still* ~0 (e.g. `abstract wall art` 0.009, `budget planner` 0.000, `workout journal` 0.000), demand stays ~0 — correctly. The report's DEMAND/SUPPLY SPLIT section labels each row `RESCUED (long-tail artifact → real head demand)` vs `genuine low/dead (head still ~0)`.

**Volatility caveat:** single-window Trends velocity swings run-to-run independent of this fix — even keywords whose head **equals** the specific phrase moved hard between pulls (e.g. `funny mom shirt` ext 1.0→0.0, `custom name t shirt` 0.71→0.0 across the v2→v3 dates). Demand scores are approximate; borderline niches may need a re-pull or longer window. Run-to-run incumbent_engagement also varies (different live listings returned), so a single run's quadrant flip can be supply-driven, not demand-driven — read deltas with this in mind. **Backlog:** demand stability score (not built).

## CLI

```bash
npm run bakeoff
npm run bakeoff -- --run-label=my-run --treatment=baseline
npm run bakeoff -- --diff-against=bakeoff-baseline-no-pinterest-2026-05-26T23-39-41
```

Default run label: `bakeoff-v3-phrasefix-<timestamp>`. Default diff target: the most recent `bakeoff-baseline-v2-google-fixed-*` run (resolved from the DB at runtime); pass `--diff-against=none` to skip.

## Keyword curation rule

Each keyword must be a **specific buyer product-phrase** that returns a **coherent product set** on Etsy search. Ambiguous category words (e.g. `"ghosts"`) inflate incumbent engagement with unrelated popular listings and fake white space.

Coherence is checked heuristically (`assessSearchCoherence` in `gap-score-keyword.ts`): top-5 title token overlap with query. Flags:

- `low_etsy_results` — fewer than 5 search hits
- `incoherent_grab_bag` — coherence score &lt; 0.6

## Scoring (neutral)

Pure `white_space_score = demand_combined × supply_weakness` from `whitespace-scoring.ts`. No producibility bias in the math.

**Demand (baseline):** `external_demand` = fresh `google_demand` → combined with incumbent engagement inside `scoreWhitespace`.

## Report views

0. **DEMAND/SUPPLY SPLIT** — per keyword: specific phrase (supply) ↔ head term (demand) + head interest + head demand + a `RESCUED` / `genuine low/dead` / `no modifier` label. Makes the granularity split auditable.
1. **RAW ranking** — all keywords by `white_space_score` desc (honest cross-niche picture).
2. **BY-NICHE summary** — best WS score per niche; **digital printables** marked ANCHOR.
3. **DIGITAL-PREFERRED** — decision hurdle, not scoring: digital keywords rank normally; physical/dropship only appear above the best digital option if they beat it by **≥ 0.10** absolute WS (`DIGITAL_PREFERENCE_HURDLE` in `bakeoff-keywords.ts`).
4. **DIFF vs prior run** — keyword-level Δext_demand and ΔWS when `--diff-against` resolves a prior run.

## Niches (28 keywords)

`head term` is what the demand leg measures (override or `deriveHeadTerm()`); the row label is the specific phrase the supply leg scores.

| Niche | Anchor? | Keywords (→ head term) |
|-------|---------|----------|
| digital_printables | **yes** | meal planner printable (→ meal planner), nursery wall art printable (→ nursery wall art), teacher planner printable (→ teacher planner) |
| household_organization | | cleaning schedule printable, budget planner printable, paycheck budget tracker printable (→ budget tracker), chore chart printable, meal prep planner printable, family command center printable, cleaning checklist printable, savings tracker printable |
| physical_wall_art | | abstract wall art print (→ abstract wall art), botanical wall art print set (→ botanical wall art) |
| pet_portraits | | custom pet portrait digital (→ custom pet portrait), dog portrait print (→ dog portrait) |
| wedding_events | | wedding seating chart template, wedding invitation template, wedding welcome sign template |
| svg_craft_digital | | svg files for cricut, svg bundle cricut (→ cricut svg) |
| greeting_cards | | printable birthday card (→ birthday card), printable thank you card (→ thank you card) |
| apparel | | funny mom shirt, custom name t shirt |
| wellness_fitness | | printable workout tracker (→ workout tracker), workout journal printable (→ workout journal) |
| home_decor_physical | | macrame wall hanging, scented soy candle |

**household_organization** is our beachhead lane (the meal planner gives us a foothold). Producibility tags (`digital` / `physical-POD` / `dropship`) are informational; refined from Etsy title sample when ambiguous.

## Querying results

```sql
select r.run_label, res.*
from niche_bakeoff_results res
join niche_bakeoff_runs r on r.id = res.run_id
where r.run_label like 'bakeoff-baseline-v2%'
order by res.white_space_score desc;
```

Diff two runs:

```sql
select
  n.keyword,
  o.external_demand as old_ext, n.external_demand as new_ext,
  o.white_space_score as old_ws, n.white_space_score as new_ws
from niche_bakeoff_results n
join niche_bakeoff_runs nr on nr.id = n.run_id
join niche_bakeoff_results o on o.keyword = n.keyword
join niche_bakeoff_runs orr on orr.id = o.run_id
where nr.run_label = 'bakeoff-baseline-v2-google-fixed-...'
  and orr.run_label = 'bakeoff-baseline-no-pinterest-2026-05-26T23-39-41';
```

## Cost per run

~28 SerpApi credits (Google Trends on deduped head terms) + ~28 Etsy searches + ~280 listing fetches. No LLM. Latest run: 244s, 28 keywords, 4 transient Etsy 429s (still usable).
