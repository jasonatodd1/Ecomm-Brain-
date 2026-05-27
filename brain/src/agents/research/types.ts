// Output schema produced by the Research Agent.
// Downstream agents (design, listing, pricing) consume these fields literally —
// changing field names or shapes here breaks the contract with downstream agents.
//
// Schema versions in active use:
//   research-v1 — fields up through `risks`. The first 5 briefs use this.
//   research-v2 (Tuning Pass 2) — adds `audience`, `listing.description`,
//     `listing.attribute_intent`, `listing.image_spec`,
//     `listing.shop_section_suggestion`, `listing.competitive_landscape`.
//   research-v3 — adds `differentiation_thesis` (product-gap axis): incumbent
//     product features + paraphrased buyer pain signals + load-bearing
//     our_differentiation / positioning / one_line_claim. Downstream brief
//     fields (description, image_spec, attribute_intent) MUST reflect the thesis.
//   research-v3.1 — relevance-filtered product-gap selection (Haiku classifier
//     on cross-keyword candidate pool); adds `relevance_filter` to thesis.
//     SEO-gap output unchanged from v3.
//   research-v3.2 — multi-wedge differentiation: `differentiation_thesis.wedges[]`
//     with per-wedge grounding tags (buyer-voice-backed / partial-buyer-voice-backed
//     / incumbent-inferred / speculative). Discipline: every wedge cites its
//     supporting_evidence + (when present) counter_evidence. our_differentiation
//     becomes the unified summary across wedges.
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
      /**
       * Free-text list of what's included, as it reads on the Etsy listing.
       * Legacy v1 field; preferred for buyer-facing copy. Listing Agent
       * still emits this verbatim. To match brief claims against what the
       * asset pipeline can actually produce on disk, also populate
       * `deliverables` (added in Tuning Pass 2).
       */
      includes: string[];
      /**
       * Structured deliverable manifest — added in Tuning Pass 2.
       * Each entry names a known artifact kind the asset pipeline can
       * deterministically produce (see `brain/src/tools/build-print-bundle.ts`
       * and `brain/src/lib/print-bundle.ts`). The Listing Agent uses this
       * to verify, before publishing, that every claimed deliverable
       * actually exists on disk under `products/<slug>/deliverables/`.
       *
       * Kinds (current pipeline produces all of these for ≥5008×6680 masters):
       *   - 'master_jpg'        — full-resolution print-ready JPG at 300 DPI
       *   - 'sized_jpg_set'     — the 5 imperial print sizes (8×10…24×36)
       *   - 'print_bundle_pdf'  — multi-page PDF with crop marks per size
       *   - 'transparent_png'   — background-removed PNG via fal birefnet/v2
       *   - 'ratio_guide_pdf'   — single-page sizes + ratios + frame reference
       *
       * Optional in the type for back-compat with the first 5 (v1) briefs.
       * v2+ wall-art briefs should populate this whenever they want the
       * pipeline-as-contract guarantee.
       */
      deliverables?: Array<{
        kind:
          | 'master_jpg'
          | 'sized_jpg_set'
          | 'print_bundle_pdf'
          | 'transparent_png'
          | 'ratio_guide_pdf';
        /** Optional one-line description shown in the brief renderer. */
        description?: string;
      }>;
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

  /**
   * Product-level differentiation thesis — research-v3.
   * Load-bearing design constraint: downstream fields (description.hook,
   * description.why_this_one, image_spec, attribute_intent, product.design)
   * must reflect this thesis, not generic positioning.
   * buyer_pain_signals use paraphrased examples ONLY — never verbatim review text.
   */
  differentiation_thesis?: DifferentiationThesis;
};

export interface ProductFeatures {
  sections: string[];
  sizes: string[];
  formats: string[];
  style_angle: string;
  bundle_composition: string;
  price_point: string;
  distinguishing_features: string[];
}

export interface IncumbentOffering {
  incumbent_id: string;
  title: string;
  product_features: ProductFeatures;
  /** Operational metadata from review mining — not buyer-facing copy. */
  reviews_mined?: {
    total_fetched: number;
    signal_count: number;
    note?: string;
  };
  /**
   * Why the relevance classifier kept this incumbent in the product-gap set
   * (research-v3.1+). Absent on briefs from v3 where selection was top-by-favorers only.
   */
  relevance_reason?: string;
}

export interface BuyerPainSignal {
  theme: string;
  frequency_indicator: string;
  /** Paraphrased buyer-voice examples — NEVER verbatim Etsy review text. */
  paraphrased_examples: string[];
}

/**
 * Wedge type taxonomy (research-v3.2). Extend cautiously — every new value
 * is a contract change. Current values:
 *   - workflow:      structural / use-pattern differentiation (e.g. single-page tear-off)
 *   - customization: modality or flexibility wedge (e.g. pen-and-paper vs locked spreadsheet)
 *   - aesthetic:     visual / brand-design wedge
 *   - audience:      sub-audience specialization (e.g. ADHD-friendly, family-of-5)
 *   - pricing:       price-strategy wedge (rare; usually a tactic, not a thesis)
 *   - other:         escape hatch — should round-trip into a new typed value before reuse
 */
export type WedgeType =
  | 'workflow'
  | 'customization'
  | 'aesthetic'
  | 'audience'
  | 'pricing'
  | 'other';

/**
 * Per-wedge grounding tag (research-v3.2). Discipline rule: the strongest
 * grounding a wedge can claim is the strongest tier the evidence supports.
 *   - buyer-voice-backed:         ≥2 pain themes directly support the wedge claim
 *   - partial-buyer-voice-backed: 1 strong + ≥1 partial OR 2+ partial supports
 *   - incumbent-inferred:         no buyer-voice support; grounded in observed incumbent gaps
 *   - speculative:                neither buyer voice nor concrete incumbent gap — hypothesis only
 */
export type WedgeGrounding =
  | 'buyer-voice-backed'
  | 'partial-buyer-voice-backed'
  | 'incumbent-inferred'
  | 'speculative';

export interface DifferentiationWedge {
  type: WedgeType;
  grounding: WedgeGrounding;
  /** Concrete claim, single sentence. */
  claim: string;
  /** Pain theme labels and/or incumbent gap labels that back this wedge. */
  supporting_evidence: string[];
  /**
   * Pain themes or incumbent observations that ARGUE AGAINST this wedge —
   * required when present in the data. Hiding counter-evidence violates the
   * grounding discipline. Absent only when no counter-evidence exists.
   */
  counter_evidence?: string[];
}

export interface RelevanceClassification {
  listing_id: string;
  title: string;
  num_favorers: number | null;
  relevant: boolean;
  reason: string;
}

export interface RelevanceFilterReport {
  candidate_pool_size: number;
  classified_count: number;
  kept_count: number;
  dropped_count: number;
  /** True when we exhausted the pool without reaching the relevance target. */
  pool_exhausted: boolean;
  /** "high" (≥30 total signal-eligible reviews), "medium" (10-29), "low" (<10). */
  data_thinness: 'high' | 'medium' | 'low';
  classifications: RelevanceClassification[];
}

export interface DifferentiationThesis {
  /** Typical offering pattern across relevance-filtered incumbents. */
  competitor_offerings: Array<{
    incumbent_id: string;
    product_features: ProductFeatures;
    relevance_reason?: string;
  }>;
  buyer_pain_signals: BuyerPainSignal[];
  /**
   * Multi-wedge thesis (research-v3.2+). Each wedge carries its own grounding
   * tag so future readers see at a glance what's buyer-voice-backed vs
   * incumbent-inferred — discipline does not depend on careful prose. Order
   * matters: lead wedge first (the one that drives the hook).
   * Absent on v3 / v3.1 briefs.
   */
  wedges?: DifferentiationWedge[];
  /**
   * Unified summary across all wedges. v3 / v3.1: prefix-tagged inline
   * (e.g. "(incumbent-inferred: …)"). v3.2+: free-form summary; per-wedge
   * grounding lives in `wedges[]` instead.
   */
  our_differentiation: string;
  positioning: string;
  one_line_claim: string;
  /**
   * Operator-facing transparency on how the product-gap incumbent set was selected
   * (research-v3.1+). Absent on briefs from v3.
   */
  relevance_filter?: RelevanceFilterReport;
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
