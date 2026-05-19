import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { classifyIntent } from '../lib/classify-intent.js';

const SUBREDDIT_CATEGORIES: Record<string, 'buyer' | 'seller' | 'mixed'> = {
  Etsy: 'mixed',
  EtsySellers: 'seller',
  planneraddicts: 'buyer',
  PlannerCommunity: 'buyer',
  printables: 'mixed',
  handmade: 'mixed',
  cricut: 'mixed'
};

interface SignalRow {
  id: string;
  keyword: string;
  value: number;
  metadata: {
    title?: string;
    text_preview?: string;
    subreddit?: string;
    score?: number;
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  await log({
    agent: 'intel',
    action: 'reclassify.start',
    description: 'Reclassifying existing Reddit buyer_intent_post signals'
  });

  const { data, error: fetchErr } = await supabase
    .from('signals')
    .select('id, keyword, value, metadata')
    .eq('source', 'reddit')
    .eq('metric_type', 'buyer_intent_post');

  if (fetchErr) {
    throw new Error(`Failed to fetch signals: ${fetchErr.message}`);
  }

  const signals = (data ?? []) as SignalRow[];
  console.log(`  found ${signals.length} existing buyer_intent_post signals`);

  let retainedBuyer = 0;
  let demotedSeller = 0;
  let demotedOther = 0;

  for (const sig of signals) {
    const subreddit =
      typeof sig.metadata.subreddit === 'string' ? sig.metadata.subreddit : sig.keyword;
    const title =
      typeof sig.metadata.title === 'string' ? sig.metadata.title : '(no title)';
    const body =
      typeof sig.metadata.text_preview === 'string' ? sig.metadata.text_preview : '';
    const score = typeof sig.metadata.score === 'number' ? sig.metadata.score : sig.value;

    const category = SUBREDDIT_CATEGORIES[subreddit] ?? 'mixed';

    let newMetricType: string;

    if (category === 'seller') {
      newMetricType = 'seller_pain_point';
    } else {
      const suboptimal = body === '';

      const result = await classifyIntent({ title, body, subreddit, score });

      if (suboptimal) {
        console.log(`  [suboptimal: no body] r/${subreddit} "${title.slice(0, 60)}"`);
      }

      if (result.intent === 'buyer') {
        newMetricType = 'buyer_intent_post';
      } else if (result.intent === 'seller') {
        newMetricType = 'seller_pain_point';
      } else {
        newMetricType = 'reddit_discussion';
      }

      // Log cost
      await log({
        agent: 'intel',
        action: 'cost.api_call',
        description: `Haiku reclassification: r/${subreddit} "${title.slice(0, 60)}"`,
        metadata: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          estimated_cost_usd: 0.001
        }
      });
    }

    if (newMetricType !== 'buyer_intent_post') {
      const { error: updateErr } = await supabase
        .from('signals')
        .update({ metric_type: newMetricType })
        .eq('id', sig.id);

      if (updateErr) {
        console.error(`  update error ${sig.id}:`, updateErr.message);
      } else {
        console.log(`  demoted → ${newMetricType}: "${title.slice(0, 60)}"`);
      }
    } else {
      console.log(`  retained buyer_intent_post: "${title.slice(0, 60)}"`);
    }

    if (newMetricType === 'buyer_intent_post') retainedBuyer++;
    else if (newMetricType === 'seller_pain_point') demotedSeller++;
    else demotedOther++;
  }

  // Delete stale Reddit opportunity rows — will be regenerated cleanly on next score run
  const { error: deleteErr, count: deletedCount } = await supabase
    .from('opportunities')
    .delete({ count: 'exact' })
    .like('name', 'Reddit buyer:%');

  if (deleteErr) {
    console.error('  failed to delete Reddit opportunities:', deleteErr.message);
  } else {
    console.log(`  deleted ${deletedCount ?? 0} stale Reddit opportunities`);
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  await log({
    agent: 'intel',
    action: 'reclassify.complete',
    description:
      `Reclassification done: ${signals.length} processed — ` +
      `${retainedBuyer} retained buyer, ${demotedSeller} demoted seller, ` +
      `${demotedOther} demoted other. ${deletedCount ?? 0} opportunities deleted in ${durationSec}s`,
    severity: 'success',
    metadata: {
      total_processed: signals.length,
      retained_buyer: retainedBuyer,
      demoted_seller: demotedSeller,
      demoted_other: demotedOther,
      opportunities_deleted: deletedCount ?? 0,
      duration_sec: durationSec
    }
  });
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
