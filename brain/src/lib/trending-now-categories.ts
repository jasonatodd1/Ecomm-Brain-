/**
 * Consumer-relevant Google Trends Trending Now categories.
 * IDs verified against https://serpapi.com/google-trends-trending-now-categories.json
 * at module load (2026-05-22).
 *
 * Excluded (no product signal): 3 Business & Finance, 10 Law & Government,
 * 14 Politics, 20 Climate.
 */
export const TRENDING_NOW_CATEGORIES: ReadonlyArray<{
  id: number;
  name: string;
}> = [
  { id: 1, name: 'Autos and Vehicles' },
  { id: 2, name: 'Beauty and Fashion' },
  { id: 4, name: 'Entertainment' },
  { id: 5, name: 'Food and Drink' },
  { id: 6, name: 'Games' },
  { id: 7, name: 'Health' },
  { id: 8, name: 'Hobbies and Leisure' },
  { id: 9, name: 'Jobs and Education' },
  { id: 11, name: 'Other' },
  { id: 13, name: 'Pets and Animals' },
  { id: 15, name: 'Science' },
  { id: 16, name: 'Shopping' },
  { id: 17, name: 'Sports' },
  { id: 18, name: 'Technology' },
  { id: 19, name: 'Travel and Transportation' }
] as const;

const OFFICIAL_CATEGORY_URL =
  'https://serpapi.com/google-trends-trending-now-categories.json';

/** Verify our hardcoded IDs match SerpApi's published list. Throws on mismatch. */
export async function verifyTrendingNowCategories(): Promise<void> {
  const res = await fetch(OFFICIAL_CATEGORY_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch SerpApi category list: HTTP ${res.status}`
    );
  }
  const official = (await res.json()) as Record<string, string>;

  for (const cat of TRENDING_NOW_CATEGORIES) {
    const key = String(cat.id);
    const officialName = official[key];
    if (!officialName) {
      throw new Error(
        `Category id ${cat.id} (${cat.name}) missing from SerpApi official list`
      );
    }
    if (officialName !== cat.name) {
      throw new Error(
        `Category id ${cat.id} name mismatch: local="${cat.name}" official="${officialName}"`
      );
    }
  }
}

export function nicheFromCategories(
  categories: Array<{ id: number; name: string }>
): string {
  if (categories.length === 0) return 'trending';
  const primary = categories[0].name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return primary || 'trending';
}
