# Meal Planner — Listing Package v1 (Etsy)

> **brief_id:** `cb213bf4-5225-4bc9-b4ac-67f2167c9b8f` (v5, research-v3.2)  
> **listing_id:** `6986ce3a-f653-46ca-a5d5-9d2c6b13b5aa` · **etsy_listing_id:** `4512363257` · [live](https://www.etsy.com/listing/4512363257/meal-planner-printable-with-grocery-list)  
> **agent_run_id:** `d9d0bca7-f289-4823-9667-c4ea51a227a5`  
> **Generated:** 2026-05-27 | **Published:** 2026-05-27 | **package_version:** `listing-v1` | **cost:** $0.00

---

## Operator review notes (read before publish)

### Wedge integration — both wedges landed (via prose, not `wedges[]`)

The Listing Agent renders `brief.listing.description` verbatim; it does **not** parse `differentiation_thesis.wedges[]` directly. Because v5 resynthesis aligned the prose fields with both wedges, **both made it through**:

| Wedge | In hook? | In why_this_one? |
|---|---|---|
| **Workflow** (single-page, aisle-grouped, tear-off) | ✅ "one tear-off page", "aisle-grouped grocery list" | ✅ foil names (separate sections / tabs / hyperlinked pages), aisle headers listed |
| **Customization** (print-and-pen, no passwords) | — (lead wedge is workflow in hook) | ✅ "paper-and-pen by design: no locked cells, no password-protected fields, no rigid recipe-entry forms" |

**Signal:** Agent works coherently on aligned prose alone today. `wedges[]` is documentation/grounding for humans and future agent upgrades — not consumed at runtime in listing-v1.

### Photo ordering — agent manifest ≠ recommended Etsy order

The agent's `image_manifest` follows `brief.listing.image_spec` (4 slots, one asset per **kind**). It does **not** read `assets.metadata.display_order`. Three registered photos are unused:

| Agent slot | Asset picked | Unused photos |
|---|---|---|
| 1 hero | 01-hero | — |
| 2 lifestyle | **02-in-use** (first `lifestyle` by width) | **03-grocery-store**, **04-kitchen** |
| 3 whats_included | 07-whats-included | — |
| 4 lifestyle_detail | 06-aisle-headers | **05-pdf-preview** |

**Recommended manual Etsy upload order** (uses all 7 photos, `display_order` 1–7):

| Etsy slot | File | Role |
|---:|---|---|
| 1 | `meal-planner-01-hero.png` | Hero — linen flat-lay |
| 2 | `meal-planner-02-lifestyle-in-use.png` | In-use — handwriting (customization wedge) |
| 3 | `meal-planner-03-lifestyle-grocery-store.jpg` | Grocery store — workflow wedge |
| 4 | `meal-planner-04-lifestyle-kitchen.png` | Kitchen counter |
| 5 | `meal-planner-05-pdf-preview.png` | Product flat (actual PDF page) |
| 6 | `meal-planner-06-detail-aisle-headers.png` | Aisle detail crop |
| 7 | `meal-planner-07-whats-included.png` | 2×2 SKU grid |

### Price — GAP (not in package)

`brief.product.pricing` is **null**. Listing Agent v1 omits price when unset (per LISTING_AGENT_REQUIREMENTS §5 — agent never overrides Research Agent pricing).

**Operator decision required:** Brief risk notes reference **$3.49** (sub-median vs MyLifePlans $2.00 anchor; same as bunny). Competitive range from brief: incumbents $2–$19.95; category sweet spot $3–$8 for 4-file PDF bundles.

### Taxonomy — 354 (not Digital Downloads)

**taxonomy_id:** `354` — Paper & Party Supplies > Paper > Calendars & Planners

This is a **full breadcrumb match** to `brief.listing.etsy_category` (not a fallback trim). Different from bunny (2078 Digital Prints). Confirm at publish whether physical-planner taxonomy or Craft Supplies > Digital Downloads is preferred for Etsy search placement.

### Digital download settings (manual at publish)

| Setting | Value |
|---|---|
| Type | Digital download |
| Files | 4 PDFs (`meal-planner-{sun\|mon}-{letter\|a4}.pdf`) |
| Formats | PDF only |
| Approx size | ~100 KB each (~400 KB total) |
| Instant download | Yes |
| Personal use license | Yes (footer on sheet + FAQ) |

Deliverables registered as `printable_pdf` assets against this brief.

### Persistence

- Full structured `PublishPackage` → `agent_runs.metadata.package` (run `d9d0bca7-…`)
- Mirror copy → `brain/packages/2026-05-27-cb213bf4-etsy.md`
- **`listings` row:** `6986ce3a-f653-46ca-a5d5-9d2c6b13b5aa` · Etsy `4512363257` · opportunity `a4376656…` · 11 assets linked via `npm run register:meal-planner-listing`

### Photo order audit (2026-05-27, live listing)

| Etsy slot | Matched asset | Status |
|---:|---|---|
| 1 | 01-hero | ✅ |
| 2 | 02-lifestyle-in-use | ✅ |
| 3 | 03-grocery-store | ✅ |
| 4 | 04-kitchen | ✅ |
| 5 | **06-aisle-headers** | ⚠️ should be slot 6 |
| 6 | **05-pdf-preview** | ⚠️ should be slot 5 |
| 7 | 07-whats-included | ✅ |

**Optional fix:** swap Etsy photos #5 and #6 so PDF preview precedes aisle detail crop (recommended conversion order). All 7 photos present — only these two are transposed.

---

# Listing Package — Etsy

> brief_id: `cb213bf4-5225-4bc9-b4ac-67f2167c9b8f` | listing_id: _(new)_
> Generated 2026-05-27 | cost $0.0000 | package_version `listing-v1`

## ⚠️ Gaps to address before publish

- [ ] Title was edited from brief verbatim (truncation or trim).
- [ ] Attributes substituted (review): Material multi ("digital download"→"Paper"); Primary color ("off-white"→"White"); Secondary color ("off-white"→"White").
- [ ] **Price not set** — add $3.49 (or chosen price) manually; `brief.product.pricing` was null.
- [ ] **Upload 7 photos manually** — agent manifest covers 4/7; use recommended order above.
- [ ] **Confirm taxonomy 354** vs Digital Downloads category.

## SEO Score (pre-publish gate)

**Draft score: 83 / 90 (92%)** — scorer `v1`

Incumbent benchmark for `weekly meal planner`: median of top 3 = 79% · our 92% · ✅ beats incumbents.

### Per-rule breakdown

| Rule | Score | Max | Note |
| --- | ---: | ---: | --- |
| `title_length` | 10 | 10 | Title 126 chars (target 100-140) |
| `title_keyword_placement` | 10 | 10 | Keyword front-loaded (idx 0) |
| `tag_count` | 10 | 10 | 13 of 13 tags |
| `tag_quality` | 6 | 10 | 4 of 13 tags fail quality checks (length >20 or full-phrase title duplicate) |
| `description_length` | 10 | 10 | Description 3497 chars (target ≥2000) |
| `description_keyword_in_preview` | 10 | 10 | Primary keyword in first 160 chars |
| `description_scannable_structure` | 10 | 10 | 3/3 markers present (caps_headers=4, bullets=4, faq_lines=7) |
| `attribute_fill_rate` | 7 | 10 | 3/4 attribute slots filled (75%) |
| `shop_section_assigned` | 10 | 10 | Shop section 1 assigned |

**Weak areas (top 3):** tag_quality, attribute_fill_rate

## Title

```
Meal Planner Printable with Grocery List | One-Page Weekly Meal Plan + Aisle-Grouped Shopping List PDF | Sunday & Monday Start
```
_126/140 chars_

## Tags

1. `meal planner` (12)
2. `grocery list` (12)
3. `weekly meal plan` (16)
4. `meal prep planner` (17)
5. `menu planner` (12)
6. `shopping list pdf` (17)
7. `family meal plan` (16)
8. `meal planner pdf` (16)
9. `printable planner` (17)
10. `kitchen printable` (17)
11. `dinner planner` (14)
12. `food planner` (12)
13. `one page planner` (16)

_13/13 tags — ok_

## Taxonomy

**taxonomy_id:** `354`
**path:** Paper & Party Supplies > Paper > Calendars & Planners

## Attributes

### `Material multi` (property_id 148789511893) ⚠️ (substituted)

- **Paper** (value_id 196) — confidence `semantic` _(substituted)_ — _Semantic substitution: "digital download" → "Paper" (curated neighbor)._

### `Primary color` (property_id 200) ⚠️ (substituted)

- **White** (value_id 10) — confidence `token` _(substituted)_ — _Token match: "off-white" → "White" (shared meaningful word)._

### `Secondary color` (property_id 52047899002) ⚠️ (substituted)

- **White** (value_id 10) — confidence `token` _(substituted)_ — _Token match: "off-white" → "White" (shared meaningful word)._

### Skipped properties

| Property | Reason | Detail |
| --- | --- | --- |
| `Occasion` | `no_match` | Descriptors tried: weekly meal planning, grocery shopping, kitchen organization, new home; 4 skipped. |
| `Material` | `free_text_not_mapped` | Free-text property — descriptors available if wanted: digital download, printable pdf, instant download |
| `Pattern` | `free_text_not_mapped` | Free-text property — descriptors available if wanted: minimalist, modern, editorial, warm neutral, functional |
| `Style` | `free_text_not_mapped` | Free-text property — descriptors available if wanted: minimalist, modern, editorial, warm neutral, functional |

_(Plus 14 block-listed irrelevant properties — see full package in `brain/packages/2026-05-27-cb213bf4-etsy.md`)_

## Materials (listing-level free-text)

- digital download
- printable pdf
- instant download

## Shop section suggestion

`Meal Planners` — _operator: match against shop sections list or create if missing._

## Image manifest (agent — 4 slots)

**4/4 slots ready.** See operator notes above for full 7-photo Etsy upload order.

### ✅ Slot 1 — `hero` → `meal-planner-01-hero.png` (1024×1024, fal_ui)

### ✅ Slot 2 — `lifestyle` → `meal-planner-02-lifestyle-in-use.png` (1024×1024, fal_ui)

### ✅ Slot 3 — `whats_included` → `meal-planner-07-whats-included.png` (3000×3000, render_planner)

### ✅ Slot 4 — `lifestyle_detail` → `meal-planner-06-detail-aisle-headers.png` (1001×2339, render_planner)

## Description (Etsy plaintext — paste verbatim)

```
A weekly meal planner printable that fits the 7-day menu and an aisle-grouped grocery list on one tear-off page — plan dinner and shop the store from the same sheet.

WHY THIS ONE

Most weekly meal planner templates split the meal grid and the grocery list across separate sections, spreadsheet tabs, or hyperlinked PDF pages — so you end up flipping, printing twice, or losing the list on the way to the store. This one-page layout keeps the 7-day menu beside an aisle-grouped grocery list (Produce, Proteins, Dairy, Pantry, Freezer, Other) so meal planning and shopping happen from a single sheet. It's also paper-and-pen by design: no locked cells, no password-protected fields, no rigid recipe-entry forms — write any meal, any combination, any note, in your own hand. Both Sunday-start and Monday-start versions are included in A4 and US Letter, so the family meal planner that fits your week is already in the file.

WHAT'S INCLUDED

- One-page weekly meal planner with aisle-grouped grocery list (Sunday start, US Letter)
- One-page weekly meal planner with aisle-grouped grocery list (Monday start, US Letter)
- One-page weekly meal planner with aisle-grouped grocery list (Sunday start, A4)
- One-page weekly meal planner with aisle-grouped grocery list (Monday start, A4)

HOW IT WORKS

1. Purchase and download the PDF instantly from your Etsy account — no waiting, no shipping.
2. Open the file and choose the page that matches your week-start preference and paper size.
3. Print at home on standard paper, or send to a print shop — the design is ink-friendly.
4. Plan the week's meals on the left, build the aisle-grouped grocery list on the right, and take the same sheet to the store.

FREQUENTLY ASKED QUESTIONS

Q. Is this an original design?
A. Yes — every layout, illustration accent, and typographic choice in this planner is designed in-house by HillwardStudio. It is licensed for personal use; please don't resell or redistribute the files.

Q. Will one page really be enough for a week of meals and groceries?
A. That's exactly the design intent. The page is built around three meals per day for seven days plus a six-section grocery list — if you find you need more space for a larger household, the file prints cleanly at A4 or US Letter so you can run two sheets per week without losing the one-page format.

Q. Is this dated for a specific year?
A. No — the planner is undated, so you can start any week of any year and reuse it indefinitely.

Q. What software do I need to open it?
A. Any free PDF reader (Adobe Acrobat Reader, Preview on Mac, or your browser) will open and print the file. No special software, no subscription, no Google account.

Q. Can I print this at home?
A. Yes. The design uses minimal ink coverage and prints cleanly on standard 8.5x11" or A4 paper from any home inkjet or laser printer.

Q. Will I receive a physical product in the mail?
A. No — this is an instant digital download. Nothing ships physically. The files appear in your Etsy Purchases page as soon as the order completes.

Q. Can I gift this to a friend who's just moved in or had a baby?
A. The file is licensed for personal use by the purchaser, but you're welcome to print a copy and gift the printed sheet — many buyers print a small stack as a housewarming or new-parent gift.

—

Thanks for stopping by HillwardStudio. Every piece in the shop is designed with the same intention — quiet, considered, and built to earn its place rather than disappear into a download folder.
```

_3497 chars._
