// Output schema produced by the Research Agent.
// Downstream agents (design, listing, pricing) consume these fields literally —
// changing field names or shapes here breaks the contract with downstream agents.
//
// Schema versions in active use:
//   research-v1 — fields up through `risks`. The first 5 briefs use this.
//   research-v2 (Tuning Pass 2) — adds `audience`, `listing.description`,
//     `listing.attribute_intent`, `listing.image_spec`,
//     `listing.shop_section_suggestion`, `listing.competitive_landscape`.
//     Backward-compat: `listing.description_angles` is preserved (legacy);
//     downstream agents should prefer `listing.description` when present and
//     fall back to `listing.description_angles` otherwise.

export type ProductBrief = {
  recommendation: 'proceed' | 'pivot' | 'pass';
  confidence: number;
  reasoning: string;

  /**
   * Audience persona — added in Tuning Pass 2 (research-v2).
   * Optional in the type to preserve compatibility with existing v1 briefs.
   * The synthesis prompt requires it for v2 briefs; the renderer tolerates absence.
   */
  audience?: {
    persona: string;
    primary_search_intent: string;
    decision_factors: string[];
  };

  product: {
    name: string;
    format: {
      file_type: 'PDF' | 'PNG' | 'JPG' | 'SVG' | 'ZIP';
      sizes: string[];
      orientation: 'portrait' | 'landscape' | 'both';
      page_count: number;
      includes: string[];
    };
    design: {
      style: string;
      palette: string[];
      mood_keywords: string[];
      typography: string;
      reference_descriptions: string[];
      required_elements: string[];
    };
  };

  listing: {
    title_template: string;
    primary_keyword: string;
    supporting_keywords: string[];
    etsy_tags: string[];
    etsy_category: string;
    /**
     * Legacy v1 field — kept for backward compatibility with the first 5 briefs.
     * v2+ briefs should populate `listing.description` instead and use this
     * field only as a short prose summary of the strongest angles.
     */
    description_angles: string[];
    differentiation_angle: string;

    /**
     * Structured description — added in Tuning Pass 2 (research-v2).
     * Rendered to Etsy plaintext by `renderBriefAsEtsyDescription`.
     */
    description?: {
      /** 130-160 chars. Primary keyword must appear inside. */
      hook: string;
      why_this_one: string;
      whats_included: string[];
      /** Wall-art / multi-size products only. */
      print_sizes?: string[];
      how_it_works: string[];
      /** 5-7 entries; first 2-3 derived from `brief.risks` customer-facing concerns. */
      faq: Array<{ q: string; a: string }>;
      closing: string;
      /**
       * Vocabulary the listing should reinforce across title + tags +
       * attribute_intent + description hook for cross-field SEO consistency.
       */
      attribute_vocabulary: string[];
    };

    /**
     * Semantic attribute intent — added in Tuning Pass 2 (research-v2).
     * SEMANTIC descriptors only. Never raw store-specific values. The Listing
     * Agent maps these to each store's live `possible_values` per
     * LISTING_AGENT_REQUIREMENTS.md §4.
     */
    attribute_intent?: {
      style_descriptors: string[];
      audience_descriptors: string[];
      occasion_descriptors: string[];
      color_descriptors: string[];
      materials_intent: string[];
    };

    /**
     * Image slot manifest — added in Tuning Pass 2 (research-v2).
     * Minimum 4 entries. Listing Agent walks this list and either references
     * matching assets or auto-triggers generation per
     * LISTING_AGENT_REQUIREMENTS.md §5.
     */
    image_spec?: Array<{
      kind:
        | 'hero'
        | 'lifestyle'
        | 'whats_included'
        | 'size_grid'
        | 'lifestyle_detail';
      purpose: string;
      /** Free-form spec like "2000×2000 px square" or "1500×2000 px portrait". */
      dims_recommended: string;
      style_notes: string;
    }>;

    /**
     * Shop section name suggestion — added in Tuning Pass 2 (research-v2).
     * Listing Agent matches against shop's existing sections; creates if absent
     * and well-formed.
     */
    shop_section_suggestion?: string;

    /**
     * Competitive SEO landscape — added in Tuning Pass 2 (research-v2).
     * One entry per keyword the agent searched. See COMPETITIVE_SEO_SCORING.md §4.
     */
    competitive_landscape?: Array<{
      keyword: string;
      classification:
        | 'red_ocean'
        | 'mixed'
        | 'weak_incumbents'
        | 'open_field';
      top_incumbents: Array<{
        listing_id: string;
        title: string;
        score: number;
        max: number;
        percent: number;
        weak_areas: string[];
      }>;
      gap_summary: string;
    }>;
  };

  pricing: {
    recommended: number;
    floor: number;
    ceiling: number;
    reasoning: string;
  };

  market_summary: {
    saturation: 'low' | 'medium' | 'high';
    listings_analyzed: number;
    median_price: number;
    price_range: { p25: number; p50: number; p75: number };
    median_favorers: number;
    top_sellers: Array<{
      shop_name: string;
      shop_url: string;
      listing_title: string;
      listing_url: string;
      price: number;
      num_favorers: number;
      shop_review_count?: number;
      shop_review_average?: number;
      notable_features: string[];
    }>;
    common_formats: string[];
    common_features: string[];
    opportunity_gaps: string[];
  };

  risks: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
  }>;
};

export interface DecisionRecord {
  id: string;
  title: string;
  description: string;
  context: Record<string, unknown>;
  urgency: string;
  status: string;
}

export interface EtsySearchResult {
  listing_id: number;
  shop_id: number;
  title: string;
  price: number | null;
  currency: string;
  url: string;
  num_favorers: number | null;
  description_preview: string;
}

export interface NicheMemoryRow {
  niche_tag: string | null;
  memory_key: string | null;
  memory_value: Record<string, unknown> | null;
  confidence: number | null;
  source: string | null;
  evidence_count: number | null;
  last_updated_at: string | null;
}
