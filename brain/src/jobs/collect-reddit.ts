import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { classifyIntent } from '../lib/classify-intent.js';

const SUBREDDITS = [
  'Etsy',
  'EtsySellers',
  'planneraddicts',
  'PlannerCommunity',
  'printables',
  'handmade',
  'cricut'
];

// Community knowledge classification:
//   buyer  — predominantly consumers searching for products to purchase
//   seller — predominantly makers/sellers discussing shop, craft, platform
//   mixed  — meaningful mix of both; LLM call needed to distinguish
const SUBREDDIT_CATEGORIES: Record<string, 'buyer' | 'seller' | 'mixed'> = {
  Etsy: 'mixed',            // buyers searching + sellers discussing platform
  EtsySellers: 'seller',    // explicitly for Etsy shop owners; almost all seller perspective
  planneraddicts: 'buyer',  // planner enthusiasts looking to buy/find products
  PlannerCommunity: 'buyer',// same audience as planneraddicts, consumer-focused
  printables: 'mixed',      // people sharing free printables + people looking for them
  handmade: 'mixed',        // buyers seeking handmade goods + makers discussing craft
  cricut: 'mixed'           // Cricut owners buying SVG files + makers using machine to sell
};

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
const ESTIMATED_HAIKU_COST_USD = 0.001;

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
  let classifiedBuyer = 0;
  let classifiedSeller = 0;
  let classifiedOther = 0;
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

      const regexHits = posts.filter(
        p =>
          hasBuyerIntent(p.data.title) || hasBuyerIntent(p.data.selftext ?? '')
      );

      const category = SUBREDDIT_CATEGORIES[subreddit] ?? 'mixed';

      for (const p of regexHits) {
        let metricType: string;
        let llmIntent: string | null = null;
        let llmConfidence: number | null = null;

        if (category === 'seller') {
          // No LLM needed — whole subreddit is seller-perspective
          metricType = 'seller_pain_point';
        } else {
          // buyer or mixed — ask the classifier
          const result = await classifyIntent({
            title: p.data.title,
            body: p.data.selftext ?? '',
            subreddit,
            score: p.data.score
          });

          llmIntent = result.intent;
          llmConfidence = result.confidence;

          if (result.intent === 'buyer') {
            metricType = 'buyer_intent_post';
          } else if (result.intent === 'seller') {
            metricType = 'seller_pain_point';
          } else {
            metricType = 'reddit_discussion';
          }

          // Log cost
          await log({
            agent: 'intel',
            action: 'cost.api_call',
            description: `Haiku classification: r/${subreddit} "${p.data.title.slice(0, 60)}"`,
            metadata: {
              provider: 'anthropic',
              model: 'claude-haiku-4-5',
              estimated_cost_usd: ESTIMATED_HAIKU_COST_USD
            }
          });
        }

        // Log per-classification
        await log({
          agent: 'intel',
          action: 'reddit.classify',
          description: `r/${subreddit} → ${metricType}: "${p.data.title.slice(0, 80)}"`,
          metadata: {
            post_id: p.data.id,
            subreddit,
            subreddit_category: category,
            llm_intent: llmIntent,
            llm_confidence: llmConfidence,
            final_metric_type: metricType
          }
        });

        const { error: insertErr } = await supabase.from('signals').insert({
          source: 'reddit',
          keyword: subreddit,
          metric_type: metricType,
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
        });

        if (insertErr) {
          console.error(`  insert error r/${subreddit} post ${p.data.id}:`, insertErr.message);
        }

        if (metricType === 'buyer_intent_post') classifiedBuyer++;
        else if (metricType === 'seller_pain_point') classifiedSeller++;
        else classifiedOther++;
      }

      totalPosts += posts.length;
      succeeded++;

      console.log(
        `  ok r/${subreddit} [${category}]: ${posts.length} posts, ` +
          `${regexHits.length} regex hits classified`
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
    description:
      `Reddit scan done: ${succeeded}/${SUBREDDITS.length} subreddits, ` +
      `${totalPosts} posts scanned, ` +
      `${classifiedBuyer} buyer / ${classifiedSeller} seller / ${classifiedOther} other in ${durationSec}s`,
    severity: failed > 0 ? 'warning' : 'success',
    metadata: {
      succeeded,
      failed,
      total_posts: totalPosts,
      classified_buyer: classifiedBuyer,
      classified_seller: classifiedSeller,
      classified_other: classifiedOther,
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
