import { getShop } from '../../lib/etsy-search.js';
import { mapWithLimit } from '../../lib/concurrency.js';
import type { EtsySearchResult } from './types.js';

export type MarketAggregates = {
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
    shop_review_count?: number;
    shop_review_average?: number;
  }>;
};

// Linear-interpolation percentile on an ascending-sorted array.
// idx = (n-1) * p/100; result = a[k] + (a[k+1] - a[k]) * frac
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const idx = (sorted.length - 1) * (p / 100);
  const k = Math.floor(idx);
  const frac = idx - k;

  if (k + 1 < sorted.length) {
    return sorted[k] + (sorted[k + 1] - sorted[k]) * frac;
  }
  return sorted[k];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function computeAggregates(
  listings: EtsySearchResult[]
): Promise<MarketAggregates> {
  // Only listings with both price and num_favorers count toward stats.
  const filtered = listings.filter(
    (l): l is EtsySearchResult & { price: number; num_favorers: number } =>
      typeof l.price === 'number' && typeof l.num_favorers === 'number'
  );

  if (filtered.length === 0) {
    return {
      listings_analyzed: 0,
      median_price: 0,
      price_range: { p25: 0, p50: 0, p75: 0 },
      median_favorers: 0,
      top_sellers: []
    };
  }

  const prices = filtered.map(l => l.price).sort((a, b) => a - b);
  const favorers = filtered.map(l => l.num_favorers).sort((a, b) => a - b);

  const p25 = round2(percentile(prices, 25));
  const p50 = round2(percentile(prices, 50));
  const p75 = round2(percentile(prices, 75));

  const medianFavorers = Math.round(percentile(favorers, 50));

  const top5 = [...filtered]
    .sort((a, b) => b.num_favorers - a.num_favorers)
    .slice(0, 5);

  // Enrich the top 5 with shop_name/url/review data (rate-limited: 2 in-flight,
  // 200ms stagger — Etsy 429'd 5/5 parallel calls in v2 of this code).
  // /listings/active doesn't return shop info at our app tier (silently drops
  // `includes=Shop`), so we have to do a per-shop fetch. Etsy API is free.
  const enrichedTop5 = await mapWithLimit(top5, 2, 200, async listing => {
    const shop = listing.shop_id > 0 ? await getShop(listing.shop_id) : null;
    return {
      shop_name: shop?.shop_name ?? '',
      shop_url: shop?.shop_url ?? '',
      listing_title: listing.title,
      listing_url: listing.url,
      price: round2(listing.price),
      num_favorers: listing.num_favorers,
      shop_review_count: shop?.review_count,
      shop_review_average: shop?.review_average
    };
  });

  return {
    listings_analyzed: filtered.length,
    median_price: p50,
    price_range: { p25, p50, p75 },
    median_favorers: medianFavorers,
    top_sellers: enrichedTop5
  };
}
