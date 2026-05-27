import type {
  DecisionRecord,
  EtsySearchResult,
  NicheMemoryRow,
  BuyerPainSignal,
  IncumbentOffering
} from './types.js';
import type { MarketAggregates } from './aggregates.js';
import type { CompetitiveLandscapeEntry } from './competitive.js';

// ---------------------------------------------------------------------------
// (a) Keyword extraction
// ---------------------------------------------------------------------------

export function buildKeywordExtractionPrompt(decision: DecisionRecord): string {
  const ctx = decision.context;
  const source =
    typeof ctx['source'] === 'string' ? ctx['source'] : 'unknown';
  const subreddit =
    typeof ctx['subreddit'] === 'string' ? ctx['subreddit'] : '';
  const postUrl =
    typeof ctx['post_url'] === 'string' ? ctx['post_url'] : '';
  const score = typeof ctx['score'] === 'number' ? ctx['score'] : null;

  return `You are extracting Etsy search keywords from a buyer-intent signal.

== DECISION ==
Title: ${decision.title}
Description: ${decision.description}
Urgency: ${decision.urgency}
Source: ${source}${subreddit ? ` (r/${subreddit})` : ''}
${postUrl ? `Original post: ${postUrl}` : ''}
${score !== null ? `Engagement: ${score} upvotes` : ''}

== TASK ==
Output 4-6 search keywords this buyer (or buyers like them) would actually type into Etsy's search bar to find the product they want.

== RULES ==
- 2-5 words per keyword. Etsy searches are short.
- Cover three layers, in roughly this distribution:
  1. EXACT product type the buyer wants (1-2 keywords). What would they type if they knew the product existed?
  2. RELATED products in the same category (2-3 keywords). What adjacent products would compete for the same buyer's attention?
  3. BROADER category to scout the wider market (1 keyword).
- Use real consumer search language, not industry jargon.
- No quotes, no boolean operators, no special syntax.
- Each keyword should be searchable on its own — not a clause.

== OUTPUT FORMAT ==
Return ONLY a JSON array of strings. No markdown fences. No preamble. No explanation.

Example output for someone wanting custom kitchen labels:
["pantry labels printable","kitchen organization labels","minimalist spice jar labels","editable canister labels","kitchen pantry stickers"]`;
}

// ---------------------------------------------------------------------------
// (b) Synthesis
// ---------------------------------------------------------------------------

function formatNicheMemory(memory: NicheMemoryRow[]): string {
  if (memory.length === 0) {
    return '(No prior learnings for this niche — this is the first run.)';
  }

  return memory
    .map((row, i) => {
      const value = row.memory_value
        ? JSON.stringify(row.memory_value)
        : '(no value)';
      return `[${i + 1}] niche=${row.niche_tag ?? '?'} key="${row.memory_key ?? '?'}" confidence=${row.confidence ?? '?'} evidence_count=${row.evidence_count ?? '?'} value=${value}`;
    })
    .join('\n');
}

function formatAggregates(aggregates: MarketAggregates): string {
  if (aggregates.listings_analyzed === 0) {
    return '(No listings with complete price + favorers data — competitive aggregates unavailable. Note this in your reasoning and risks.)';
  }

  const lines: string[] = [
    `listings_analyzed: ${aggregates.listings_analyzed}`,
    `median_price: $${aggregates.median_price.toFixed(2)}`,
    `price_range: P25=$${aggregates.price_range.p25.toFixed(2)}, P50=$${aggregates.price_range.p50.toFixed(2)}, P75=$${aggregates.price_range.p75.toFixed(2)}`,
    `median_favorers: ${aggregates.median_favorers}`,
    '',
    'top_sellers (sorted by num_favorers desc, with notable_features left for you to fill):'
  ];

  aggregates.top_sellers.forEach((s, i) => {
    const reviewBadge =
      typeof s.shop_review_average === 'number' &&
      typeof s.shop_review_count === 'number'
        ? `★${s.shop_review_average.toFixed(2)} from ${s.shop_review_count} reviews`
        : 'shop reviews unavailable';
    const shopLabel = s.shop_name || '(shop name unavailable)';
    lines.push(
      `${i + 1}. ${shopLabel} (${reviewBadge}) | ${s.listing_title} | $${s.price.toFixed(2)} | ${s.num_favorers} favorers | ${s.listing_url}`
    );
  });

  return lines.join('\n');
}

function formatEtsyResults(results: EtsySearchResult[]): string {
  if (results.length === 0) {
    return '(No Etsy results returned — competitive data is unavailable. Note this in your reasoning and risks.)';
  }

  return results
    .map((r, i) => {
      const price = r.price !== null ? `$${r.price.toFixed(2)}` : 'unknown';
      const favorers =
        r.num_favorers !== null ? `${r.num_favorers} favorers` : '0 favorers';
      const desc = r.description_preview
        ? `\n    desc=${r.description_preview.slice(0, 200).replace(/\s+/g, ' ').trim()}`
        : '';
      return `[${i + 1}] ${r.title}
    ${price} | ${favorers}
    listing=${r.url}${desc}`;
    })
    .join('\n\n');
}

function formatCompetitiveLandscape(
  landscape: CompetitiveLandscapeEntry[]
): string {
  if (landscape.length === 0) {
    return '(No competitive landscape computed — supply-side SEO data is unavailable. Reason about competition qualitatively from the raw listings above.)';
  }

  const lines: string[] = [];
  lines.push(
    'For each keyword we extracted, we scored the top 10 incumbents (by num_favorers) against a 10-rule deterministic SEO rubric:'
  );
  lines.push(
    '  title_length, title_keyword_placement, tag_count, tag_quality, description_length,'
  );
  lines.push(
    '  description_keyword_in_preview, description_scannable_structure, shop_section_assigned,'
  );
  lines.push(
    '  attribute_fill_rate (skipped — needs taxonomy data), ai_disclosure_compliance (skipped — needs signature detection).'
  );
  lines.push('');
  lines.push(
    'Classifications: open_field (all top results <50%) > weak_incumbents (3+ <60%) > red_ocean (3+ ≥80%) > mixed.'
  );
  lines.push('');

  landscape.forEach((entry, i) => {
    lines.push(
      `[${i + 1}] keyword="${entry.keyword}" → ${entry.classification.toUpperCase()} (median ${(entry.median_percent * 100).toFixed(0)}%, n=${entry.scored_count})`
    );
    lines.push(`    ${entry.gap_summary}`);
    if (entry.top_incumbents.length > 0) {
      lines.push('    Top incumbents (by num_favorers):');
      entry.top_incumbents.forEach((inc, j) => {
        const weakStr =
          inc.weak_areas.length > 0
            ? ` | weak: ${inc.weak_areas.slice(0, 4).join(', ')}`
            : '';
        lines.push(
          `      ${j + 1}. ${inc.score}/${inc.max} (${(inc.percent * 100).toFixed(0)}%) — ${inc.title.slice(0, 110)}${weakStr}`
        );
      });
    }
    lines.push('');
  });

  return lines.join('\n');
}

function formatIncumbentIntel(
  offerings: IncumbentOffering[],
  buyerPainSignals: BuyerPainSignal[]
): string {
  if (offerings.length === 0) {
    return '(No incumbent product intelligence — treat product-gap axis as data-unavailable.)';
  }

  const lines: string[] = [
    'Pre-computed from Etsy listing details + review mining (Haiku).',
    'COPYRIGHT: buyer_pain_signals below are already paraphrased — copy them VERBATIM into differentiation_thesis.buyer_pain_signals. Do NOT add verbatim Etsy review quotes anywhere in the brief.',
    ''
  ];

  lines.push('== COMPETITOR PRODUCT FEATURES (top 3 incumbents) ==');
  offerings.forEach((o, i) => {
    const pf = o.product_features;
    lines.push(
      `[${i + 1}] incumbent_id=${o.incumbent_id} — ${o.title.slice(0, 100)}`
    );
    lines.push(`    sections: ${pf.sections.join('; ') || '(none stated)'}`);
    lines.push(`    sizes: ${pf.sizes.join(', ') || 'unknown'}`);
    lines.push(`    formats: ${pf.formats.join(', ') || 'unknown'}`);
    lines.push(`    style: ${pf.style_angle}`);
    lines.push(`    bundle: ${pf.bundle_composition}`);
    lines.push(`    price: ${pf.price_point}`);
    lines.push(
      `    distinguishing: ${pf.distinguishing_features.join('; ') || '(none)'}`
    );
    if (o.reviews_mined) {
      lines.push(
        `    reviews mined: ${o.reviews_mined.total_fetched} fetched, ${o.reviews_mined.signal_count} buyer-voice signals${o.reviews_mined.note ? ` (${o.reviews_mined.note})` : ''}`
      );
    }
    lines.push('');
  });

  lines.push('== BUYER PAIN SIGNALS (paraphrased themes — NEVER add verbatim review quotes) ==');
  if (buyerPainSignals.length === 0) {
    lines.push(
      '(No recurring pain themes extracted — either thin reviews or mostly positive feedback. State this honestly in our_differentiation if you cannot ground a product-level gap in review evidence.)'
    );
  } else {
    buyerPainSignals.forEach((s, i) => {
      lines.push(`[${i + 1}] theme="${s.theme}" — ${s.frequency_indicator}`);
      s.paraphrased_examples.forEach(ex => lines.push(`    - ${ex}`));
    });
  }

  return lines.join('\n');
}

export function buildSynthesisPrompt(
  decision: DecisionRecord,
  nicheMemory: NicheMemoryRow[],
  searchResults: EtsySearchResult[],
  aggregates: MarketAggregates,
  competitiveLandscape: CompetitiveLandscapeEntry[] = [],
  incumbentIntel: {
    offerings: IncumbentOffering[];
    buyer_pain_signals: BuyerPainSignal[];
  } = { offerings: [], buyer_pain_signals: [] }
): string {
  const ctx = decision.context;
  const source = typeof ctx['source'] === 'string' ? ctx['source'] : 'unknown';
  const subreddit =
    typeof ctx['subreddit'] === 'string' ? ctx['subreddit'] : '';
  const postUrl =
    typeof ctx['post_url'] === 'string' ? ctx['post_url'] : '';
  const score = typeof ctx['score'] === 'number' ? ctx['score'] : null;
  const nicheTag = subreddit || 'general';

  return `You are a senior product strategist for a digital printables business on Etsy. You are analyzing a buyer-intent signal and producing a structured product brief that downstream agents (design, listing, pricing) will USE LITERALLY to create and list a real product.

== DECISION ==
Title: ${decision.title}
Description: ${decision.description}
Urgency: ${decision.urgency}
Source: ${source}${subreddit ? ` (r/${subreddit})` : ''}
${postUrl ? `Original post: ${postUrl}` : ''}
${score !== null ? `Engagement: ${score} upvotes` : ''}

== NICHE MEMORY (niche_tag=${nicheTag}) ==
${formatNicheMemory(nicheMemory)}

== ETSY COMPETITIVE DATA (${searchResults.length} listings analyzed) ==
${formatEtsyResults(searchResults)}

== PRE-COMPUTED MARKET AGGREGATES ==
${formatAggregates(aggregates)}

Use these EXACT numerical values in the market_summary section of your output. Do not recalculate. Your job is qualitative synthesis: identify common_formats, common_features, opportunity_gaps, and notable_features per top seller from the raw listing data above.

== COMPETITIVE SEO LANDSCAPE (Tuning Pass 2 — supply-side gap analysis) ==
${formatCompetitiveLandscape(competitiveLandscape)}

This is the brain's strategic edge: demand × (1 / supply quality), not demand alone. Use these scores AS EVIDENCE in your reasoning and differentiation_angle:
- If the keyword classification is "weak_incumbents" or "open_field", you have a real opening even as a zero-review shop. CITE the specific weak areas (e.g., "top 3 results for 'X' average 52% — weak in description_length and shop_section_assigned") in brief.reasoning as concrete evidence for the proceed call.
- If classification is "red_ocean", lower your recommended confidence even when demand signals are strong — a 90% incumbent field is a meaningful headwind for HillwardStudio.
- The listing.differentiation_angle should be sharpened by the common weak_areas: if incumbents are missing FAQs, you have an FAQ angle; if they're under-titled, lean into a full 140-char title; if no shop sections, make sure to set one.
- Output the per-keyword classifications + top_incumbents VERBATIM as listing.competitive_landscape — do not invent or alter scores; they are the engine's deterministic output.

== PRODUCT-GAP INTELLIGENCE (Tuning Pass 3 — load-bearing differentiation thesis) ==
${formatIncumbentIntel(incumbentIntel.offerings, incumbentIntel.buyer_pain_signals)}

This is the SECOND strategic axis alongside SEO-gap: what incumbents actually SHIP vs what buyers WISH they shipped. The differentiation_thesis you output becomes a DESIGN CONSTRAINT on the asset — not just listing copy.

Rules for differentiation_thesis:
- competitor_offerings: copy incumbent_id + product_features from the COMPETITOR PRODUCT FEATURES section above (summarize the typical pattern in your reasoning, but preserve the structured objects).
- buyer_pain_signals: copy the paraphrased themes above VERBATIM. NEVER add verbatim Etsy review text or direct quotes.
- our_differentiation: MUST cite a SPECIFIC pain signal or incumbent product gap by name. Forbidden: generic claims ("more beautiful", "cleaner design", "better quality"). If review data is thin and you cannot ground a concrete product-level difference, say so honestly (e.g., "Insufficient review signal to support a product-level claim beyond SEO execution — differentiation is supply-side only").
- positioning: the buyer-facing angle (e.g., "ADHD-friendly with visual meal-type cues", "family-of-5 portion planning", "premium minimalist for design-conscious meal preppers").
- one_line_claim: single sentence suitable for the listing hook or title — must reflect our_differentiation specifically.

LOAD-BEARING ALIGNMENT (mandatory — a brief that ignores its own thesis is invalid):
- listing.differentiation_angle MUST align with differentiation_thesis.one_line_claim.
- listing.description.hook and listing.description.why_this_one MUST articulate the differentiation_thesis specifically — if why_this_one could apply to any competitor, rewrite it.
- listing.image_spec: every slot's purpose/style_notes MUST demonstrate the positioning (e.g., ADHD-friendly → show color-coded meal categories in hero; family-of-5 → show portion columns in whats_included graphic).
- listing.attribute_intent descriptors MUST reinforce positioning where Etsy taxonomy allows.
- product.design.required_elements MUST include the concrete product features that deliver our_differentiation (not generic "nice layout").
- product.format.includes MUST reflect the bundle composition implied by our_differentiation.

== EVALUATION RULES ==
Be skeptical. Your job is to make a real recommendation, not to please anyone.

- Recommend "proceed" ONLY if: there is a clear demand signal, saturation is manageable, AND you can identify a concrete differentiation angle.
- Recommend "pivot" if: there's a related product or angle from the data that's more promising than what the buyer literally asked for. Explain the pivot.
- Recommend "pass" if: the market is saturated with strong incumbents, demand is weak, or the niche shows known failure patterns.
- Set confidence honestly. Below 0.6 means you genuinely doubt the call. Above 0.85 means the data is clear and supportive.

NEW SHOP CONTEXT — HillwardStudio is a new Etsy shop with zero reviews. Every analysis must account for the social proof gap: a buyer choosing between a 0-review shop and a 6,000-16,000-review shop will default to the established shop unless the new shop offers compelling differentiation. This affects:
- Pricing: aggressive low pricing helps overcome the reputation gap by reducing buyer risk perception
- Listing strategy: lean hard on the differentiation angle — generic listings have no chance against established sellers
- Risk severity: what would be "medium" competition risk for an established shop is "high" for a new shop with no reviews
- Recommendation threshold: be stricter on PROCEED when competing against shops with 5,000+ reviews on similar offerings; recommend PIVOT if differentiation isn't sharp enough to overcome reputation deficit

PRICING STRATEGY — explicit choice required:
You must explicitly choose between volume pricing (price low, win on units sold) and premium pricing (price up, win on margin per unit). Cite specific competitive evidence for the choice — e.g., "MyLifePlans at $1.80 with 16,218 reviews validates volume strategy in this niche" or "top-tier sellers cluster at $7-12 with strong reviews, suggesting premium bundle pricing wins here." Do not silently default to bundle-premium without engaging what the market data shows about which strategy wins in this category. State the chosen strategy explicitly in pricing.reasoning (e.g., "Volume strategy: priced at $X to undercut median while preserving margin" or "Premium bundle strategy: positioned at $X between P50 and P75 because scope justifies higher price than single-purpose listings").

MVP SCOPING for first-in-niche products:
Unless niche memory shows the exact buyer-product fit has been validated in market (evidence_count ≥ 3 on the relevant opportunity_gap AND a prior brief in this niche reached brief_ready), prefer MVP scope for the product specification:
- 1-2 sizes (the most common in the niche per competitive data), not 4
- Undated only (no time-decay risk if launch slips past Q1)
- Modest deliverable count (~20-40 pages for documents, 1 file for art/SVG, ~6-12 variants for SVG bundles)
- Core deliverable only — list "v2 expansion candidates" in market_summary.opportunity_gaps rather than baking them into v1.product.includes
Per principle 7 (build → validate → automate), a leaner first product gets to market faster and lets the system validate the niche before investing in expanded scope.

== QUALITY REQUIREMENTS ==
Downstream agents consume these fields VERBATIM. Specifics matter.
- "product.design.palette" feeds the design agent's image-generation prompt — give 6-8 real hex codes.
- "listing.etsy_tags" goes directly into the Etsy listing — each tag must be ≤20 chars, real Etsy search terms.
- "pricing.recommended" sets the actual listing price — must reference the competitive data's quartiles.
- "product.format.includes" defines the deliverable — list concrete files/pages.
- "market_summary.opportunity_gaps" feeds niche memory and future product decisions.
- Numbers come from the pre-computed aggregates above — use them verbatim.

== TUNING PASS 2 — STRUCTURED LISTING.DESCRIPTION ==
The legacy listing.description_angles array is no longer the publish-time artifact; it stays only as a short summary of the strongest 3-5 angles. The actual description body that the Listing Agent will render to Etsy is listing.description, a structured object. Quality bar:

- listing.description.hook: 130-160 chars, single sentence. MUST contain listing.primary_keyword verbatim (or its core phrase) within those 160 chars — this is the snippet Etsy renders in search results. Name the buyer's specific pain alongside the keyword. Examples of the pattern (use as STRUCTURE reference; write your own copy for THIS product):
  - "The A5 monthly calendar printable for planner people tired of daily and weekly grids they never use — month-to-month plus three note styles in one PDF."
  - "A vintage nursery wall art printable in a gender-neutral palette with storybook softness — five sizes, instant download, ready to frame today."

- listing.description.why_this_one: 2-4 sentences. Render the differentiation_angle as a paragraph. Weave in 1-2 supporting_keywords naturally. If the competitive_landscape shows weak incumbents, this paragraph is where the buyer feels the gap being closed. Match the tone of the hook — calm, confident, not promotional.

- listing.description.whats_included: bulleted list. Pull VERBATIM from product.format.includes — same items, same order. Do NOT re-phrase. The Listing Agent renders each item as a "- item" line; do not include the dash yourself.

- listing.description.print_sizes: OPTIONAL. Wall-art or other multi-size products only. Each entry is one print size with a one-line use-context (e.g. "8x10\\" — cozy bedside or shelf scale"). Omit entirely (set to null) for single-size products like planners.

- listing.description.how_it_works: 3-5 numbered steps walking through download → print/use → display. Digital-product specific. The Listing Agent renders each as "1. step" so do not number the strings yourself.

- listing.description.faq: 5-7 Q/A entries. The FIRST 2-3 Qs MUST map to brief.risks entries whose nature is customer-facing (IP-protection → "Is this an original illustration?"; page-count perception → "Will N pages be enough?"; dating concerns → "Is this dated for a specific year?"). The remaining Qs cover standard digital-product friction: software needed, home printing, shipping, gift use. Each Q starts with "Q. ", each A starts with "A. ".

- listing.description.closing: 1-2 sentences. Generic shop closing usable across all HillwardStudio products — do NOT enumerate product categories (no "planner inserts and nursery prints"). The standard line is: "Thanks for stopping by HillwardStudio. Every piece in the shop is designed with the same intention — quiet, considered, and built to earn its place rather than disappear into a download folder." Use this exact line for all v2 briefs unless you have a specific better fit.

- listing.description.attribute_vocabulary: 6-10 short terms that appear consistently across title + etsy_tags + attribute_intent + hook. Cross-field repetition is itself an SEO signal; this list makes the repetition explicit. Example for nursery print: ["vintage", "watercolor", "gender neutral", "nursery", "printable", "cottagecore", "heirloom"].

== TUNING PASS 2 — listing.attribute_intent (SEMANTIC ONLY) ==
This is a CONTRACT CHANGE. The Research Agent NEVER enumerates store-specific raw attribute values (no "Babies", no "Cottagecore", no "Digital Download"). Etsy attribute schemas vary by taxonomy node — Recipient doesn't exist on Digital Prints, Materials is constrained-vocabulary on planners. Hardcoding raw values at brief time costs real edit time.

Instead, emit SEMANTIC descriptors. The Listing Agent looks them up against each store's live possible_values response and either substitutes the closest semantic match or leaves the slot blank.

- style_descriptors: 3-6 lowercase style descriptors (e.g. ["vintage", "cottagecore", "watercolor"])
- audience_descriptors: 2-4 buyer-facing audience descriptors (e.g. ["babies", "gender-neutral", "new parents"])
- occasion_descriptors: 2-4 use-occasion descriptors (e.g. ["baby shower", "newborn gift", "nursery decor"])
- color_descriptors: 3-5 color/palette descriptors (e.g. ["warm neutral", "sage green", "off-white"])
- materials_intent: 2-4 medium descriptors (e.g. ["digital download", "printable", "watercolor illustration"])

== TUNING PASS 2 — listing.image_spec (≥4 entries) ==
Explicit slot manifest the future Listing Agent walks. Cover at minimum: 1 hero, 1 lifestyle, 1 whats_included graphic, 1 size_grid (wall art) OR 1 lifestyle_detail (other categories). Each entry:
- kind: one of "hero" | "lifestyle" | "whats_included" | "size_grid" | "lifestyle_detail"
- purpose: one sentence on what the image must communicate
- dims_recommended: free-form spec (e.g. "2000×2000 px square" or "1500×2000 px portrait")
- style_notes: 1-2 sentences on tone / composition / what to reference

== TUNING PASS 2 — listing.shop_section_suggestion ==
A single name string (e.g. "Nursery Wall Art" or "Planner Inserts"). The Listing Agent matches this against the shop's existing sections; creates a new one if absent and well-formed.

== TUNING PASS 2 — audience persona ==
Top-level audience object, three fields:
- persona: 1-2 sentences naming the buyer archetype (e.g. "The A5 binder minimalist — planner enthusiasts on r/planneraddicts who already own a Filofax or Kikki-K and are tired of inserts cluttered with daily/weekly grids they don't use.").
- primary_search_intent: 1 sentence on what the buyer is literally typing into Etsy and why (e.g. "Searching 'A5 monthly insert' because they want the calendar-only flexibility their current daily-focused inserts don't give.").
- decision_factors: 3-5 short phrases capturing what tips this buyer from browsing to buying (e.g. ["both week-start variants included", "undated so it never expires", "warm-neutral aesthetic, not floral", "fits Filofax A5 spacing", "instant download"]).

Drives description voice and informs every attribute_intent + image_spec choice.

== LISTING STRATEGY RULES ==
Titles describe what the product IS, not what it ISN'T. When the buyer expresses pain negatively ("I don't want X"), translate it into positive product language (what the product offers that solves the pain). Negative framing in titles ("NOT a X", "no Y", "without Z") is FORBIDDEN — it wastes keyword space matching against the thing buyers don't want, sounds defensive, and is unusual seller language on Etsy.

Examples of the pattern (illustrative, not templates — adapt to the specific buyer pain):
- Buyer pain: "I don't want a daily planner" → title language: "Month-at-a-Glance", "Monthly-Focused", "Big-Picture Planning"
- Buyer pain: "too cluttered with decorations" → title language: "Clean Minimalist", "Streamlined", "Editorial Style"
- Buyer pain: "I hate that they require Cricut Access" → title language: "Standalone SVG", "Works Without Subscription", "Open-Format Files"
- Buyer pain: "everything is for kids, I want adult coloring" → title language: "Adult-Audience", "Sophisticated Designs", "Grown-Up Coloring"

The same positive-framing rule applies to etsy_tags — only positive keywords, never negations.

The description_angles array CAN quote buyer pain directly ("You shouldn't have to piece together separate listings...") since descriptions are conversational and convert better with pain-acknowledgment. Pain quotation belongs in descriptions, not titles.

== RISK MITIGATIONS RULES ==
Risk mitigations must not recommend tactics that violate platform or community rules. Specifically:
- Do NOT suggest cross-posting the finished product to the originating subreddit. Most planner/Etsy/craft subreddits prohibit self-promotion in their rules; posting will get the seller banned and damages reputation.
- Do NOT suggest fake reviews, keyword stuffing, or copying competitor listings.
SAFE growth tactics: long-tail SEO via title and tags, listing photo quality, listing copy speaking to buyer pain, Pinterest, paid Etsy ads, building reviews via initial low-price strategy or transparent friends-and-family early purchases.

== OUTPUT SCHEMA ==
Return EXACTLY this structure as raw JSON. No markdown fences. No prose. No preamble. The first character of your response must be "{".

{
  "recommendation": "proceed" | "pivot" | "pass",
  "confidence": <number 0.0-1.0>,
  "reasoning": "<2-4 sentences. Cite specific data points from above, including AT LEAST ONE competitive_landscape figure AND AT LEAST ONE product-gap signal (incumbent feature pattern or buyer pain theme).>",
  "differentiation_thesis": {
    "competitor_offerings": [
      { "incumbent_id": "<string>",
        "product_features": {
          "sections": ["..."],
          "sizes": ["..."],
          "formats": ["..."],
          "style_angle": "...",
          "bundle_composition": "...",
          "price_point": "...",
          "distinguishing_features": ["..."]
        }
      }
    ],
    "buyer_pain_signals": [
      { "theme": "...",
        "frequency_indicator": "...",
        "paraphrased_examples": ["<NEVER verbatim review text>"] }
    ],
    "our_differentiation": "<specific, concrete, grounded in pain signals or incumbent gaps — honest if unsupported>",
    "positioning": "<buyer-facing angle>",
    "one_line_claim": "<single sentence for hook/title>"
  },
  "audience": {
    "persona": "<1-2 sentences naming the buyer archetype>",
    "primary_search_intent": "<1 sentence on what they're typing into Etsy and why>",
    "decision_factors": ["<3-5 short phrases capturing what tips browse → buy>"]
  },
  "product": {
    "name": "<short product name, ~3-6 words>",
    "format": {
      "file_type": "PDF" | "PNG" | "JPG" | "SVG" | "ZIP",
      "sizes": ["<use sizes buyers in this niche actually search for, based on the competitive data; planners use A5/A4/Letter/Half, wall art uses imperial print sizes like 16x20\"/8x10\"/11x14\", SVG files specify resolution and cut compatibility — adapt to the niche, don't impose planner conventions on non-planner products>"],
      "orientation": "portrait" | "landscape" | "both",
      "page_count": <integer — for multi-page documents: total pages; for single-file deliverables like wall art: 1; for SVG/cutting bundles: number of distinct design variants; match the unit type that makes sense for the deliverable category>,
      "includes": ["<list concrete deliverable items at the granularity buyers care about; for planners: 'undated monthly calendar (Sunday start)', 'lined notes pages'; for wall art: '5 size variations', 'PDF and PNG formats'; for SVG: '12 design variants', 'SVG/DXF/PNG/EPS files'>"]
    },
    "design": {
      "style": "<one phrase, e.g. 'minimalist scandinavian' or 'boho watercolor'>",
      "palette": ["<6-8 hex color codes like #F5E6D3>"],
      "mood_keywords": ["<3-5 evocative words>"],
      "typography": "<font direction, e.g. 'modern sans-serif with handwritten accents'>",
      "reference_descriptions": ["<2-3 visual references in plain words>"],
      "required_elements": ["<concrete features the design must include>"]
    }
  },
  "listing": {
    "title_template": "<full Etsy title, ~140 chars, real seller language>",
    "primary_keyword": "<main search term>",
    "supporting_keywords": ["<3-5 secondary keywords>"],
    "etsy_tags": ["<up to 13 Etsy tags, each ≤20 chars>"],
    "etsy_category": "<Etsy category path, e.g. 'Paper & Party Supplies > Paper > Calendars & Planners'>",
    "description_angles": ["<LEGACY field — 3-5 single-line angle summaries. Kept for backward compat; the publishable body now lives in listing.description below.>"],
    "differentiation_angle": "<the ONE thing this product does that competitors don't — should be reinforced by the competitive_landscape gap_summaries above>",
    "description": {
      "hook": "<130-160 chars, single sentence, primary_keyword inside, names buyer pain>",
      "why_this_one": "<2-4 sentences rendering differentiation_angle as a paragraph; woven with supporting_keywords>",
      "whats_included": ["<bullets — VERBATIM from product.format.includes; no leading dashes>"],
      "print_sizes": ["<OPTIONAL — wall art / multi-size only; format like '8x10\\\" — cozy bedside or shelf scale'; OMIT entirely if not applicable>"],
      "how_it_works": ["<3-5 steps; do not number; renderer will>"],
      "faq": [
        { "q": "<Q. ...>", "a": "<A. ...>" }
      ],
      "closing": "<Use exactly: 'Thanks for stopping by HillwardStudio. Every piece in the shop is designed with the same intention — quiet, considered, and built to earn its place rather than disappear into a download folder.' — unless a clearly better fit exists for this specific product>",
      "attribute_vocabulary": ["<6-10 short terms that recur across title + tags + attribute_intent + hook for cross-field consistency>"]
    },
    "attribute_intent": {
      "style_descriptors": ["<3-6 SEMANTIC style descriptors (lowercase)>"],
      "audience_descriptors": ["<2-4 SEMANTIC audience descriptors>"],
      "occasion_descriptors": ["<2-4 SEMANTIC occasion descriptors>"],
      "color_descriptors": ["<3-5 SEMANTIC color descriptors>"],
      "materials_intent": ["<2-4 SEMANTIC medium descriptors>"]
    },
    "image_spec": [
      { "kind": "hero" | "lifestyle" | "whats_included" | "size_grid" | "lifestyle_detail",
        "purpose": "<1 sentence on what this image must communicate>",
        "dims_recommended": "<free-form spec, e.g. '2000×2000 px square'>",
        "style_notes": "<1-2 sentences on tone / composition>" }
    ],
    "shop_section_suggestion": "<single name string, e.g. 'Nursery Wall Art'>",
    "competitive_landscape": [
      { "keyword": "<verbatim from the COMPETITIVE SEO LANDSCAPE input above>",
        "classification": "red_ocean" | "mixed" | "weak_incumbents" | "open_field",
        "top_incumbents": [
          { "listing_id": "<string>", "title": "<string>", "score": <int>, "max": <int>, "percent": <0-1 float>, "weak_areas": ["..."] }
        ],
        "gap_summary": "<copy the engine's gap_summary verbatim>" }
    ]
  },
  "pricing": {
    "recommended": <usd>,
    "floor": <usd>,
    "ceiling": <usd>,
    "reasoning": "<1-2 sentences citing the competitive quartile data>"
  },
  "market_summary": {
    "saturation": "low" | "medium" | "high",
    "listings_analyzed": <integer matching the data above>,
    "median_price": <usd>,
    "price_range": { "p25": <usd>, "p50": <usd>, "p75": <usd> },
    "median_favorers": <integer>,
    "top_sellers": [
      {
        "shop_name": "<verbatim from pre-computed aggregates>",
        "shop_url": "<verbatim from pre-computed aggregates>",
        "listing_title": "...",
        "listing_url": "...",
        "price": <usd>,
        "num_favorers": <integer>,
        "shop_review_count": <integer matching pre-computed, omit if unavailable>,
        "shop_review_average": <0-5 number matching pre-computed, omit if unavailable>,
        "notable_features": ["..."]
      }
    ],
    "common_formats": ["<format patterns repeated across listings>"],
    "common_features": ["<recurring product features>"],
    "opportunity_gaps": ["<things competitors are NOT doing — these become niche memory>"]
  },
  "risks": [
    { "description": "...", "severity": "low" | "medium" | "high", "mitigation": "..." }
  ]
}

Return ONLY the JSON object.`;
}
