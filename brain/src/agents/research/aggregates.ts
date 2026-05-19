import type { EtsySearchResult } from './types.js';

export type MarketAggregates = {
  listings_analyzed: number;
  median_price: number;
  price_range: { p25: number; p50: number; p75: number };
  median_review_count: number;
  top_sellers: Array<{
    shop_name: string;
    shop_url: string;
    listing_title: string;
    listing_url: string;
    price: number;
    review_count: number;
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

export function computeAggregates(
  listings: EtsySearchResult[]
): MarketAggregates {
  // Only listings with both price and review_count count toward stats.
  const filtered = listings.filter(
    (l): l is EtsySearchResult & { price: number; reviews: number } =>
      typeof l.price === 'number' && typeof l.reviews === 'number'
  );

  if (filtered.length === 0) {
    return {
      listings_analyzed: 0,
      median_price: 0,
      price_range: { p25: 0, p50: 0, p75: 0 },
      median_review_count: 0,
      top_sellers: []
    };
  }

  const prices = filtered.map(l => l.price).sort((a, b) => a - b);
  const reviews = filtered.map(l => l.reviews).sort((a, b) => a - b);

  const p25 = round2(percentile(prices, 25));
  const p50 = round2(percentile(prices, 50));
  const p75 = round2(percentile(prices, 75));

  const medianReviews = Math.round(percentile(reviews, 50));

  const topSellers = [...filtered]
    .sort((a, b) => b.reviews - a.reviews)
    .slice(0, 5)
    .map(l => ({
      shop_name: l.shop_name,
      shop_url: l.shop_url,
      listing_title: l.title,
      listing_url: l.url,
      price: round2(l.price),
      review_count: l.reviews
    }));

  return {
    listings_analyzed: filtered.length,
    median_price: p50,
    price_range: { p25, p50, p75 },
    median_review_count: medianReviews,
    top_sellers: topSellers
  };
}
