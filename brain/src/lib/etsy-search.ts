import { log } from './log.js';
import type { EtsySearchResult } from '../agents/research/types.js';

// Validate keystring presence at module load; fail fast with a clear error.
const ETSY_API_KEYSTRING = process.env.ETSY_API_KEYSTRING;

if (!ETSY_API_KEYSTRING) {
  throw new Error(
    'Missing ETSY_API_KEYSTRING environment variable. ' +
      'Add it to .env.local (and Railway Variables) — get one from https://www.etsy.com/developers/your-apps after app approval.'
  );
}

const ETSY_ENDPOINT = 'https://openapi.etsy.com/v3/application/listings/active';
const DEFAULT_LIMIT = 25;
const MAX_DESCRIPTION_PREVIEW = 500;

interface EtsyPrice {
  amount?: number;
  divisor?: number;
  currency_code?: string;
}

interface EtsyShop {
  shop_name?: string;
  url?: string;
}

interface EtsyImage {
  url_570xN?: string;
}

interface EtsyListing {
  listing_id?: number;
  title?: string;
  url?: string;
  description?: string;
  price?: EtsyPrice;
  num_favorers?: number;
  Shop?: EtsyShop;
  shop?: EtsyShop;
  Images?: EtsyImage[];
  images?: EtsyImage[];
}

interface EtsyListingsActiveResponse {
  count?: number;
  results?: EtsyListing[];
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

export async function searchEtsy(
  query: string,
  options: { limit?: number } = {}
): Promise<EtsySearchResult[]> {
  const limit = Math.min(100, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const params = new URLSearchParams({
    keywords: query,
    limit: String(limit),
    includes: 'Shop,Images'
  });

  const url = `${ETSY_ENDPOINT}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'x-api-key': ETSY_API_KEYSTRING as string,
        Accept: 'application/json'
      }
    });
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
    const shop = l.Shop ?? l.shop ?? {};
    const images = l.Images ?? l.images ?? [];
    const description = typeof l.description === 'string' ? l.description : '';

    return {
      listing_id: typeof l.listing_id === 'number' ? l.listing_id : 0,
      title: typeof l.title === 'string' ? l.title : '',
      price: parsePrice(l.price),
      currency:
        typeof l.price?.currency_code === 'string' ? l.price.currency_code : 'USD',
      url: typeof l.url === 'string' ? l.url : '',
      shop_name: typeof shop.shop_name === 'string' ? shop.shop_name : '',
      shop_url: typeof shop.url === 'string' ? shop.url : '',
      num_favorers:
        typeof l.num_favorers === 'number' ? l.num_favorers : null,
      image_url:
        typeof images[0]?.url_570xN === 'string' ? images[0].url_570xN : undefined,
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
