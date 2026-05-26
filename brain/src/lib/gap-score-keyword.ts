import { searchEtsy } from './etsy-search.js';
import { computeCompetitiveLandscape } from '../agents/research/competitive.js';
import { scoreWhitespace } from './whitespace-scoring.js';
import type { EtsySearchResult } from '../agents/research/types.js';

const TOP_N = 10;
const SEARCH_LIMIT = 25;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'a', 'an', 'of', 'to', 'in', 'and'
]);

export interface CoherenceAssessment {
  result_count: number;
  coherence_score: number;
  flags: string[];
}

/** Fraction of top-5 titles sharing a significant query token (coherent product set proxy). */
export function assessSearchCoherence(
  keyword: string,
  results: EtsySearchResult[]
): CoherenceAssessment {
  const flags: string[] = [];
  const count = results.length;

  if (count < 5) {
    flags.push('low_etsy_results');
  }

  const queryTokens = keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));

  if (queryTokens.length === 0) {
    return { result_count: count, coherence_score: 0, flags: [...flags, 'incoherent_grab_bag'] };
  }

  const top5 = results.slice(0, 5);
  let matched = 0;
  for (const r of top5) {
    const title = r.title.toLowerCase();
    const hit = queryTokens.some(t => title.includes(t));
    if (hit) matched++;
  }

  const coherence_score = top5.length > 0 ? matched / top5.length : 0;
  if (coherence_score < 0.6) {
    flags.push('incoherent_grab_bag');
  }

  return { result_count: count, coherence_score, flags };
}

export interface GapScoreKeywordResult {
  keyword: string;
  landscape_entry: Awaited<
    ReturnType<typeof computeCompetitiveLandscape>
  >['landscape'][number];
  whitespace: ReturnType<typeof scoreWhitespace>;
  coherence: CoherenceAssessment;
  search_results: EtsySearchResult[];
  stats: Awaited<ReturnType<typeof computeCompetitiveLandscape>>['stats'];
}

export async function gapScoreKeyword(
  keyword: string,
  externalDemand: number,
  searchResults?: EtsySearchResult[]
): Promise<GapScoreKeywordResult> {
  const results = searchResults ?? (await searchEtsy(keyword, { limit: SEARCH_LIMIT }));
  const resultsByKeyword = new Map<string, EtsySearchResult[]>([[keyword, results]]);

  const competitive = await computeCompetitiveLandscape({
    keywords: [keyword],
    resultsByKeyword,
    topN: TOP_N
  });

  const entry = competitive.landscape[0];
  if (!entry) {
    throw new Error(`No landscape entry for "${keyword}"`);
  }

  const coherence = assessSearchCoherence(keyword, results);
  const whitespace = scoreWhitespace({
    external_demand: externalDemand,
    median_favorers: entry.median_favorers,
    median_shop_reviews: entry.median_shop_reviews,
    classification: entry.classification,
    median_seo_percent: entry.median_percent
  });

  return {
    keyword,
    landscape_entry: entry,
    whitespace,
    coherence,
    search_results: results,
    stats: competitive.stats
  };
}
