# Design Agent — Requirements

> Durable spec. Captures architecture designed during the bunny **size guide** + **refine-graphic** visual-loop sessions (2026-05-22). Source of truth for what the Design Agent must do before marketing graphics can be generated autonomously end-to-end.
>
> Living document. Update whenever a manual graphic build or loop run reveals a new template constraint, asset-library gap, or critic failure mode.

## Implementation status — v0 (2026-05-22)

> **Capability test shipped — NOT an autonomous agent yet.** We proved programmatic HTML→PNG graphics (`render:graphic`), a vision feedback loop (`refine:graphic`), a reference-asset library (`brain/templates/assets/`), and a hand-built bunny size guide (couch scale reference). The loop improves layout reliably but **must not** be trusted to ship curated assets without guardrails.

| Component | Status |
|---|---|
| `render:graphic` CLI + shared lib | ✅ built (`src/lib/render-graphic.ts`, `src/render/render-graphic.ts`) |
| `refine:graphic` loop (render → critique → revise → re-render) | ✅ built (`src/tools/refine-graphic.ts`, `npm run refine:graphic`) — keep-best-so-far + parse robustness |
| Bunny `size_guide` template + PNG | ✅ hand-built final (couch asset, 13 px/in honest scale) |
| Reference asset library | ✅ started (`templates/assets/furniture/sofa.svg`; `templates/assets/silhouettes/adult.svg` needs work) |
| `templates` Supabase table | ⏸ not created |
| Design Agent orchestrator | ⏸ not built |
| Render-time locked-asset injection | ⏸ not built (required before autonomous loop) |
| Few-shot critic anchoring | ⏸ not built (required before autonomous loop) |

---

## 1. Purpose

The Design Agent produces a product's **marketing graphics** — `hero`, `lifestyle`, `whats_included`, `size_grid`, `lifestyle_detail`, etc. — from the brief's `listing.image_spec`, by:

1. Selecting a **template** (structure + rubric) for each slot.
2. Filling template **parameters** (sizes, copy, brand tokens, scale reference).
3. Injecting **locked reference assets** (SVG silhouettes, furniture icons) at render time.
4. Optionally running the **visual feedback loop** (`refine-graphic`) to refine **layout only** until PASS or max-iter.
5. Registering outputs in the **`assets`** table via `link:asset` (same contract as Listing Agent §6).

The agent never asks a human mid-run. If a slot cannot reach PASS within budget, it surfaces the best-so-far render + critique log in `agent_runs.metadata` for operator review.

**Downstream consumer:** Listing Agent image manifest (`PublishPackage.image_manifest[]`) — each row must resolve to an `assets` row with correct `kind`, dims, and `local_path`.

---

## 2. Visual feedback loop (`refine-graphic`)

### Flow

```
HTML template + rubric
  → renderGraphic (Puppeteer 2000×2000)
  → vision critique (Claude Sonnet 4.6 multimodal)
  → PASS | REVISE (full HTML rewrite)
  → repeat until PASS or max-iter
  → on cap without PASS: ship keep-best-so-far (quality_score)
```

**CLI:**

```bash
npm run refine:graphic -- \
  --html=path/to/template.html \
  --out=path/to/output.png \
  --rubric=path/to/rubric.md \
  [--max-iter=6]
```

Scratch iterations land in `dist/refine-graphic/<slug>/` (gitignored): `iteration-{n}.html`, `iteration-{n}.png`, `iteration-log.json`.

### Proven capabilities (bunny size guide test run)

- **Layout refinement works:** frames enlarged, stepped baseline, composition filled canvas across iterations.
- **Regression recovery:** iteration 2 regressed (person silhouette missing); iteration 3 passed — motivates keep-best-so-far (now implemented).
- **Parser hardening:** PASS without HTML block, malformed META JSON, missing delimiters — log `PARSE_ERROR`, keep previous HTML, never crash.
- **Cost reference:** ~$0.15 for 3-iteration size guide run (Sonnet 4.6 vision).

### STATUS: layout-refinement capability **PROVEN** — autonomous shipping **BLOCKED**

Two known flaws prevent trusting the loop to ship without human eyeball:

#### FLAW 1 — Asset destruction

The loop rewrites the **entire HTML** each REVISE iteration. It can discard a curated SVG asset and redraw the element as crude codegen (replaced `adult.svg` silhouette with a circle+rectangle wireframe; then **passed** it at 8/10).

**Fix (required before autonomous use): render-time asset injection**

- Curated assets live in `brain/templates/assets/` as locked SVG paths.
- Templates reference them via **placeholders** (e.g. `{{ASSET:furniture/sofa}}`) or `<use href="…">` includes resolved at render time.
- The loop may adjust **layout** (position, scale, fill/stroke CSS) but **cannot edit path data**.
- Separate **editable layout** (HTML structure, frame positions, copy) from **locked assets** so the reviser physically cannot redraw a silhouette or icon.

#### FLAW 2 — Critic false-passes

The vision critic passed a wireframe stick-figure at **8/10** even after the rubric was sharpened with explicit "reject wireframes / stick figures / clip-art" criteria. More rubric words alone did not fix it.

**Fix (required before autonomous use): few-shot anchored critique**

- Provide **known-bad** and **known-good** reference PNGs alongside the rubric (few-shot).
- System prompt: judge what is **ACTUALLY VISIBLE** in the render, not what the HTML *intends*.
- Require `quality_score` in META JSON; treat scores ≤4 as hard fail regardless of verdict text.

### When to use the loop vs hand-build

| Use loop | Hand-build |
|---|---|
| Layout/composition tuning on a stable template | Curated reference assets (silhouettes, icons) |
| After locked-asset injection is implemented | Size guides with honest scale (until asset injection ships) |
| Operator can eyeball final PNG | Production listing photos before flaws 1+2 are fixed |

**Bunny size guide (2026-05-22):** hand-built with couch asset after loop false-passed on wireframe person. Final PNG committed; loop used only for capability test.

---

## 3. Templates

### Repo layout

```
brain/templates/
  <graphic_kind>/           # e.g. size_guide/, whats_included/ (future)
    structure.html          # default skeleton
    rubric.md               # vision critique rubric
  assets/                   # locked reference SVGs (shared library)
    furniture/sofa.svg
    silhouettes/adult.svg   # ⚠ needs refinement — peg-doll proportions
    */preview.html          # standalone render helpers (dev only)

brain/products/<slug>/template/
  size-guide.html           # product-specific filled template (bunny: couch version)
  size-guide-rubric.md
  whats-included.html       # existing pattern
```

Product-specific templates **override** generic templates when present. The Design Agent checks `products/<slug>/template/` first, then falls back to `brain/templates/<graphic_kind>/`.

### Supabase `templates` table (planned — not migrated)

Index repo templates for agent selection:

| Column | Purpose |
|---|---|
| `graphic_kind` | `hero` \| `lifestyle` \| `whats_included` \| `size_grid` \| `lifestyle_detail` |
| `structure_path` | repo-relative path to `structure.html` |
| `rubric_path` | repo-relative path to `rubric.md` |
| `applicability` | jsonb tags: `{ "orientation": "portrait", "product_type": "wall_art", "scale_reference": "sofa" }` |
| `parameters_schema` | jsonb JSON Schema for fill slots (sizes array, scale reference kind, brand tokens, copy overrides) |
| `locked_assets` | text[] of asset keys the template requires (`furniture/sofa`, `silhouettes/adult`) |
| `version` | semver for template evolution |

The agent matches `brief.listing.image_spec[].kind` + product tags → best template row → fills parameters → renders.

### Template parameters (bunny size guide example)

| Parameter | Value (bunny) |
|---|---|
| `scale_px_per_inch` | 13 |
| `scale_reference` | `furniture/sofa` (84″ wide) |
| `print_sizes` | 8×10, 11×14, 16×20, 18×24, 24×36 (portrait) |
| `brand.eyebrow` | HillwardStudio |
| `brand.footer` | Vintage Bunny Nursery Print |
| `palette.background` | `#EDE8E1` |
| `palette.accent` | `#6B7F5E` |

---

## 4. Reference asset library

**Location:** `brain/templates/assets/`

| Asset | Path | Status |
|---|---|---|
| Standard 3-seat sofa (84″ × 32″ front elevation) | `furniture/sofa.svg` | ✅ working — track-arm, full-width back, arms on seat seam, 4 legs |
| Adult standing silhouette (66″ / 5′6″) | `silhouettes/adult.svg` | ⚠ **needs work** — peg-doll proportions, no visible arms; rejected for bunny size guide in favor of sofa |

**Conventions:**

- `viewBox` units = **inches** where scale honesty matters.
- `fill="currentColor"` for recoloring via CSS in templates.
- Match frame treatment: sage fill `rgba(107,127,94,0.14)` + stroke `#6B7F5E`.
- Preview via `templates/assets/*/preview.html` + `npm run render:graphic`.

Assets are **locked** — templates inline or inject at render time; the visual loop must not rewrite path data (see §2 FLAW 1).

---

## 5. Outputs & asset registry

Same contract as Listing Agent §6:

- Render to `products/<slug>/listing-photos/<name>.png` (2000×2000 for Etsy slots).
- Register: `npm run link:asset -- --kind=size_grid --path=… --listing-id=<etsy_id> --source=render_graphic`
- **Bunny `size_grid` (2026-05-22):** `products/hillward-nursery-bunny/listing-photos/size-guide.png` — path unchanged from prior registration; new couch render replaces PNG on disk only. Verified: `assets` row for `etsy_listing_id=4508704536` resolves correctly.

---

## 6. Open items (tracked)

### Blockers (before Design Agent v1)

- [ ] **Render-time locked-asset injection** — placeholders/includes the loop cannot edit (§2 FLAW 1).
- [ ] **Few-shot critic anchoring** — known-good/bad reference images in vision prompt (§2 FLAW 2).
- [ ] **`templates` Supabase table + migration** — index repo templates for agent selection (§3).
- [ ] **Design Agent orchestrator** — brief `image_spec` → template select → fill → render → optional refine → `link:asset`.

### Asset library

- [ ] **Refine `silhouettes/adult.svg`** — wayfinding sign style with proper arms/proportions, or deprecate if sofa/crib icons cover wall-art scale needs.
- [ ] **Add `furniture/crib.svg`** (optional) — nursery-specific scale reference alternative to sofa.

### Proven / done this session

- [x] Shared `renderGraphic` lib extracted from CLI.
- [x] `refine:graphic` loop with keep-best-so-far, parse robustness, `quality_score`.
- [x] Bunny size guide v2 — couch scale reference, hand-built, 5/5 listing manifest slot.
- [x] `size-guide-rubric.md` with aesthetic cohesion + visual consistency criteria.
- [x] Reference asset library started (`sofa.svg`).

### Integration (after v1)

- [ ] Wire Design Agent into Listing Agent missing-slot hints (`auto-trigger` Phase 2).
- [ ] Log `agent_runs` (`agent='design'`) + per-iteration cost in `refine-graphic` runs.
- [ ] Niche memory: which scale references / templates convert by category.

---

## 7. Session reference — bunny size guide evolution

| Iteration | Approach | Outcome |
|---|---|---|
| v1 | Nested rectangles + crib silhouette | Committed earlier; replaced |
| v2 | Person silhouette (`adult.svg`) + refine loop | Loop passed wireframe false-positive; not shipped |
| v3 | Sofa asset + hand-build | **Shipped** — 13 px/in, frames above couch, floor line at leg bottoms |

**Final template:** `products/hillward-nursery-bunny/template/size-guide.html`  
**Final PNG:** `products/hillward-nursery-bunny/listing-photos/size-guide.png`  
**Rubric:** `products/hillward-nursery-bunny/template/size-guide-rubric.md`
