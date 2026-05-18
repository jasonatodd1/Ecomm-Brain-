import 'dotenv/config';
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const MIN_REDDIT_UPVOTES = 3;
const REDDIT_NAME_LIMIT = 60;

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
      confidence_score: confidence,
      status: confidence > 0.4 ? 'new' : 'investigating',
      search_volume: interestScore,
      velocity: velocityRaw,
      source_count: 1,
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

  return redditSignals.map(sig => {
    const title =
      typeof sig.metadata['title'] === 'string' ? sig.metadata['title'] : sig.keyword;
    const subreddit =
      typeof sig.metadata['subreddit'] === 'string' ? sig.metadata['subreddit'] : 'reddit';
    const postUrl =
      typeof sig.metadata['url'] === 'string' ? sig.metadata['url'] : '';

    const truncatedTitle =
      title.length > REDDIT_NAME_LIMIT ? title.slice(0, REDDIT_NAME_LIMIT) : title;
    const name = `Reddit buyer: ${truncatedTitle} (${subreddit})`;

    const confidence = clamp(0.5 + sig.value / 40, 0, 1);

    return {
      name,
      description:
        `${name} | interest=0, velocity=0%, signal=reddit_buyer_intent`,
      confidence_score: confidence,
      status: 'new' as const,
      search_volume: 0,
      velocity: 0,
      source_count: 1,
      metadata: {
        source: 'reddit',
        subreddit,
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
