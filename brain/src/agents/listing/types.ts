// Listing Agent output schema.
//
// `PublishPackage` is the single artifact the v1 Listing Agent produces: a
// store-validated, attribute-mapped, image-manifested, SEO-scored draft that
// an operator reviews before manually publishing on Etsy. v2 / Phase 2 will
// add OAuth + auto-publish; the package shape is forward-compatible.
//
// Cross-references:
//   - PublishPackage.attributes  → LISTING_AGENT_REQUIREMENTS.md §4 + §5
//   - PublishPackage.image_manifest → LISTING_AGENT_REQUIREMENTS.md §5
//   - PublishPackage.seo_score / incumbent_benchmark → COMPETITIVE_SEO_SCORING.md §5

import type { SeoScore } from '../../lib/etsy-seo-scoring.js';
import type { AssetKind } from '../../lib/assets.js';

export type Store = 'etsy';

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------
export interface AttributeAssignment {
  /** Etsy property name as returned by getTaxonomyProperties (e.g. "Home style"). */
  property_name: string;
  /** Etsy property_id (e.g. 145330288652). */
  property_id: number;
  /** Final value(s) written to Etsy. Multi-valued properties carry multiple. */
  values: Array<{
    value: string;
    value_id: number;
    was_substituted: boolean;
    /** Which descriptor in attribute_intent produced this value. */
    matched_from: string;
    /** "exact" | "token" | "semantic" — confidence tier from attribute-mapping.ts. */
    confidence: 'exact' | 'token' | 'semantic';
    /** Human-readable explanation. */
    reason: string;
  }>;
  /** Convenience: true if any value was substituted. Drives operator-review markdown. */
  any_substituted: boolean;
}

export interface AttributeSkip {
  property_name: string;
  property_id: number;
  /** "missing_property" — slot doesn't exist for this taxonomy.
   *  "no_match"           — descriptors had no acceptable match in possible_values. */
  reason: 'missing_property' | 'no_match' | 'free_text_not_mapped';
  /** Helpful detail (e.g. "descriptors tried: babies, new parents, gender-neutral"). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Image manifest
// ---------------------------------------------------------------------------
export interface ImageSlot {
  /** Etsy listing-photo slots are 1..10. 1 is the hero. */
  slot: number;
  kind: AssetKind;
  status: 'ready' | 'missing';
  /** Set when status === 'ready'. */
  asset_id?: string;
  asset_path?: string;
  asset_width?: number;
  asset_height?: number;
  asset_source?: string;
  /** Set when status === 'missing'. Operator-actionable hint. */
  generation_hint?: string;
  /** Brief's image_spec entry that drove the slot (for renderer cross-reference). */
  spec?: {
    purpose: string;
    dims_recommended: string;
    style_notes: string;
  };
}

// ---------------------------------------------------------------------------
// Incumbent benchmark (consumes brief.listing.competitive_landscape)
// ---------------------------------------------------------------------------
export interface IncumbentBenchmark {
  /** The keyword whose top incumbents we measure against. */
  keyword: string;
  /** Median percent of top incumbents (0..1). */
  incumbent_median_percent: number;
  /** Our package's score percent (0..1). */
  our_percent: number;
  /** True if our_percent >= incumbent_median_percent. */
  beats: boolean;
  /** How many incumbents informed the median. */
  incumbent_count: number;
}

// ---------------------------------------------------------------------------
// Full package
// ---------------------------------------------------------------------------
export interface PublishPackage {
  brief_id: string;
  /** UUID of the existing listings row when this brief has been published before. */
  listing_id?: string;
  /** Numeric Etsy listing id (string in DB), set when listing_id is set. */
  etsy_listing_id?: string;
  store: Store;

  title: string;
  /** Etsy-pasteable plain text (no markdown). */
  description_plaintext: string;
  /** Exactly 13 for Etsy; each ≤20 chars. */
  tags: string[];
  taxonomy_id: number;
  taxonomy_breadcrumb: string[];
  taxonomy_fallback?: { matched_path: string[]; unmatched_tail: string[] };

  attributes: AttributeAssignment[];
  attributes_skipped: AttributeSkip[];
  /** Free-text materials per Etsy's listing-level `materials` array (separate from Material multi property). */
  materials: string[];
  shop_section_suggestion?: string;

  image_manifest: ImageSlot[];

  /** Per-rule SEO score (etsy-seo-scoring.ts) for the assembled draft. */
  seo_score: SeoScore;
  /**
   * Best benchmark across brief.competitive_landscape (highest classification
   * priority: red_ocean > mixed > weak_incumbents > open_field). When
   * absent, the agent couldn't compute a benchmark (e.g. no
   * competitive_landscape on the brief).
   */
  incumbent_benchmark?: IncumbentBenchmark;
  /** If an Opus improvement pass ran, the score from BEFORE the pass. */
  pre_improvement_score?: SeoScore;
  /** Human-readable list of everything the operator must address before publish. */
  gaps: string[];

  /** Diagnostic: total Opus cost spent during package generation. */
  cost_usd: number;
  /** Schema version. */
  package_version: 'listing-v1';
}
