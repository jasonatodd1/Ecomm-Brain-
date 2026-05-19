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
    return '(No listings with complete price + review data — competitive aggregates unavailable. Note this in your reasoning and risks.)';
  }

  const lines: string[] = [
    `listings_analyzed: ${aggregates.listings_analyzed}`,
    `median_price: $${aggregates.median_price.toFixed(2)}`,
    `price_range: P25=$${aggregates.price_range.p25.toFixed(2)}, P50=$${aggregates.price_range.p50.toFixed(2)}, P75=$${aggregates.price_range.p75.toFixed(2)}`,
    `median_review_count: ${aggregates.median_review_count}`,
    '',
    'top_sellers (sorted by review count, with notable_features left for you to fill):'
  ];

  aggregates.top_sellers.forEach((s, i) => {
    lines.push(
      `${i + 1}. ${s.shop_name} | ${s.listing_title} | $${s.price.toFixed(2)} | ${s.review_count} reviews | ${s.listing_url}`
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
      const rating = r.rating !== null ? `${r.rating}★` : 'no rating';
      const reviews = r.reviews !== null ? `${r.reviews} reviews` : '0 reviews';
      return `[${i + 1}] ${r.title}
    shop=${r.shop_name} | ${price} | ${rating} | ${reviews}
    listing=${r.url}`;
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

== QUALITY REQUIREMENTS ==
Downstream agents consume these fields VERBATIM. Specifics matter.
- "product.design.palette" feeds the design agent's image-generation prompt — give 6-8 real hex codes.
- "listing.etsy_tags" goes directly into the Etsy listing — each tag must be ≤20 chars, real Etsy search terms.
- "pricing.recommended" sets the actual listing price — must reference the competitive data's quartiles.
- "product.format.includes" defines the deliverable — list concrete files/pages.
- "market_summary.opportunity_gaps" feeds niche memory and future product decisions.
- Numbers come from the pre-computed aggregates above — use them verbatim.

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
      "sizes": ["<sizes the buyer would expect, e.g. 'A5', 'US Letter', '8.5x11'>"],
      "orientation": "portrait" | "landscape" | "both",
      "page_count": <integer>,
      "includes": ["<concrete deliverable items, one per string>"]
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
    "median_review_count": <integer>,
    "top_sellers": [
      {
        "shop_name": "...",
        "shop_url": "...",
        "listing_title": "...",
        "listing_url": "...",
        "price": <usd>,
        "review_count": <integer>,
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
