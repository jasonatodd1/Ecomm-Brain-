/**
 * Curated niche bake-off keyword set (baseline run).
 * Each phrase is a specific buyer product-query validated for Etsy coherence.
 */

export type ProducibilityTag = 'digital' | 'physical-POD' | 'dropship';

export interface BakeoffKeywordSpec {
  keyword: string;
  niche: string;
  /** Digital printables anchor niche for bake-off comparison. */
  is_anchor_niche: boolean;
  /** Default producibility; may be refined from Etsy title sample after search. */
  producibility: ProducibilityTag;
}

export const BAKEOFF_NICHES: BakeoffKeywordSpec[] = [
  // Digital printables — ANCHOR (incumbent)
  {
    keyword: 'meal planner printable',
    niche: 'digital_printables',
    is_anchor_niche: true,
    producibility: 'digital'
  },
  {
    keyword: 'nursery wall art printable',
    niche: 'digital_printables',
    is_anchor_niche: true,
    producibility: 'digital'
  },
  {
    keyword: 'teacher planner printable',
    niche: 'digital_printables',
    is_anchor_niche: true,
    producibility: 'digital'
  },
  // Physical wall art / posters
  {
    keyword: 'abstract wall art print',
    niche: 'physical_wall_art',
    is_anchor_niche: false,
    producibility: 'physical-POD'
  },
  {
    keyword: 'botanical wall art print set',
    niche: 'physical_wall_art',
    is_anchor_niche: false,
    producibility: 'physical-POD'
  },
  // Pet portraits / pet art
  {
    keyword: 'custom pet portrait digital',
    niche: 'pet_portraits',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'dog portrait print',
    niche: 'pet_portraits',
    is_anchor_niche: false,
    producibility: 'physical-POD'
  },
  // Wedding & events
  {
    keyword: 'wedding seating chart template',
    niche: 'wedding_events',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'wedding invitation template',
    niche: 'wedding_events',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'wedding welcome sign template',
    niche: 'wedding_events',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  // SVG / cut files
  {
    keyword: 'svg files for cricut',
    niche: 'svg_craft_digital',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'svg bundle cricut',
    niche: 'svg_craft_digital',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  // Greeting cards / stationery
  {
    keyword: 'printable birthday card',
    niche: 'greeting_cards',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'printable thank you card',
    niche: 'greeting_cards',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  // Apparel / graphic tees
  {
    keyword: 'funny mom shirt',
    niche: 'apparel',
    is_anchor_niche: false,
    producibility: 'physical-POD'
  },
  {
    keyword: 'custom name t shirt',
    niche: 'apparel',
    is_anchor_niche: false,
    producibility: 'physical-POD'
  },
  // Wellness / fitness
  {
    keyword: 'printable workout tracker',
    niche: 'wellness_fitness',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'workout journal printable',
    niche: 'wellness_fitness',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  // Home decor physical
  {
    keyword: 'macrame wall hanging',
    niche: 'home_decor_physical',
    is_anchor_niche: false,
    producibility: 'dropship'
  },
  {
    keyword: 'scented soy candle',
    niche: 'home_decor_physical',
    is_anchor_niche: false,
    producibility: 'dropship'
  }
];

/** Digital-preference hurdle: physical/dropship must beat best digital WS by this margin. */
export const DIGITAL_PREFERENCE_HURDLE = 0.1;

const DIGITAL_TITLE_HINTS =
  /digital download|instant download|printable|pdf|svg|canva|template/i;
const PHYSICAL_TITLE_HINTS =
  /shirt|tee|t-shirt|macrame|candle|poster|canvas|print\b|physical/i;

/** Refine producibility tag from top Etsy titles when keyword is ambiguous. */
export function refineProducibilityFromResults(
  defaultTag: ProducibilityTag,
  titles: string[]
): ProducibilityTag {
  if (titles.length === 0) return defaultTag;

  let digital = 0;
  let physical = 0;
  for (const t of titles.slice(0, 10)) {
    if (DIGITAL_TITLE_HINTS.test(t)) digital++;
    if (PHYSICAL_TITLE_HINTS.test(t)) physical++;
  }

  if (digital > physical && digital >= 2) return 'digital';
  if (physical > digital && physical >= 2) {
    return defaultTag === 'dropship' ? 'dropship' : 'physical-POD';
  }
  return defaultTag;
}
