import { log } from './log.js';
import type { EtsySearchResult } from '../agents/research/types.js';

const ESTIMATED_COST_USD = 0.15;

interface SerpApiEtsyOrganicResult {
  position?: number;
  title?: string;
  price?: string | { from?: string; to?: string };
  extracted_price?: number;
  rating?: number;
  reviews?: number;
  link?: string;
  shop_name?: string;
  shop_link?: string;
  shop_url?: string;
  thumbnail?: string;
}

interface SerpApiEtsyResponse {
  error?: string;
  organic_results?: SerpApiEtsyOrganicResult[];
}

function parsePrice(raw: SerpApiEtsyOrganicResult): number | null {
  if (typeof raw.extracted_price === 'number') return raw.extracted_price;

  if (typeof raw.price === 'string') {
    const match = raw.price.match(/[\d.]+/);
    if (match) return parseFloat(match[0]);
  }

  if (raw.price && typeof raw.price === 'object' && typeof raw.price.from === 'string') {
    const match = raw.price.from.match(/[\d.]+/);
    if (match) return parseFloat(match[0]);
  }

  return null;
}

export async function searchEtsy(
  query: string,
  options: { num?: number } = {}
): Promise<EtsySearchResult[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error('Missing SERPAPI_KEY environment variable');
  }

  const num = options.num ?? 10;
  const params = new URLSearchParams({
    engine: 'etsy',
    etsy_query: query,
    api_key: apiKey
  });

  try {
    const res = await fetch(`https://serpapi.com/search.json?${params.toString()}`);

    if (!res.ok) {
      throw new Error(`SerpApi returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as SerpApiEtsyResponse;

    if (data.error) {
      throw new Error(`SerpApi error: ${data.error}`);
    }

    await log({
      agent: 'intel',
      action: 'cost.api_call',
      description: `SerpApi Etsy search: "${query}"`,
      metadata: {
        provider: 'serpapi',
        engine: 'etsy',
        query,
        estimated_cost_usd: ESTIMATED_COST_USD
      }
    });

    const results = (data.organic_results ?? []).slice(0, num);

    return results.map<EtsySearchResult>(r => ({
      title: r.title ?? '',
      price: parsePrice(r),
      rating: typeof r.rating === 'number' ? r.rating : null,
      reviews: typeof r.reviews === 'number' ? r.reviews : null,
      url: r.link ?? '',
      shop_name: r.shop_name ?? '',
      shop_url: r.shop_url ?? r.shop_link ?? '',
      thumbnail: r.thumbnail ?? ''
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await log({
      agent: 'intel',
      action: 'etsy_search.failed',
      description: `Etsy search failed for "${query}"`,
      severity: 'warning',
      metadata: { query, error: msg }
    });

    return [];
  }
}
