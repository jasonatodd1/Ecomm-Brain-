# Niche bake-off

Compares **9 niches** (~2–3 buyer-phrase keywords each) using the same white-space triangulation as production (`gap engine` + `whitespace-scoring.ts`). Does **not** write to `opportunities` or `signals` — results live in `niche_bakeoff_runs` / `niche_bakeoff_results`.

## Run types

| Run | Label pattern | Demand sources |
|-----|---------------|----------------|
| **Baseline v2** | `bakeoff-baseline-v2-google-fixed-<timestamp>` | **Fresh Google Trends per keyword** (SerpApi) + Etsy incumbent engagement |
| **Baseline v1** (deprecated) | `bakeoff-baseline-no-pinterest-<timestamp>` | Looked up pre-existing `signals` — most keywords got `ext_demand=0` (bug) |
| **Treatment** (future) | `bakeoff-treatment-pinterest-<timestamp>` | Google + **Pinterest** + Etsy incumbent engagement |

Pinterest slot is wired in `src/lib/bakeoff-demand.ts` (`pinterest_demand: null` baseline; treatment blends `0.45×google + 0.55×pinterest`).

## Demand axis (two-legged)

1. **Google (external)** — `fetchGoogleTrendDemand()` in `bakeoff-demand.ts` actively pulls SerpApi `engine=google_trends`, `data_type=TIMESERIES`, `date=today 1-m`, `geo=US` (same window as `collect-trends.ts`). Computes `google_demand` from 7-day interest average + velocity via `googleDemandFromSeedSignals()`. Raw interest + velocity stored in `gap_analysis` for audit. Real zeros are meaningful (low Trends demand).
2. **Etsy incumbent engagement** — from gap engine (`computeCompetitiveLandscape` → `scoreWhitespace`).

**Volatility caveat:** single-window Trends velocity swings run-to-run (e.g. meal planner `ext_demand` can move from ~1.0 to ~0 between pulls). Demand scores are approximate; borderline niches may need a re-pull or longer window. **Backlog:** demand stability score (not built).

## CLI

```bash
npm run bakeoff
npm run bakeoff -- --run-label=my-run --treatment=baseline
npm run bakeoff -- --diff-against=bakeoff-baseline-no-pinterest-2026-05-26T23-39-41
```

Default run label: `bakeoff-baseline-v2-google-fixed-<timestamp>`. Default diff target: v1 broken baseline above.

## Keyword curation rule

Each keyword must be a **specific buyer product-phrase** that returns a **coherent product set** on Etsy search. Ambiguous category words (e.g. `"ghosts"`) inflate incumbent engagement with unrelated popular listings and fake white space.

Coherence is checked heuristically (`assessSearchCoherence` in `gap-score-keyword.ts`): top-5 title token overlap with query. Flags:

- `low_etsy_results` — fewer than 5 search hits
- `incoherent_grab_bag` — coherence score &lt; 0.6

## Scoring (neutral)

Pure `white_space_score = demand_combined × supply_weakness` from `whitespace-scoring.ts`. No producibility bias in the math.

**Demand (baseline):** `external_demand` = fresh `google_demand` → combined with incumbent engagement inside `scoreWhitespace`.

## Report views

1. **RAW ranking** — all keywords by `white_space_score` desc (honest cross-niche picture).
2. **BY-NICHE summary** — best WS score per niche; **digital printables** marked ANCHOR.
3. **DIGITAL-PREFERRED** — decision hurdle, not scoring: digital keywords rank normally; physical/dropship only appear above the best digital option if they beat it by **≥ 0.10** absolute WS (`DIGITAL_PREFERENCE_HURDLE` in `bakeoff-keywords.ts`).
4. **DIFF vs prior run** — keyword-level Δext_demand and ΔWS when `--diff-against` is set.

## Niches (20 keywords)

| Niche | Anchor? | Keywords |
|-------|---------|----------|
| digital_printables | **yes** | meal planner printable, nursery wall art printable, teacher planner printable |
| physical_wall_art | | abstract wall art print, botanical wall art print set |
| pet_portraits | | custom pet portrait digital, dog portrait print |
| wedding_events | | wedding seating chart template, wedding invitation template, wedding welcome sign template |
| svg_craft_digital | | svg files for cricut, svg bundle cricut |
| greeting_cards | | printable birthday card, printable thank you card |
| apparel | | funny mom shirt, custom name t shirt |
| wellness_fitness | | printable workout tracker, workout journal printable |
| home_decor_physical | | macrame wall hanging, scented soy candle |

Producibility tags (`digital` / `physical-POD` / `dropship`) are informational; refined from Etsy title sample when ambiguous.

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

~20 SerpApi credits (Google Trends) + ~20 Etsy searches + ~200 listing fetches. No LLM.
