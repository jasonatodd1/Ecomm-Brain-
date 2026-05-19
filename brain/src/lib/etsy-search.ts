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
      title: typeof l.title === 'string' ? l.title : '',
      price: parsePrice(l.price),
      currency:
        typeof l.price?.currency_code === 'string'
          ? l.price.currency_code
          : 'USD',
      url: typeof l.url === 'string' ? l.url : '',
      num_favorers:
        typeof l.num_favorers === 'number' ? l.num_favorers : null,
      description_preview: description.slice(0, MAX_DESCRIPTION_PREVIEW)
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
    shop_name: typeof data.shop_name === 'string' ? data.shop_name : '',
    shop_url: typeof data.url === 'string' ? data.url : '',
    review_count: typeof data.review_count === 'number' ? data.review_count : 0,
    review_average:
      typeof data.review_average === 'number' ? data.review_average : 0
  };
}
