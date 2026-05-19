import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const POST_URL =
  'https://reddit.com/r/PlannerAddicts/comments/1t6wx4t/looking_for_something_i_cant_find/';

interface DecisionRow {
  context: { post_url: string };
}

async function main(): Promise<void> {
  // Idempotency check — skip if a row with this post URL already exists
  const { data: existing, error: checkErr } = await supabase
    .from('decisions_needed')
    .select('id, context')
    .eq('context->>post_url', POST_URL)
    .limit(1);

  if (checkErr) {
    throw new Error(`Failed to query decisions_needed: ${checkErr.message}`);
  }

  const rows = (existing ?? []) as DecisionRow[];

  if (rows.length > 0) {
    console.log('skip: decision already seeded for this post URL');
    return;
  }

  const { error: insertErr } = await supabase.from('decisions_needed').insert({
    title: 'Real buyer asking for A5 monthly calendar printable (r/planneraddicts, 13 upvotes)',
    description:
      'A r/planneraddicts member with 13 upvotes is actively searching for an A5 binder ' +
      'insert with plain note pages plus a simple month-to-month calendar — explicitly not a ' +
      'daily planner. They want something printable and cannot find it anywhere, which is a ' +
      'clear unmet demand signal for a simple A5 monthly calendar + notes printable bundle.',
    urgency: 'high',
    context: {
      source: 'reddit',
      subreddit: 'planneraddicts',
      post_id: '1t6wx4t',
      post_url: POST_URL,
      score: 13,
      signal_type: 'buyer_intent',
      seeded: true
    }
  });

  if (insertErr) {
    throw new Error(`Failed to insert decision: ${insertErr.message}`);
  }

  await log({
    agent: 'intel',
    action: 'decision.seeded',
    description: 'Seeded buyer-intent decision: A5 monthly calendar printable (r/planneraddicts)',
    severity: 'success',
    metadata: { post_url: POST_URL, score: 13, subreddit: 'planneraddicts' }
  });

  console.log('ok: decision seeded');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
