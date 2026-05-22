// Semantic-descriptor → Etsy-allowed-value mapping. The codification of
// LISTING_AGENT_REQUIREMENTS.md §4 ("Allowed-value verification — REQUIREMENT").
//
// Why this module exists:
//   The Research Agent emits SEMANTIC descriptors (e.g. "cottagecore",
//   "scandinavian", "digital download") under `brief.listing.attribute_intent`.
//   The Listing Agent maps those to each store's live `possible_values` at
//   publish time. The hard contract is: **blank slot beats wrong slot.**
//
// Match tiers (highest confidence first):
//   1. Exact normalized equality            — confidence "exact"
//   2. Whole-token containment (descriptor is one of the value's words, or
//      the descriptor's first word matches one of the value's words)
//                                            — confidence "token"
//   3. Curated semantic-substitution map    — confidence "semantic"
//   4. null — no match (skip the slot)
//
// We deliberately do NOT use Jaro-Winkler / Levenshtein / embedding distance
// for v1 because the failure mode of fuzzy-string is "Modern" matching
// "Modern Farmhouse" matching "Mid-century Modern" matching "Postmodern" —
// all close in edit distance, semantically distinct. Curated semantic map
// in step 3 is small, explicit, and reviewable.
//
// All substitutions are recorded with `was_substituted=true` + a `reason`
// string the operator can audit in the package markdown.
//
// Pure / deterministic. No DB, no LLM, no network.
import type {
  TaxonomyProperty,
  TaxonomyPossibleValue,
} from './etsy-taxonomy.js';

export interface AttributeMatch {
  /** The value string that should be written to Etsy. */
  value: string;
  /** Etsy's internal `value_id` (for the property's `possible_values` array). */
  value_id: number;
  /** True when the chosen value wasn't an exact match for the input descriptor. */
  was_substituted: boolean;
  /** Human-readable explanation of the chosen value. */
  reason: string;
  /** Which input descriptor produced the match (for audit). */
  matched_from: string;
  /** Diagnostic — which tier accepted the match. */
  confidence: 'exact' | 'token' | 'semantic';
}

export interface AttributeMappingInput {
  /** The semantic descriptors from `brief.listing.attribute_intent`. */
  descriptors: string[];
  /** Property as returned by `getTaxonomyProperties()`. */
  property: TaxonomyProperty;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    // Drop accents.
    .replace(/[\u0300-\u036f]/g, '')
    // Collapse non-alphanumerics to spaces (preserve word boundaries).
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(t => t.length >= 3);
}

// ---------------------------------------------------------------------------
// Curated semantic-substitution map.
//
// Each entry: "if the buyer/brief said X and X is NOT a literal Etsy
// possible_value for this property, accept these semantic neighbors (in
// preference order) IF any of them ARE in the property's possible_values."
//
// Built from the lessons in LISTING_AGENT_REQUIREMENTS.md (§3, §4 worked
// examples) plus the actual `possible_values` for the live HillwardStudio
// taxonomies (354 Calendars & Planners, 2078 Digital Prints) probed against
// the live Etsy API. Extend conservatively — wrong substitutions are
// silent-but-active mis-categorization. Right blanks are silent gaps that
// can be re-investigated.
// ---------------------------------------------------------------------------
const SEMANTIC_SUBSTITUTIONS: Record<string, string[]> = {
  // Style / Home style neighbors
  'cottagecore':       ['country', 'country & farmhouse', 'rustic', 'rustic & primitive', 'victorian'],
  'farmhouse':         ['country & farmhouse', 'country', 'rustic', 'rustic & primitive'],
  'rustic':            ['rustic & primitive', 'country & farmhouse', 'country'],
  'country':           ['country & farmhouse', 'rustic & primitive'],
  'scandinavian':      ['minimalist', 'contemporary', 'mid-century'],
  'scandi':            ['minimalist', 'contemporary'],
  'nordic':            ['minimalist', 'contemporary'],
  'modern':            ['contemporary', 'mid-century', 'minimalist'],
  'clean':             ['minimalist', 'contemporary'],
  'editorial':         ['minimalist', 'contemporary'],
  'minimal':           ['minimalist', 'contemporary'],
  'vintage':           ['victorian', 'art nouveau', 'art deco'],
  'antique':           ['victorian', 'art nouveau'],
  'heirloom':          ['victorian', 'country & farmhouse'],
  'storybook':         ['country & farmhouse', 'art nouveau', 'victorian'],
  'folk art':          ['country & farmhouse', 'rustic & primitive'],
  'boho':              ['bohemian & eclectic', 'bohemian'],
  'bohemian':          ['bohemian & eclectic'],
  'eclectic':          ['bohemian & eclectic'],
  'industrial':        ['industrial & utility'],
  'coastal':           ['coastal & tropical'],
  'tropical':          ['coastal & tropical'],

  // Color neighbors (semantic, not perceptual — beige > taupe > cream all → Beige)
  'cream':             ['beige', 'white'],
  'off-white':         ['white', 'beige'],
  'off white':         ['white', 'beige'],
  'warm cream':        ['beige', 'white'],
  'warm neutral':      ['beige', 'brown'],
  'warm white':        ['white', 'beige'],
  'taupe':             ['beige', 'brown'],
  'tan':               ['beige', 'brown'],
  'aged tan':          ['beige', 'brown'],
  'soft brown':        ['brown', 'beige'],
  'soft beige':        ['beige'],
  'charcoal':          ['gray', 'black'],
  'sage':              ['green'],
  'sage green':        ['green'],
  'olive':             ['green'],
  'mustard':           ['yellow', 'orange'],
  'navy':              ['blue'],
  'blush':             ['pink'],
  'dusty rose':        ['pink'],
  'terracotta':        ['orange', 'red', 'brown'],
  'rust':              ['orange', 'brown', 'red'],
  'ivory':             ['white', 'beige'],

  // Materials neighbors (constrained list is mostly physical materials; the
  // intent for a printable is "paper, because the buyer prints on it")
  'digital download':  ['paper'],
  'digital':           ['paper'],
  'printable':         ['paper'],
  'printable pdf':     ['paper'],
  'pdf':               ['paper'],
  'instant download':  ['paper'],
  'high-res jpg':      ['paper'],
  'high res jpg':      ['paper'],
  'watercolor illustration': ['paper'],

  // Room neighbors
  'kids room':         ['kids', 'nursery'],
  "children's room":   ['kids', 'nursery'],
  'baby room':         ['nursery', 'kids'],
  'home office':       ['office'],
  'dining room':       ['kitchen & dining'],
  'kitchen':           ['kitchen & dining'],

  // Occasion neighbors
  'newborn gift':      ['baby shower', 'birthday'],
  'expecting parents': ['baby shower'],
  'nursery decor':     ['baby shower'],
  'new year setup':    ['back to school'],
  'monthly review':    ['back to school'],
  'everyday planning': ['back to school'],

  // Aspect ratios — descriptors → exact Etsy strings
  '4:5':               ['4:5'],
  '3:4':               ['3:4'],
  '2:3':               ['2:3'],
  '1:1':               ['1:1'],
  'portrait':          ['vertical'],
  'landscape':         ['horizontal'],

  // Art subject neighbors (Digital Prints)
  'rabbit':            ['animal'],
  'bunny':             ['animal'],
  'woodland':          ['animal', 'landscape & scenery'],
  'animals':           ['animal'],
  'florals':           ['flowers'],
  'floral':            ['flowers'],
  'botanical':         ['flowers'],
};

// ---------------------------------------------------------------------------
// Single-descriptor scoring
// ---------------------------------------------------------------------------
interface Candidate {
  pv: TaxonomyPossibleValue;
  tier: 'exact' | 'token' | 'semantic';
  matchedFrom: string;
}

function matchOne(
  descriptor: string,
  possibleValues: TaxonomyPossibleValue[]
): Candidate | null {
  const descNorm = normalize(descriptor);
  if (!descNorm) return null;

  // Tier 1 — exact normalized equality.
  for (const pv of possibleValues) {
    if (normalize(pv.name) === descNorm) {
      return { pv, tier: 'exact', matchedFrom: descriptor };
    }
  }

  // Tier 2 — whole-token containment.
  // The descriptor is a token of the value (e.g. "minimalist" inside
  // "Minimalist & modern") or vice versa.
  const descTokens = new Set(tokens(descriptor));
  if (descTokens.size > 0) {
    for (const pv of possibleValues) {
      const pvTokens = new Set(tokens(pv.name));
      const pvWords = normalize(pv.name).split(' ');
      const descWords = descNorm.split(' ');

      // Single-word descriptor is contained as a whole token of the value
      // (matches "Minimalist" → "Minimalist"; "country" → "Country & farmhouse").
      if (descWords.length === 1 && descWords[0].length >= 4 && pvTokens.has(descWords[0])) {
        return { pv, tier: 'token', matchedFrom: descriptor };
      }
      // OR the value's single primary word is contained in the multi-word
      // descriptor ("warm cream" → "Beige" only via SEMANTIC_SUBSTITUTIONS;
      // this catches "modern farmhouse" → "Modern" only when "modern" is a
      // distinct token of the descriptor, not a substring).
      if (pvWords.length === 1 && pvWords[0].length >= 4 && descTokens.has(pvWords[0])) {
        return { pv, tier: 'token', matchedFrom: descriptor };
      }
    }
  }

  // Tier 3 — curated semantic substitution.
  const substitutes = SEMANTIC_SUBSTITUTIONS[descNorm];
  if (substitutes) {
    for (const sub of substitutes) {
      const subNorm = normalize(sub);
      for (const pv of possibleValues) {
        if (normalize(pv.name) === subNorm) {
          return { pv, tier: 'semantic', matchedFrom: descriptor };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public — map a descriptor list to a single property.
//
// Returns the FIRST acceptable match across the descriptor list, preferring
// higher-confidence tiers (exact > token > semantic). Returns null when no
// descriptor produces any match — per §4 the slot is left blank.
// ---------------------------------------------------------------------------
export function mapSemanticToAllowed(
  input: AttributeMappingInput
): AttributeMatch | null {
  const { descriptors, property } = input;
  if (!Array.isArray(property.possible_values) || property.possible_values.length === 0) {
    // Free-text property — outside §4. Caller decides what to do (typically:
    // pass descriptors through verbatim after adapter-side length / count
    // validation).
    return null;
  }

  let best: Candidate | null = null;
  const tierRank = { exact: 0, token: 1, semantic: 2 } as const;

  for (const desc of descriptors) {
    const c = matchOne(desc, property.possible_values);
    if (!c) continue;
    if (!best || tierRank[c.tier] < tierRank[best.tier]) {
      best = c;
      if (best.tier === 'exact') break; // can't do better
    }
  }

  if (!best) return null;

  const reasonByTier = {
    exact: `Exact match: "${best.matchedFrom}" → "${best.pv.name}".`,
    token: `Token match: "${best.matchedFrom}" → "${best.pv.name}" (shared meaningful word).`,
    semantic: `Semantic substitution: "${best.matchedFrom}" → "${best.pv.name}" (curated neighbor).`,
  } as const;

  return {
    value: best.pv.name,
    value_id: best.pv.value_id,
    was_substituted: best.tier !== 'exact',
    reason: reasonByTier[best.tier],
    matched_from: best.matchedFrom,
    confidence: best.tier,
  };
}

// ---------------------------------------------------------------------------
// Public — map ALL descriptors to ALL value-id matches for a property.
//
// Used for multivalued properties (e.g. Etsy "Occasion" / "Art subject" /
// "Material multi") where multiple descriptors should each produce a
// separate value_id. Skips descriptors that don't match per §4.
// ---------------------------------------------------------------------------
export interface MultiAttributeMatch {
  matches: AttributeMatch[];
  skipped: Array<{ descriptor: string; reason: string }>;
}

export function mapSemanticToAllowedMany(
  input: AttributeMappingInput
): MultiAttributeMatch {
  const { descriptors, property } = input;
  const matches: AttributeMatch[] = [];
  const skipped: Array<{ descriptor: string; reason: string }> = [];

  if (!Array.isArray(property.possible_values) || property.possible_values.length === 0) {
    for (const d of descriptors) {
      skipped.push({
        descriptor: d,
        reason: `Property "${property.name}" is free-text (no possible_values) — not applicable.`,
      });
    }
    return { matches, skipped };
  }

  const seenValueIds = new Set<number>();

  for (const desc of descriptors) {
    const c = matchOne(desc, property.possible_values);
    if (!c) {
      skipped.push({
        descriptor: desc,
        reason: `No match in ${property.possible_values.length} possible_values for property "${property.name}".`,
      });
      continue;
    }
    if (seenValueIds.has(c.pv.value_id)) {
      skipped.push({
        descriptor: desc,
        reason: `Already mapped to value_id=${c.pv.value_id} ("${c.pv.name}") by an earlier descriptor.`,
      });
      continue;
    }
    seenValueIds.add(c.pv.value_id);
    const reasonByTier = {
      exact: `Exact match: "${desc}" → "${c.pv.name}".`,
      token: `Token match: "${desc}" → "${c.pv.name}" (shared meaningful word).`,
      semantic: `Semantic substitution: "${desc}" → "${c.pv.name}" (curated neighbor).`,
    } as const;
    matches.push({
      value: c.pv.name,
      value_id: c.pv.value_id,
      was_substituted: c.tier !== 'exact',
      reason: reasonByTier[c.tier],
      matched_from: desc,
      confidence: c.tier,
    });
  }

  return { matches, skipped };
}
