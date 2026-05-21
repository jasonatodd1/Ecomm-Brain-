import { log } from './log.js';
import type { EtsySearchResult } from '../agents/research/types.js';

// Validate credentials at module load; fail fast with a clear error.
// As of Feb 9, 2026 Etsy requires the x-api-key header to be formatted as
// `${keystring}:${shared_secret}` for all v3 endpoints, including public ones.
const ETSY_API_KEYSTRING = process.env.ETSY_API_KEYSTRING;
const ETSY_SHARED_SECRET = process.env.ETSY_SHARED_SECRET;

if (!ETSY_API_KEYSTRING) {
  throw new Error(
    'Missing ETSY_API_KEYSTRING environment variable. ' +
      'Add it to .env.local (and Railway Variables) — get one from https://www.etsy.com/developers/your-apps after app approval.'
  );
}

if (!ETSY_SHARED_SECRET) {
  throw new Error(
    'Missing ETSY_SHARED_SECRET environment variable. ' +
      'As of Feb 9, 2026 Etsy v3 requires both keystring and shared_secret in the x-api-key header. ' +
      'Add ETSY_SHARED_SECRET to .env.local (and Railway Variables).'
  );
}

const ETSY_AUTH_HEADER = `${ETSY_API_KEYSTRING}:${ETSY_SHARED_SECRET}`;
const ETSY_HEADERS = {
  'x-api-key': ETSY_AUTH_HEADER,
  Accept: 'application/json'
};

const LISTINGS_ACTIVE_ENDPOINT =
  'https://openapi.etsy.com/v3/application/listings/active';
const LISTINGS_ENDPOINT_BASE =
  'https://openapi.etsy.com/v3/application/listings';
const SHOPS_ENDPOINT_BASE = 'https://openapi.etsy.com/v3/application/shops';

const DEFAULT_LIMIT = 25;
const MAX_DESCRIPTION_PREVIEW = 500;

interface EtsyPrice {
  amount?: number;
  divisor?: number;
  currency_code?: string;
}

interface EtsyListing {
  listing_id?: number;
  shop_id?: number;
  title?: string;
  url?: string;
  description?: string;
  price?: EtsyPrice;
  num_favorers?: number;
}

interface EtsyListingsActiveResponse {
  count?: number;
  results?: EtsyListing[];
  error?: string;
}

interface EtsyShopResponse {
  shop_id?: number;
  shop_name?: string;
  url?: string;
  review_count?: number;
  review_average?: number;
  error?: string;
}

function parsePrice(price?: EtsyPrice): number | null {
  if (!price) return null;
  if (typeof price.amount !== 'number' || typeof price.divisor !== 'number') {
    return null;
  }
  if (price.divisor === 0) return null;
  return price.amount / price.divisor;
}

// Postgres jsonb rejects two classes of bytes that JSON.stringify happily
// emits:
//   1. \u0000 (NUL) + most C0 control chars. Etsy listing copy is the single
//      most common source — sellers paste decorative text from tools that
//      embed these bytes.
//   2. Lone UTF-16 surrogates. A surrogate code unit (\uD800-\uDFFF) is only
//      valid in a high/low pair encoding a supplementary character. Lone
//      surrogates arise from two real-world sources we hit in this project:
//        (a) Sellers using mathematical-bold/italic unicode (e.g. 𝑾𝒉𝒂𝒕)
//            in descriptions — when we slice description_preview to a fixed
//            char count below, the slice can land between the high/low
//            surrogate of one of those characters.
//        (b) Occasional LLM outputs that emit malformed surrogate sequences.
//      Strip lone surrogates so any downstream consumer of EtsySearchResult /
//      EtsyShopInfo / synthesized briefs is safe to insert into Supabase
//      jsonb without hitting the generic "Empty or invalid json" error.
function sanitizeForJsonb(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // C0 control chars EXCEPT \t (\x09), \n (\x0A), \r (\x0D).
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    ) {
      continue;
    }
    // High surrogate: must be followed by a low surrogate. If not, drop it.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue;
    }
    // Low surrogate appearing without a preceding high surrogate: drop it.
    // (Paired low surrogates were already consumed in the branch above.)
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// searchEtsy — public listing search.
// Note: the `includes=Shop,Images` query param is silently dropped at our app
// tier (verified empirically Feb 2026). Shop info must be fetched separately
// via getShop(shop_id). Images are not currently fetched.
// ---------------------------------------------------------------------------
export async function searchEtsy(
  query: string,
  options: { limit?: number } = {}
): Promise<EtsySearchResult[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const params = new URLSearchParams({
    keywords: query,
    limit: String(limit)
  });

  const url = `${LISTINGS_ACTIVE_ENDPOINT}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: ETSY_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'etsy_search.failed',
      description: `Network error during Etsy search "${query}"`,
      severity: 'warning',
      metadata: { query, error: msg }
    });
    return [];
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    const retryAfter = res.headers.get('retry-after');
    const meta: Record<string, unknown> = {
      query,
      status_code: res.status,
      response_body: bodyText.slice(0, 1000)
    };
    if (res.status === 429 && retryAfter) {
      meta['retry_after_seconds'] = retryAfter;
    }

    await log({
      agent: 'intel',
      action: 'etsy_search.failed',
      description: `Etsy API returned HTTP ${res.status} for "${query}"`,
      severity: 'warning',
      metadata: meta
    });
    return [];
  }

  let data: EtsyListingsActiveResponse;
  try {
    data = (await res.json()) as EtsyListingsActiveResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'etsy_search.failed',
      description: `Failed to parse Etsy JSON for "${query}"`,
      severity: 'warning',
      metadata: { query, error: msg }
    });
    return [];
  }

  if (data.error) {
    await log({
      agent: 'intel',
      action: 'etsy_search.failed',
      description: `Etsy API error for "${query}"`,
      severity: 'warning',
      metadata: { query, status_code: res.status, etsy_error: data.error }
    });
    return [];
  }

  const listings = data.results ?? [];

  const mapped: EtsySearchResult[] = listings.map(l => {
    const description = typeof l.description === 'string' ? l.description : '';
    return {
      listing_id: typeof l.listing_id === 'number' ? l.listing_id : 0,
      shop_id: typeof l.shop_id === 'number' ? l.shop_id : 0,
      title: sanitizeForJsonb(typeof l.title === 'string' ? l.title : ''),
      price: parsePrice(l.price),
      currency: sanitizeForJsonb(
        typeof l.price?.currency_code === 'string' ? l.price.currency_code : 'USD'
      ),
      url: sanitizeForJsonb(typeof l.url === 'string' ? l.url : ''),
      num_favorers:
        typeof l.num_favorers === 'number' ? l.num_favorers : null,
      description_preview: sanitizeForJsonb(
        description.slice(0, MAX_DESCRIPTION_PREVIEW)
      )
    };
  });

  await log({
    agent: 'intel',
    action: 'etsy_search.complete',
    description: `Etsy search "${query}" → ${mapped.length} listings`,
    metadata: {
      query,
      num_results: mapped.length,
      status_code: res.status
    }
  });

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: `Etsy API listings/active "${query}"`,
    metadata: {
      provider: 'etsy_api',
      engine: 'listings_active',
      estimated_cost_usd: 0
    }
  });

  return mapped;
}

// ---------------------------------------------------------------------------
// getShop — fetch shop_name, shop_url, and review aggregates for one shop_id.
// Returns null on any failure (fail soft). Cost-logs each call.
// ---------------------------------------------------------------------------
export interface EtsyShopInfo {
  shop_id: number;
  shop_name: string;
  shop_url: string;
  review_count: number;
  review_average: number;
}

export async function getShop(shopId: number): Promise<EtsyShopInfo | null> {
  if (!Number.isInteger(shopId) || shopId <= 0) return null;

  const url = `${SHOPS_ENDPOINT_BASE}/${shopId}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: ETSY_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'etsy_shop_fetch.failed',
      description: `Network error fetching shop ${shopId}`,
      severity: 'warning',
      metadata: { shop_id: shopId, error: msg }
    });
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    const retryAfter = res.headers.get('retry-after');
    const meta: Record<string, unknown> = {
      shop_id: shopId,
      status_code: res.status,
      response_body: bodyText.slice(0, 500)
    };
    if (res.status === 429 && retryAfter) {
      meta['retry_after_seconds'] = retryAfter;
    }

    await log({
      agent: 'intel',
      action: 'etsy_shop_fetch.failed',
      description: `Etsy shop fetch returned HTTP ${res.status} for shop ${shopId}`,
      severity: 'warning',
      metadata: meta
    });
    return null;
  }

  let data: EtsyShopResponse;
  try {
    data = (await res.json()) as EtsyShopResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'intel',
      action: 'etsy_shop_fetch.failed',
      description: `Failed to parse Etsy shop JSON for shop ${shopId}`,
      severity: 'warning',
      metadata: { shop_id: shopId, error: msg }
    });
    return null;
  }

  if (data.error) {
    await log({
      agent: 'intel',
      action: 'etsy_shop_fetch.failed',
      description: `Etsy API error for shop ${shopId}`,
      severity: 'warning',
      metadata: { shop_id: shopId, etsy_error: data.error }
    });
    return null;
  }

  await log({
    agent: 'intel',
    action: 'cost.api_call',
    description: `Etsy API shop ${shopId}`,
    metadata: {
      provider: 'etsy_api',
      engine: 'shop_fetch',
      estimated_cost_usd: 0
    }
  });

  return {
    shop_id: typeof data.shop_id === 'number' ? data.shop_id : shopId,
    shop_name: sanitizeForJsonb(
      typeof data.shop_name === 'string' ? data.shop_name : ''
    ),
    shop_url: sanitizeForJsonb(typeof data.url === 'string' ? data.url : ''),
    review_count: typeof data.review_count === 'number' ? data.review_count : 0,
    review_average:
      typeof data.review_average === 'number' ? data.review_average : 0
  };
}

// ---------------------------------------------------------------------------
// getListing — fetch a single listing's current state.
// Used by monitor-listings.ts for daily snapshots of OUR listings, but
// works for any public listing_id. Returns both a normalized struct and the
// full raw Etsy response so listings_stats can store the latter for
// future-proofing (new fields become queryable from history without re-fetch).
// ---------------------------------------------------------------------------
export interface EtsyListingDetails {
  listing_id: number;
  shop_id: number | null;
  state: string | null;
  title: string;
  url: string;
  description: string;
  tags: string[];
  views: number | null;
  num_favorers: number | null;
  price_cents: number | null;
  currency_code: string | null;
  /** Etsy returns seconds-since-epoch; null if absent. */
  last_modified_timestamp: number | null;
  /**
   * Shop section ID assigned to this listing. Null when the seller did not
   * assign one. Used by the SEO scorer as a category-signal proxy.
   */
  shop_section_id: number | null;
  /** Full Etsy response, sanitized for jsonb. */
  raw: Record<string, unknown>;
}

interface EtsyListingDetailsResponse extends EtsyListing {
  state?: string;
  views?: number;
  tags?: unknown;
  last_modified_timestamp?: number;
  shop_section_id?: number;
  error?: string;
}

// Recursively strip NUL/control bytes from any string value in a nested
// object/array so the full raw response is safe to insert into jsonb.
// Mirrors sanitizeForJsonb but walks the whole tree.
//
// Exported so other code paths writing arbitrary nested JSON into Supabase
// jsonb columns (e.g. LLM-synthesized briefs) can reuse the same scrubber
// rather than re-implement it.
export function sanitizeJsonbDeep(value: unknown): unknown {
  return sanitizeDeep(value);
}

function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeForJsonb(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out;
  }
  return value;
}

function priceToCents(price?: EtsyPrice): number | null {
  if (!price) return null;
  if (typeof price.amount !== 'number' || typeof price.divisor !== 'number') {
    return null;
  }
  if (price.divisor === 0) return null;
  // Etsy's amount/divisor representation: e.g. {amount: 349, divisor: 100} = $3.49.
  // To get cents reliably regardless of divisor, normalize to dollars then × 100.
  return Math.round((price.amount / price.divisor) * 100);
}

export async function getListing(
  listingId: number
): Promise<EtsyListingDetails | null> {
  if (!Number.isInteger(listingId) || listingId <= 0) return null;

  const url = `${LISTINGS_ENDPOINT_BASE}/${listingId}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: ETSY_HEADERS });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'listing',
      action: 'etsy_listing_fetch.failed',
      description: `Network error fetching listing ${listingId}`,
      severity: 'warning',
      metadata: { listing_id: listingId, error: msg }
    });
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>');
    const retryAfter = res.headers.get('retry-after');
    const meta: Record<string, unknown> = {
      listing_id: listingId,
      status_code: res.status,
      response_body: bodyText.slice(0, 500)
    };
    if (res.status === 429 && retryAfter) {
      meta['retry_after_seconds'] = retryAfter;
    }
    await log({
      agent: 'listing',
      action: 'etsy_listing_fetch.failed',
      description: `Etsy listing fetch returned HTTP ${res.status} for ${listingId}`,
      severity: 'warning',
      metadata: meta
    });
    return null;
  }

  let data: EtsyListingDetailsResponse;
  try {
    data = (await res.json()) as EtsyListingDetailsResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log({
      agent: 'listing',
      action: 'etsy_listing_fetch.failed',
      description: `Failed to parse Etsy listing JSON for ${listingId}`,
      severity: 'warning',
      metadata: { listing_id: listingId, error: msg }
    });
    return null;
  }

  if (data.error) {
    await log({
      agent: 'listing',
      action: 'etsy_listing_fetch.failed',
      description: `Etsy API error for listing ${listingId}`,
      severity: 'warning',
      metadata: { listing_id: listingId, etsy_error: data.error }
    });
    return null;
  }

  await log({
    agent: 'listing',
    action: 'cost.api_call',
    description: `Etsy API listing ${listingId}`,
    metadata: {
      provider: 'etsy_api',
      engine: 'listing_fetch',
      estimated_cost_usd: 0
    }
  });

  const tagsRaw = data.tags;
  const tags: string[] = Array.isArray(tagsRaw)
    ? tagsRaw
        .filter((t): t is string => typeof t === 'string')
        .map(t => sanitizeForJsonb(t))
    : [];

  return {
    listing_id: typeof data.listing_id === 'number' ? data.listing_id : listingId,
    shop_id: typeof data.shop_id === 'number' ? data.shop_id : null,
    state: typeof data.state === 'string' ? data.state : null,
    title: sanitizeForJsonb(typeof data.title === 'string' ? data.title : ''),
    url: sanitizeForJsonb(typeof data.url === 'string' ? data.url : ''),
    description: sanitizeForJsonb(
      typeof data.description === 'string' ? data.description : ''
    ),
    tags,
    views: typeof data.views === 'number' ? data.views : null,
    num_favorers:
      typeof data.num_favorers === 'number' ? data.num_favorers : null,
    price_cents: priceToCents(data.price),
    currency_code:
      typeof data.price?.currency_code === 'string'
        ? sanitizeForJsonb(data.price.currency_code)
        : null,
    last_modified_timestamp:
      typeof data.last_modified_timestamp === 'number'
        ? data.last_modified_timestamp
        : null,
    shop_section_id:
      typeof data.shop_section_id === 'number' ? data.shop_section_id : null,
    raw: sanitizeDeep(data) as Record<string, unknown>
  };
}
