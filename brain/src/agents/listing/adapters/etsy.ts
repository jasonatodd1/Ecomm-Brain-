// Etsy-specific assembly logic for the Listing Agent.
//
// Responsibilities (per LISTING_AGENT_REQUIREMENTS.md §5):
//   - Title rules:        ≤140 chars, intelligent truncation on `|`.
//   - Tag rules:          exactly 13, ≤20 chars each, no exact title-duplicates.
//   - Image slot mapping: brief.listing.image_spec → assets registry → 1..10
//                         Etsy photo slots; emit generation_hint for misses.
//   - Attribute mapping:  walk taxonomy property list, for each property call
//                         attribute-mapping.ts with the relevant attribute_intent
//                         descriptors. Skip slots that don't exist for the
//                         taxonomy (the §4 fix for today's Recipient/Materials
//                         pain). Output AttributeAssignment[] + AttributeSkip[].
//
// All functions are pure and side-effect free (no DB / no network). The
// orchestrator in `../index.ts` calls them with the data it has already
// fetched. Keeping the adapter pure makes it trivially unit-testable.

import type { ProductBrief } from '../../research/types.js';
import type { TaxonomyProperty } from '../../../lib/etsy-taxonomy.js';
import {
  mapSemanticToAllowed,
  mapSemanticToAllowedMany,
} from '../../../lib/attribute-mapping.js';
import type { AssetKind } from '../../../lib/assets.js';
import type {
  AttributeAssignment,
  AttributeSkip,
  ImageSlot,
} from '../types.js';

// ---------------------------------------------------------------------------
// Etsy publish-time rules (centralized so changes are one-place edits).
// ---------------------------------------------------------------------------
export const ETSY_RULES = {
  title_max_chars: 140,
  tag_count_exact: 13,
  tag_max_chars: 20,
  description_format: 'plaintext' as const,
  images_max: 10,
} as const;

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
export interface TitleResult {
  title: string;
  changed: boolean;
  note: string;
}

/**
 * Validate + (intelligently) truncate a title to Etsy's 140-char limit.
 * Preserves leading keyword density by trimming from the RIGHT at the last
 * `|` boundary that fits. Falls back to a hard slice when no boundary works.
 */
export function validateTitle(raw: string): TitleResult {
  const t = raw.trim();
  if (t.length <= ETSY_RULES.title_max_chars) {
    return { title: t, changed: t !== raw, note: `${t.length}/${ETSY_RULES.title_max_chars} chars — ok` };
  }

  // Find the rightmost `|` whose preceding segment still fits.
  const segments = t.split('|').map(s => s.trim());
  let acc = '';
  for (let i = 0; i < segments.length; i++) {
    const candidate = i === 0 ? segments[0] : `${acc} | ${segments[i]}`;
    if (candidate.length > ETSY_RULES.title_max_chars) break;
    acc = candidate;
  }

  if (acc.length > 0 && acc.length <= ETSY_RULES.title_max_chars) {
    return {
      title: acc,
      changed: true,
      note: `Truncated at \`|\` boundary: ${t.length} → ${acc.length}/${ETSY_RULES.title_max_chars} chars`,
    };
  }

  const hard = t.slice(0, ETSY_RULES.title_max_chars).trimEnd();
  return {
    title: hard,
    changed: true,
    note: `Hard-trimmed (no \`|\` boundary fit): ${t.length} → ${hard.length}/${ETSY_RULES.title_max_chars} chars`,
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
export interface TagsResult {
  tags: string[];
  dropped: Array<{ tag: string; reason: string }>;
  note: string;
}

function normalizeTag(t: string): string {
  return t.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Validate Etsy hard tag rules:
 *   - each ≤20 chars (Etsy publish-time enforced)
 *   - no exact duplicates among tags themselves (wasted slot)
 *   - drop empty
 *   - cap at 13 (Etsy's hard ceiling)
 *
 * Does NOT reject title-overlap: Etsy actually rewards cross-field keyword
 * reinforcement, and the SEO scorer (`etsy-seo-scoring.ts` Rule 4) already
 * applies a SOFT 1-point penalty per full-phrase title duplicate. Treating
 * this as a hard reject was costing 4-5 slots per brief and made tag_count
 * scoring crater. Surfaced as a soft `overlaps` count instead so the
 * operator can decide.
 *
 * Does NOT pad to exactly 13 — that's a brief-quality issue the agent
 * surfaces via the `gaps[]` field rather than inventing tags.
 */
export function validateTags(rawTags: string[], title: string): TagsResult {
  const titleNorm = title.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  const dropped: Array<{ tag: string; reason: string }> = [];
  let overlaps = 0;

  for (const raw of rawTags) {
    const t = raw.trim();
    if (!t) {
      continue;
    }
    if (t.length > ETSY_RULES.tag_max_chars) {
      dropped.push({ tag: raw, reason: `>${ETSY_RULES.tag_max_chars} chars (${t.length})` });
      continue;
    }
    const norm = normalizeTag(t);
    if (seen.has(norm)) {
      dropped.push({ tag: raw, reason: 'duplicate of earlier tag' });
      continue;
    }
    if (norm.length >= 4 && titleNorm.includes(norm)) {
      overlaps++;
    }
    seen.add(norm);
    out.push(t);
    if (out.length === ETSY_RULES.tag_count_exact) break;
  }

  const overlapNote = overlaps > 0 ? ` (${overlaps} overlap title — soft SEO penalty per scorer Rule 4)` : '';
  const note =
    out.length === ETSY_RULES.tag_count_exact
      ? `${out.length}/${ETSY_RULES.tag_count_exact} tags — ok${overlapNote}`
      : `${out.length}/${ETSY_RULES.tag_count_exact} tags — gap of ${ETSY_RULES.tag_count_exact - out.length} (brief produced ${rawTags.length}, ${dropped.length} dropped)${overlapNote}`;

  return { tags: out, dropped, note };
}

// ---------------------------------------------------------------------------
// Attribute mapping orchestration
// ---------------------------------------------------------------------------

/**
 * Decide which descriptors apply to which Etsy property. The brief's
 * attribute_intent groups descriptors by SEMANTIC role (style / audience /
 * occasion / color / materials); Etsy's property names are loosely aligned
 * but not 1:1. We pick the most-relevant descriptor pool for each property
 * by name, with fallthroughs for adjacent properties.
 *
 * Returns an empty array when no descriptor group is plausibly relevant —
 * caller skips the property with reason='no_match'.
 */
function descriptorsForProperty(
  property: TaxonomyProperty,
  intent: NonNullable<ProductBrief['listing']['attribute_intent']>
): string[] {
  const n = property.name.toLowerCase();

  // Style / Home style — style descriptors
  if (n.includes('style')) return intent.style_descriptors;

  // Room — audience + occasion (nursery is both a room and an audience cue)
  if (n === 'room')
    return [...intent.audience_descriptors, ...intent.occasion_descriptors];

  // Color slots — color descriptors
  if (n.includes('color')) return intent.color_descriptors;

  // Material — materials intent
  if (n === 'material' || n === 'material multi' || n.startsWith('material'))
    return intent.materials_intent;

  // Occasion — occasion descriptors
  if (n === 'occasion') return intent.occasion_descriptors;

  // Holiday — occasion descriptors (overlaps but rarely matches)
  if (n === 'holiday') return intent.occasion_descriptors;

  // Art subject — style descriptors (vintage / watercolor → animal / landscape via curated map)
  // and audience descriptors (rabbit / bunny → animal)
  if (n.includes('subject'))
    return [...intent.style_descriptors, ...intent.audience_descriptors];

  // Pattern — style descriptors
  if (n === 'pattern') return intent.style_descriptors;

  // Orientation / Aspect ratio — handled by structured image facts, not intent.
  // Recipient / Recipient-like — audience descriptors
  if (n.includes('recipient')) return intent.audience_descriptors;

  return [];
}

const MULTIVALUED_PROPERTY_NAMES = new Set([
  'occasion',
  'material multi',
  'holiday',
  'art subject',
]);

export interface AttributeMappingResult {
  attributes: AttributeAssignment[];
  attributes_skipped: AttributeSkip[];
}

/**
 * Map a brief's `attribute_intent` against ALL properties returned by
 * getTaxonomyProperties(). Per §4:
 *   - Property absent → caller already filtered it out (only properties we
 *     receive are eligible).
 *   - No descriptors for a property → skip with reason='no_match'.
 *   - Property has no possible_values (free-text) → skip with
 *     reason='free_text_not_mapped'. Free-text materials/style are emitted
 *     separately by the orchestrator using brief.materials_intent verbatim.
 *   - Descriptors found, but none match → skip with reason='no_match'.
 *
 * Properties of these names are auto-skipped (irrelevant for digital wall art
 * + printable planners and would otherwise produce nonsense matches):
 *   TeeShirtSize, Device, Custom1, Custom2, Fabric, Scent, Flavor, Weight,
 *   Diameter, Length, Width, Height, Depth, Dimensions, Finish, Sustainability,
 *   Framing, Can be personalized, Number of pieces included.
 */
const PROPERTY_BLOCKLIST = new Set([
  'teeshirtsize', 'device', 'custom1', 'custom2',
  'fabric', 'scent', 'flavor', 'weight',
  'diameter', 'length', 'width', 'height', 'depth', 'dimensions',
  'finish', 'sustainability', 'framing',
  'can be personalized', 'number of pieces included',
  'orientation', 'aspect ratio', // structured image facts, not intent-driven
]);

export function mapAttributes(
  brief: ProductBrief,
  properties: TaxonomyProperty[]
): AttributeMappingResult {
  const attributes: AttributeAssignment[] = [];
  const attributes_skipped: AttributeSkip[] = [];

  const intent = brief.listing.attribute_intent;
  if (!intent) {
    for (const p of properties) {
      attributes_skipped.push({
        property_name: p.name,
        property_id: p.property_id,
        reason: 'no_match',
        detail: 'Brief has no listing.attribute_intent (legacy v1 brief).',
      });
    }
    return { attributes, attributes_skipped };
  }

  for (const property of properties) {
    if (PROPERTY_BLOCKLIST.has(property.name.toLowerCase())) {
      attributes_skipped.push({
        property_name: property.name,
        property_id: property.property_id,
        reason: 'no_match',
        detail: 'Property irrelevant for digital wall art / printables (block-listed).',
      });
      continue;
    }

    const descriptors = descriptorsForProperty(property, intent);
    if (descriptors.length === 0) {
      attributes_skipped.push({
        property_name: property.name,
        property_id: property.property_id,
        reason: 'no_match',
        detail: 'No attribute_intent group plausibly relevant to this property.',
      });
      continue;
    }

    // Free-text properties (no possible_values) — out of scope for §4
    // semantic mapping. Surface them so the operator can decide whether to
    // pass the descriptors through verbatim.
    if (!property.possible_values || property.possible_values.length === 0) {
      attributes_skipped.push({
        property_name: property.name,
        property_id: property.property_id,
        reason: 'free_text_not_mapped',
        detail: `Free-text property — descriptors available if wanted: ${descriptors.slice(0, 6).join(', ')}`,
      });
      continue;
    }

    const isMulti = MULTIVALUED_PROPERTY_NAMES.has(property.name.toLowerCase());

    if (isMulti) {
      const { matches, skipped } = mapSemanticToAllowedMany({
        descriptors,
        property,
      });
      if (matches.length === 0) {
        attributes_skipped.push({
          property_name: property.name,
          property_id: property.property_id,
          reason: 'no_match',
          detail: `Descriptors tried: ${descriptors.join(', ')}; ${skipped.length} skipped.`,
        });
        continue;
      }
      attributes.push({
        property_name: property.name,
        property_id: property.property_id,
        values: matches.map(m => ({
          value: m.value,
          value_id: m.value_id,
          was_substituted: m.was_substituted,
          matched_from: m.matched_from,
          confidence: m.confidence,
          reason: m.reason,
        })),
        any_substituted: matches.some(m => m.was_substituted),
      });
    } else {
      const m = mapSemanticToAllowed({ descriptors, property });
      if (!m) {
        attributes_skipped.push({
          property_name: property.name,
          property_id: property.property_id,
          reason: 'no_match',
          detail: `Descriptors tried: ${descriptors.join(', ')}.`,
        });
        continue;
      }
      attributes.push({
        property_name: property.name,
        property_id: property.property_id,
        values: [
          {
            value: m.value,
            value_id: m.value_id,
            was_substituted: m.was_substituted,
            matched_from: m.matched_from,
            confidence: m.confidence,
            reason: m.reason,
          },
        ],
        any_substituted: m.was_substituted,
      });
    }
  }

  return { attributes, attributes_skipped };
}

// ---------------------------------------------------------------------------
// Image manifest
// ---------------------------------------------------------------------------

export interface AssetRow {
  id: string;
  kind: AssetKind;
  source: string;
  local_path: string | null;
  cdn_url: string | null;
  width: number | null;
  height: number | null;
}

// Etsy supports 10 photo slots. We populate slots 1..N (one per image_spec
// entry) then leave any tail empty — Etsy doesn't require all 10.
//
// Asset → spec matching uses the `kind` column. When multiple assets share
// a kind (e.g. five `print_variant` JPGs), we pick the widest (highest dpi).
// When no asset matches, the slot is `missing` with a generation_hint that
// stitches the spec's style_notes + product context into a fal-compatible
// prompt skeleton.

interface BuildManifestInput {
  /** Brief's image_spec — drives ordered slot list. */
  imageSpec?: NonNullable<ProductBrief['listing']['image_spec']>;
  assets: AssetRow[];
  product_name: string;
  /** brief.product.design.mood_keywords joined as additional prompt anchor. */
  design_mood: string;
}

export function buildImageManifest(input: BuildManifestInput): ImageSlot[] {
  const slots: ImageSlot[] = [];
  if (!input.imageSpec || input.imageSpec.length === 0) {
    return slots;
  }

  for (let i = 0; i < input.imageSpec.length && i < ETSY_RULES.images_max; i++) {
    const spec = input.imageSpec[i];
    const wantKind = spec.kind as AssetKind;
    const matching = input.assets
      .filter(a => a.kind === wantKind)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

    if (matching.length > 0) {
      const a = matching[0];
      slots.push({
        slot: i + 1,
        kind: wantKind,
        status: 'ready',
        asset_id: a.id,
        asset_path: a.local_path ?? undefined,
        asset_width: a.width ?? undefined,
        asset_height: a.height ?? undefined,
        asset_source: a.source,
        spec: {
          purpose: spec.purpose,
          dims_recommended: spec.dims_recommended,
          style_notes: spec.style_notes,
        },
      });
      continue;
    }

    // No matching asset — emit a generation hint.
    const masterPresent = input.assets.some(a => a.kind === 'master');
    const transparentPresent = input.assets.some(a => a.kind === 'transparent');
    const cheatSheet: string[] = [];
    if (wantKind === 'hero' && (masterPresent || transparentPresent)) {
      cheatSheet.push(
        `Could derive from existing ${masterPresent ? 'master' : 'transparent'} asset: \`sharp <master> | resize 2000x2000 fit:cover\`.`
      );
    }
    if (wantKind === 'size_grid' && input.assets.some(a => a.kind === 'ratio_guide')) {
      cheatSheet.push(
        `Could rasterize existing ratio_guide PDF to a 2000×2000 PNG via \`sharp\` or a screenshot tool.`
      );
    }
    if (wantKind === 'lifestyle' || wantKind === 'lifestyle_detail') {
      cheatSheet.push(
        `Recommend fal flux-pro: \`npm run gen -- --prompt="${spec.style_notes.replace(/\s+/g, ' ').trim()}" --product-brief-id=<brief>\`.`
      );
    }
    if (wantKind === 'whats_included') {
      cheatSheet.push(
        `Recommend graphic-render (or fal): typographic asset listing the deliverables on the brief's palette.`
      );
    }

    const hint = [
      `Target: ${spec.purpose}`,
      `Dims: ${spec.dims_recommended}`,
      `Style: ${spec.style_notes}`,
      `Product context: ${input.product_name}${input.design_mood ? ` — ${input.design_mood}` : ''}`,
      ...cheatSheet,
    ].join(' | ');

    slots.push({
      slot: i + 1,
      kind: wantKind,
      status: 'missing',
      generation_hint: hint,
      spec: {
        purpose: spec.purpose,
        dims_recommended: spec.dims_recommended,
        style_notes: spec.style_notes,
      },
    });
  }

  return slots;
}
