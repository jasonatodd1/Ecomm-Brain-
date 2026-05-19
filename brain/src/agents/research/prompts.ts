import type {
  DecisionRecord,
  EtsySearchResult,
  NicheMemoryRow
} from './types.js';
import type { MarketAggregates } from './aggregates.js';

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

export function buildSynthesisPrompt(
  decision: DecisionRecord,
  nicheMemory: NicheMemoryRow[],
  searchResults: EtsySearchResult[],
  aggregates: MarketAggregates
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
  "reasoning": "<2-4 sentences. Cite specific data points from above.>",
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
    "description_angles": ["<3-5 selling angles for the listing description>"],
    "differentiation_angle": "<the ONE thing this product does that competitors don't>"
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
