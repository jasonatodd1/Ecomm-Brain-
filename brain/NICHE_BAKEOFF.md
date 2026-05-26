# Niche bake-off

Compares **9 niches** (~2–3 buyer-phrase keywords each) using the same white-space triangulation as production (`gap engine` + `whitespace-scoring.ts`). Does **not** write to `opportunities` — results live in `niche_bakeoff_runs` / `niche_bakeoff_results`.

## Run types

| Run | Label pattern | Demand sources |
|-----|---------------|----------------|
| **Baseline** | `bakeoff-baseline-no-pinterest-<timestamp>` | Google (Trends seeds + Trending Now) + Etsy incumbent engagement |
| **Treatment** (future) | `bakeoff-treatment-pinterest-<timestamp>` | Google + **Pinterest** + Etsy incumbent engagement |

Pinterest slot is wired in `src/lib/bakeoff-demand.ts` (`pinterest_demand: null` baseline; treatment blends `0.45×google + 0.55×pinterest`).

## CLI

```bash
npm run bakeoff
npm run bakeoff -- --run-label=my-run --treatment=baseline
```

## Keyword curation rule

Each keyword must be a **specific buyer product-phrase** that returns a **coherent product set** on Etsy search. Ambiguous category words (e.g. `"ghosts"`) inflate incumbent engagement with unrelated popular listings and fake white space.

Coherence is checked heuristically (`assessSearchCoherence` in `gap-score-keyword.ts`): top-5 title token overlap with query. Flags:

- `low_etsy_results` — fewer than 5 search hits
- `incoherent_grab_bag` — coherence score &lt; 0.6

## Scoring (neutral)

Pure `white_space_score = demand_combined × supply_weakness` from `whitespace-scoring.ts`. No producibility bias in the math.

**Demand (baseline):** `external_demand` = Google only → combined with incumbent engagement inside `scoreWhitespace`.

## Three report views

1. **RAW ranking** — all keywords by `white_space_score` desc (honest cross-niche picture).
2. **BY-NICHE summary** — best WS score per niche; **digital printables** marked ANCHOR.
3. **DIGITAL-PREFERRED** — decision hurdle, not scoring: digital keywords rank normally; physical/dropship only appear above the best digital option if they beat it by **≥ 0.10** absolute WS (`DIGITAL_PREFERENCE_HURDLE` in `bakeoff-keywords.ts`).

## Niches (21 keywords)

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
where r.run_label like 'bakeoff-baseline%'
order by res.white_space_score desc;
```

Diff baseline vs treatment by joining two runs on `keyword`.
