// Etsy seller-taxonomy fetchers + breadcrumb → taxonomy_id resolver.
//
// Used by the Listing Agent (LISTING_AGENT_REQUIREMENTS.md §3) to answer two
// runtime questions per publish:
//   1. What numeric taxonomy_id corresponds to brief.listing.etsy_category?
//   2. For that taxonomy_id, what attribute slots exist and what
//      `possible_values` does each accept?
//
// Authoritative endpoints:
//   GET /v3/application/seller-taxonomy/nodes                    — full tree
//   GET /v3/application/seller-taxonomy/nodes/{id}/properties    — per-node
//
// Both are application-tier (x-api-key only, no OAuth). Caching is file-based
// under `dist/.cache/etsy-taxonomy/` (gitignored — already covered by
// `dist/` rules) with conservative TTLs because taxonomy structure changes
// rarely. Cache invalidation on publish 4xx is a Phase 2 concern (no
// publish in v1).
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { log } from './log.js';

const ETSY_API_KEYSTRING = process.env.ETSY_API_KEYSTRING;
const ETSY_SHARED_SECRET = process.env.ETSY_SHARED_SECRET;

if (!ETSY_API_KEYSTRING || !ETSY_SHARED_SECRET) {
  throw new Error(
    'etsy-taxonomy.ts requires ETSY_API_KEYSTRING and ETSY_SHARED_SECRET'
  );
}

const ETSY_HEADERS = {
  'x-api-key': `${ETSY_API_KEYSTRING}:${ETSY_SHARED_SECRET}`,
  Accept: 'application/json',
};

const CACHE_DIR = path.resolve(process.cwd(), 'dist/.cache/etsy-taxonomy');
const NODES_TTL_MS = 24 * 60 * 60 * 1000;       // 24 h
const PROPERTIES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 d

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface TaxonomyNode {
  id: number;
  level: number;
  name: string;
  parent_id: number | null;
  children: TaxonomyNode[];
  full_path_taxonomy_ids: number[];
}

export interface TaxonomyPossibleValue {
  value_id: number;
  name: string;
  scale_id?: number;
  equal_to?: number[];
}

export interface TaxonomyProperty {
  property_id: number;
  name: string;
  display_name: string;
  scales: Array<{ scale_id?: number; display_name?: string; description?: string }>;
  is_required: boolean;
  supports_attributes: boolean;
  supports_variations: boolean;
  is_multivalued: boolean;
  possible_values: TaxonomyPossibleValue[];
  selected_values: TaxonomyPossibleValue[];
}

interface NodesResponse {
  count: number;
  results: TaxonomyNode[];
}

interface PropertiesResponse {
  count: number;
  results: TaxonomyProperty[];
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------
async function readCache<T>(file: string, ttlMs: number): Promise<T | null> {
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs > ttlMs) return null;
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeCache(file: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload), 'utf-8');
}

// ---------------------------------------------------------------------------
// In-memory cache (per-process — avoids repeated disk reads in one run)
// ---------------------------------------------------------------------------
let nodesCache: TaxonomyNode[] | null = null;
const propertiesCache = new Map<number, TaxonomyProperty[]>();

// ---------------------------------------------------------------------------
// getTaxonomyNodes — full Etsy seller taxonomy tree.
// Cached file: dist/.cache/etsy-taxonomy/nodes.json (24h TTL).
// ---------------------------------------------------------------------------
export async function getTaxonomyNodes(): Promise<TaxonomyNode[]> {
  if (nodesCache) return nodesCache;

  const file = path.join(CACHE_DIR, 'nodes.json');
  const disk = await readCache<TaxonomyNode[]>(file, NODES_TTL_MS);
  if (disk) {
    nodesCache = disk;
    return disk;
  }

  const url = 'https://openapi.etsy.com/v3/application/seller-taxonomy/nodes';
  const res = await fetch(url, { headers: ETSY_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `getTaxonomyNodes failed: HTTP ${res.status} ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as NodesResponse;
  const nodes = data.results ?? [];
  nodesCache = nodes;
  await writeCache(file, nodes);

  await log({
    agent: 'listing',
    action: 'taxonomy.nodes_fetched',
    description: `Etsy seller taxonomy fetched — ${nodes.length} top-level nodes`,
    metadata: { source: 'etsy_api', cached: false, count: nodes.length },
  });

  return nodes;
}

// ---------------------------------------------------------------------------
// getTaxonomyProperties — properties + possible_values for ONE taxonomy node.
// Cached per id: dist/.cache/etsy-taxonomy/properties-<id>.json (7d TTL).
// ---------------------------------------------------------------------------
export async function getTaxonomyProperties(
  taxonomyId: number
): Promise<TaxonomyProperty[]> {
  const inMem = propertiesCache.get(taxonomyId);
  if (inMem) return inMem;

  const file = path.join(CACHE_DIR, `properties-${taxonomyId}.json`);
  const disk = await readCache<TaxonomyProperty[]>(file, PROPERTIES_TTL_MS);
  if (disk) {
    propertiesCache.set(taxonomyId, disk);
    return disk;
  }

  const url = `https://openapi.etsy.com/v3/application/seller-taxonomy/nodes/${taxonomyId}/properties`;
  const res = await fetch(url, { headers: ETSY_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `getTaxonomyProperties(${taxonomyId}) failed: HTTP ${res.status} ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as PropertiesResponse;
  const props = data.results ?? [];
  propertiesCache.set(taxonomyId, props);
  await writeCache(file, props);

  await log({
    agent: 'listing',
    action: 'taxonomy.properties_fetched',
    description: `Properties fetched for taxonomy ${taxonomyId} (${props.length})`,
    metadata: {
      taxonomy_id: taxonomyId,
      property_count: props.length,
      property_names: props.map(p => p.name),
    },
  });

  return props;
}

// ---------------------------------------------------------------------------
// Breadcrumb resolution
// ---------------------------------------------------------------------------

export interface BreadcrumbResolution {
  taxonomy_id: number;
  /** Names actually matched, in order — may be shorter than the input crumbs. */
  matched_path: string[];
  /** Input crumbs that did NOT match. */
  unmatched_tail: string[];
  /** True when we had to walk up the tree from the requested breadcrumb. */
  fallback: boolean;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 &]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findChild(
  children: TaxonomyNode[],
  name: string
): TaxonomyNode | null {
  const want = normalize(name);
  if (!want) return null;

  // Exact (normalized) match first.
  for (const c of children) {
    if (normalize(c.name) === want) return c;
  }
  // Substring match (handles "Planners & Planner Accessories" → "Planners").
  for (const c of children) {
    const cn = normalize(c.name);
    if (cn.includes(want) || want.includes(cn)) return c;
  }
  // Token overlap fallback (≥1 meaningful token in common).
  const wantTokens = want.split(' ').filter(t => t.length >= 4);
  for (const c of children) {
    const cnTokens = normalize(c.name).split(' ').filter(t => t.length >= 4);
    if (cnTokens.some(t => wantTokens.includes(t))) return c;
  }
  return null;
}

/**
 * Resolve a brief's `etsy_category` breadcrumb to the deepest matching
 * taxonomy node. Accepts either a slash/`>`-delimited string or an array of
 * crumb names. Walks the tree from the root, descending child-by-child.
 * When a crumb doesn't match any child, returns the parent that DID match
 * and records the unmatched tail (`fallback: true`).
 *
 * Per LISTING_AGENT_REQUIREMENTS.md §5: "If the breadcrumb has no exact
 * match → walks up the tree until a match is found and logs
 * `taxonomy.fallback_to_parent`."
 *
 * Throws if even the first crumb doesn't match the root level — that's a
 * brief-data bug, not a fallback case.
 */
export async function mapBreadcrumbToTaxonomyId(
  breadcrumb: string | string[]
): Promise<BreadcrumbResolution> {
  const crumbs = Array.isArray(breadcrumb)
    ? breadcrumb.map(c => c.trim()).filter(Boolean)
    : breadcrumb
        .split(/\s*[>\/]\s*/)
        .map(c => c.trim())
        .filter(Boolean);

  if (crumbs.length === 0) {
    throw new Error('mapBreadcrumbToTaxonomyId: empty breadcrumb');
  }

  const roots = await getTaxonomyNodes();

  let cursor: TaxonomyNode | null = findChild(roots, crumbs[0]);
  if (!cursor) {
    throw new Error(
      `mapBreadcrumbToTaxonomyId: no root match for "${crumbs[0]}" (breadcrumb="${crumbs.join(' > ')}")`
    );
  }

  const matched: string[] = [cursor.name];
  let fallback = false;
  let unmatchedTail: string[] = [];

  for (let i = 1; i < crumbs.length; i++) {
    const next = findChild(cursor.children, crumbs[i]);
    if (!next) {
      fallback = true;
      unmatchedTail = crumbs.slice(i);
      break;
    }
    cursor = next;
    matched.push(cursor.name);
  }

  if (fallback) {
    await log({
      agent: 'listing',
      action: 'taxonomy.fallback_to_parent',
      description:
        `Breadcrumb "${crumbs.join(' > ')}" stopped at "${matched.join(' > ')}"` +
        ` (id=${cursor.id}); unmatched: "${unmatchedTail.join(' > ')}"`,
      severity: 'warning',
      metadata: {
        requested: crumbs,
        matched_path: matched,
        unmatched_tail: unmatchedTail,
        taxonomy_id: cursor.id,
      },
    });
  } else {
    await log({
      agent: 'listing',
      action: 'taxonomy.resolved',
      description: `Breadcrumb fully matched → taxonomy ${cursor.id}`,
      metadata: { breadcrumb: crumbs, taxonomy_id: cursor.id },
    });
  }

  return {
    taxonomy_id: cursor.id,
    matched_path: matched,
    unmatched_tail: unmatchedTail,
    fallback,
  };
}
