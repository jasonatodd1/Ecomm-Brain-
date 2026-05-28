/**
 * Curated niche bake-off keyword set (baseline run).
 * Each phrase is a specific buyer product-query validated for Etsy coherence.
 */

export type ProducibilityTag = 'digital' | 'physical-POD' | 'dropship';

export interface BakeoffKeywordSpec {
  /** SPECIFIC buyer phrase — what the SUPPLY leg (Etsy competition) scores against. */
  keyword: string;
  niche: string;
  /** Digital printables anchor niche for bake-off comparison. */
  is_anchor_niche: boolean;
  /** Default producibility; may be refined from Etsy title sample after search. */
  producibility: ProducibilityTag;
  /**
   * HEAD term — what the DEMAND leg (Google Trends) reads. Optional override;
   * when omitted, derived deterministically by `deriveHeadTerm(keyword)`.
   * Set explicitly only when the deterministic strip is insufficient (e.g.
   * physical "print" / SVG phrasings where the format word is also the product noun).
   */
  head_term?: string;
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
    producibility: 'physical-POD',
    // "print" is the medium word here, not a strip-able digital format → override.
    head_term: 'abstract wall art'
  },
  {
    keyword: 'botanical wall art print set',
    niche: 'physical_wall_art',
    is_anchor_niche: false,
    producibility: 'physical-POD',
    head_term: 'botanical wall art'
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
    producibility: 'physical-POD',
    head_term: 'dog portrait'
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
    producibility: 'digital',
    // "svg/bundle/cricut" are all format/platform words → strip yields nothing usable; broad head.
    head_term: 'cricut svg'
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
  },
  // Household organization — our beachhead lane (meal planner gives us a foothold here).
  // All digital printables; head terms derived by stripping the "printable" format word.
  {
    keyword: 'cleaning schedule printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'budget planner printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'paycheck budget tracker printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital',
    // strip alone keeps "paycheck budget tracker" (thin Trends) → use the broad head.
    head_term: 'budget tracker'
  },
  {
    keyword: 'chore chart printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'meal prep planner printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'family command center printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'cleaning checklist printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  },
  {
    keyword: 'savings tracker printable',
    niche: 'household_organization',
    is_anchor_niche: false,
    producibility: 'digital'
  }
];

/** Digital-preference hurdle: physical/dropship must beat best digital WS by this margin. */
export const DIGITAL_PREFERENCE_HURDLE = 0.1;

/**
 * Format/delivery modifier words stripped to derive a HEAD term for the demand leg.
 * These denote how the product is delivered, not what it is — so removing them
 * yields the broad product noun phrase that Google Trends can actually measure.
 * (Long-tail "...printable" phrasings return ~0 Trends interest even for real markets;
 * the canonical false-negative is "nursery wall art printable" → DEAD_ZONE.)
 *
 * Deliberately CONSERVATIVE: only unambiguous digital-format words. Physical "print",
 * "set", platform words like "cricut/svg" are left to per-keyword `head_term` overrides
 * (control where the strip would mangle the noun; scalable default everywhere else).
 */
const FORMAT_MODIFIER_PHRASES = ['instant download', 'digital download'];
const FORMAT_MODIFIER_TOKENS = new Set([
  'printable',
  'printables',
  'template',
  'templates',
  'digital',
  'pdf',
  'editable',
  'download',
  'downloads',
  'downloadable',
  'instant'
]);

/**
 * Deterministically derive a broad HEAD term from a specific buyer phrase by
 * stripping format/delivery modifier words. Falls back to the original phrase if
 * stripping leaves nothing usable (so a phrase that is ALL modifiers — e.g. pure
 * "svg bundle" — keeps its words rather than collapsing to empty; use an override
 * for those). Lower-cased, whitespace-collapsed.
 */
export function deriveHeadTerm(keyword: string): string {
  let s = ` ${keyword.toLowerCase()} `;
  for (const phrase of FORMAT_MODIFIER_PHRASES) {
    s = s.replace(new RegExp(`\\s${phrase}\\s`, 'g'), ' ');
  }
  const tokens = s
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => !FORMAT_MODIFIER_TOKENS.has(t));
  const head = tokens.join(' ');
  if (tokens.length === 0 || head.length < 3) {
    return keyword.toLowerCase().trim();
  }
  return head;
}

/** Resolve the demand-leg head term for a spec: explicit override wins, else derive. */
export function headTermFor(spec: BakeoffKeywordSpec): string {
  return (spec.head_term ?? deriveHeadTerm(spec.keyword)).trim();
}

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
