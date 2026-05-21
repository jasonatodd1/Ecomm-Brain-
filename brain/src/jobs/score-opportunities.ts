import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const MIN_REDDIT_UPVOTES = 3;
const REDDIT_NAME_LIMIT = 60;

// Default niche tag when no source-derived niche is available (Google Trends
// keywords aren't subreddit-bound). Matches the convention used by the
// Research Agent's nicheTag fallback in src/agents/research/index.ts.
const DEFAULT_NICHE = 'general';

interface Signal {
  source: string;
  keyword: string;
  metric_type: string;
  value: number;
  collected_at: string;
  metadata: Record<string, unknown>;
}

interface OpportunityUpsert {
  name: string;
  description: string;
  niche: string;
  confidence_score: number;
  status: 'new' | 'investigating';
  search_volume: number;
  velocity: number;
  source_count: number;
  metadata: Record<string, unknown>;
  updated_at: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Source-count helpers — count the distinct observations in the signals table
// that back each opportunity. Replaces the previous hard-coded 1 (data-quality
// bug 2). Reads from the already-fetched signals array — no extra DB hits.
//
// Google Trends: count rows where source='google_trends' AND keyword matches.
//   Bumps once per collection run per keyword (interest_score + velocity +
//   rising_related_count = 3 rows per run, so this surfaces collection
//   recency as well as signal multiplicity).
//
// Reddit buyer-intent: count rows where the same post_id has been re-observed.
//   For a single buyer-intent post, source_count starts at 1 and bumps each
//   time the same Reddit post gets re-classified across collection runs (i.e.
//   the post stayed in r/<sub>/new long enough to be picked up again).
// ---------------------------------------------------------------------------

function buildTrendsSourceCountIndex(signals: Signal[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of signals) {
    if (s.source !== 'google_trends') continue;
    counts.set(s.keyword, (counts.get(s.keyword) ?? 0) + 1);
  }
  return counts;
}

function buildRedditSourceCountIndex(signals: Signal[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of signals) {
    if (s.source !== 'reddit') continue;
    if (s.metric_type !== 'buyer_intent_post') continue;
    const postId =
      typeof s.metadata['post_id'] === 'string'
        ? s.metadata['post_id']
        : null;
    if (!postId) continue;
    counts.set(postId, (counts.get(postId) ?? 0) + 1);
  }
  return counts;
}

async function fetchRecentSignals(): Promise<Signal[]> {
  const { data, error } = await supabase
    .from('signals')
    .select('source, keyword, metric_type, value, collected_at, metadata')
    .gte('collected_at', SEVEN_DAYS_AGO);

  if (error) {
    throw new Error(`Failed to fetch signals: ${error.message}`);
  }

  return (data ?? []) as Signal[];
}

// ---------------------------------------------------------------------------
// Pass A — Google Trends keywords
// ---------------------------------------------------------------------------

function scoreGoogleTrends(signals: Signal[]): OpportunityUpsert[] {
  const trendsSignals = signals.filter(s => s.source === 'google_trends');
  const sourceCountByKeyword = buildTrendsSourceCountIndex(signals);

  // Group by keyword, keeping the most recent row per metric_type
  const byKeyword = new Map<string, { interestScore: number; velocityRaw: number }>();

  for (const sig of trendsSignals) {
    const entry = byKeyword.get(sig.keyword) ?? { interestScore: 0, velocityRaw: 0 };

    if (sig.metric_type === 'interest_score') {
      entry.interestScore = sig.value;
    } else if (sig.metric_type === 'velocity') {
      entry.velocityRaw = sig.value;
    }

    byKeyword.set(sig.keyword, entry);
  }

  const results: OpportunityUpsert[] = [];

  for (const [keyword, { interestScore, velocityRaw }] of byKeyword) {
    const velocityCapped = clamp(velocityRaw, -100, 100);
    const confidence = clamp(interestScore / 100 + velocityCapped / 200, 0, 1);

    const opportunity: OpportunityUpsert = {
      name: keyword,
      description:
        `${keyword} | interest=${interestScore.toFixed(1)}, ` +
        `velocity=${velocityRaw.toFixed(1)}%, signal=google_trends`,
      niche: DEFAULT_NICHE,
      confidence_score: confidence,
      status: confidence > 0.4 ? 'new' : 'investigating',
      search_volume: interestScore,
      velocity: velocityRaw,
      source_count: sourceCountByKeyword.get(keyword) ?? 1,
      metadata: { source: 'google_trends', via: 'serpapi' },
      updated_at: new Date().toISOString()
    };

    results.push(opportunity);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pass B — Reddit buyer-intent posts
// ---------------------------------------------------------------------------

function scoreReddit(signals: Signal[]): OpportunityUpsert[] {
  const redditSignals = signals.filter(
    s =>
      s.source === 'reddit' &&
      s.metric_type === 'buyer_intent_post' &&
      s.value >= MIN_REDDIT_UPVOTES
  );
  const sourceCountByPostId = buildRedditSourceCountIndex(signals);

  // Dedupe — if the same post_id appears multiple times in the time window
  // (re-observed across runs), score the most-upvoted observation once.
  // Without this, source_count was always 1 because the most recent insert
  // overwrote prior ones via name-based onConflict — but we also produced
  // N duplicate upsert calls per re-observed post. Cleaner to dedupe here.
  const byPostId = new Map<string, Signal>();
  for (const sig of redditSignals) {
    const postId =
      typeof sig.metadata['post_id'] === 'string'
        ? sig.metadata['post_id']
        : null;
    if (!postId) continue;
    const existing = byPostId.get(postId);
    if (!existing || sig.value > existing.value) {
      byPostId.set(postId, sig);
    }
  }

  return [...byPostId.values()].map(sig => {
    const postId =
      typeof sig.metadata['post_id'] === 'string'
        ? sig.metadata['post_id']
        : '';
    const title =
      typeof sig.metadata['title'] === 'string' ? sig.metadata['title'] : sig.keyword;
    const subreddit =
      typeof sig.metadata['subreddit'] === 'string' ? sig.metadata['subreddit'] : 'reddit';
    // Read post_url (new key) with url fallback (legacy key pre-data-quality fix).
    const postUrl =
      typeof sig.metadata['post_url'] === 'string'
        ? sig.metadata['post_url']
        : typeof sig.metadata['url'] === 'string'
          ? sig.metadata['url']
          : '';

    const truncatedTitle =
      title.length > REDDIT_NAME_LIMIT ? title.slice(0, REDDIT_NAME_LIMIT) : title;
    const name = `Reddit buyer: ${truncatedTitle} (${subreddit})`;

    const confidence = clamp(0.5 + sig.value / 40, 0, 1);

    return {
      name,
      description:
        `${name} | interest=0, velocity=0%, signal=reddit_buyer_intent`,
      niche: subreddit,
      confidence_score: confidence,
      status: 'new' as const,
      search_volume: 0,
      velocity: 0,
      source_count: (postId && sourceCountByPostId.get(postId)) || 1,
      metadata: {
        source: 'reddit',
        subreddit,
        post_id: postId,
        post_url: postUrl,
        title,
        upvotes: sig.value
      },
      updated_at: new Date().toISOString()
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();

  await log({
    agent: 'intel',
    action: 'scoring.start',
    description: 'Opportunity scoring starting'
  });

  const signals = await fetchRecentSignals();

  const gtrendsOpps = scoreGoogleTrends(signals);
  const redditOpps = scoreReddit(signals);
  const allOpps = [...gtrendsOpps, ...redditOpps];

  let totalUpserted = 0;
  let topConfidence = 0;

  for (const opp of allOpps) {
    const { error } = await supabase
      .from('opportunities')
      .upsert(opp, { onConflict: 'name' });

    if (error) {
      console.error(`  fail upsert "${opp.name}":`, error.message);
      continue;
    }

    totalUpserted++;
    if (opp.confidence_score > topConfidence) {
      topConfidence = opp.confidence_score;
    }

    console.log(
      `  ok   "${opp.name}": confidence=${opp.confidence_score.toFixed(3)} status=${opp.status}`
    );
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  console.log(
    `[summary] gtrends_scored=${gtrendsOpps.length} reddit_scored=${redditOpps.length} ` +
      `total_upserted=${totalUpserted} top_confidence=${topConfidence.toFixed(3)}`
  );

  try {
    await log({
      agent: 'intel',
      action: 'scoring.complete',
      description:
        `Scoring done: ${gtrendsOpps.length} trends + ${redditOpps.length} reddit = ` +
        `${totalUpserted} upserted in ${durationSec}s`,
      severity: totalUpserted === 0 ? 'warning' : 'success',
      metadata: {
        gtrends_scored: gtrendsOpps.length,
        reddit_scored: redditOpps.length,
        total_upserted: totalUpserted,
        top_confidence: topConfidence,
        duration_sec: durationSec
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scoring.complete failed to write to activity table]: ${msg}`);
  }
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
