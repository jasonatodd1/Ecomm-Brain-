import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const SUBREDDITS = [
  'Etsy',
  'EtsySellers',
  'planneraddicts',
  'PlannerCommunity',
  'printables',
  'handmade',
  'cricut'
];

const BUYER_INTENT_PATTERNS = [
  /\bi('m| am)?\s+looking\s+for\b/i,
  /\bdoes\s+(anyone|anybody)\s+(make|sell|have|know)\b/i,
  /\b(can|could)\s+(anyone|someone)\s+(make|create|recommend)\b/i,
  /\b(any|good)\s+recommendations?\s+for\b/i,
  /\bi\s+wish\s+(there\s+was|i\s+could\s+find)\b/i,
  /\b(searching|hunting|hoping)\s+for\b/i,
  /\bwhere\s+(can\s+i|to)\s+(find|get|buy)\b/i,
  /\bbest\s+(place|site|shop|seller)\s+(to|for)\b/i
];

const USER_AGENT = 'brain-orchestrator/0.0.1 (autonomous ecommerce intel)';
const POLITENESS_MS = 2000;
const POSTS_PER_SUB = 50;

interface RedditPost {
  data: {
    id: string;
    title: string;
    selftext: string;
    permalink: string;
    score: number;
    num_comments: number;
    created_utc: number;
    subreddit: string;
  };
}

interface RedditListing {
  data: {
    children: RedditPost[];
  };
}

async function fetchSubreddit(subreddit: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${POSTS_PER_SUB}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!res.ok) {
    throw new Error(`Reddit returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as RedditListing;
  return data.data?.children ?? [];
}

function hasBuyerIntent(text: string): boolean {
  if (!text) return false;
  return BUYER_INTENT_PATTERNS.some(p => p.test(text));
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await log({
    agent: 'intel',
    action: 'reddit.start',
    description: `Reddit scan starting: ${SUBREDDITS.length} subreddits`
  });

  let totalPosts = 0;
  let buyerIntentPosts = 0;
  let succeeded = 0;
  let failed = 0;

  for (const subreddit of SUBREDDITS) {
    try {
      const posts = await fetchSubreddit(subreddit);

      const { error: countErr } = await supabase.from('signals').insert({
        source: 'reddit',
        keyword: subreddit,
        metric_type: 'new_post_count',
        value: posts.length,
        metadata: { subreddit, sort: 'new' }
      });

      if (countErr) {
        console.error(`  insert error r/${subreddit}:`, countErr.message);
      }

      const intentHits = posts.filter(
        p =>
          hasBuyerIntent(p.data.title) || hasBuyerIntent(p.data.selftext ?? '')
      );

      if (intentHits.length > 0) {
        const intentRows = intentHits.map(p => ({
          source: 'reddit',
          keyword: subreddit,
          metric_type: 'buyer_intent_post',
          value: p.data.score,
          metadata: {
            subreddit,
            post_id: p.data.id,
            title: p.data.title,
            text_preview: (p.data.selftext ?? '').slice(0, 500),
            url: `https://reddit.com${p.data.permalink}`,
            score: p.data.score,
            num_comments: p.data.num_comments,
            created_utc: p.data.created_utc
          }
        }));

        const { error: intentErr } = await supabase
          .from('signals')
          .insert(intentRows);
        if (intentErr) {
          console.error(`  intent insert error r/${subreddit}:`, intentErr.message);
        }
      }

      totalPosts += posts.length;
      buyerIntentPosts += intentHits.length;
      succeeded++;

      console.log(
        `  ok r/${subreddit}: ${posts.length} posts, ${intentHits.length} buyer-intent`
      );

      await new Promise(r => setTimeout(r, POLITENESS_MS));
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  error r/${subreddit}: ${msg}`);
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  await log({
    agent: 'intel',
    action: 'reddit.complete',
    description: `Reddit scan done: ${succeeded}/${SUBREDDITS.length} subreddits, ${totalPosts} posts scanned, ${buyerIntentPosts} buyer-intent signals in ${durationSec}s`,
    severity: failed > 0 ? 'warning' : 'success',
    metadata: {
      succeeded,
      failed,
      total_posts: totalPosts,
      buyer_intent_count: buyerIntentPosts,
      duration_sec: durationSec
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
