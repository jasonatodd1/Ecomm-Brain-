// Output schema produced by the Research Agent.
// Downstream agents (design, listing, pricing) consume these fields literally —
// changing field names or shapes here breaks the contract with downstream agents.

export type ProductBrief = {
  recommendation: 'proceed' | 'pivot' | 'pass';
  confidence: number;
  reasoning: string;

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
    description_angles: string[];
    differentiation_angle: string;
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
  title: string;
  price: number | null;
  currency: string;
  url: string;
  shop_name: string;
  shop_url: string;
  num_favorers: number | null;
  image_url?: string;
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
