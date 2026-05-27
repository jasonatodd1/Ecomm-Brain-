import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

const SEED_KEY = 'meal_planner_printable';

async function main(): Promise<void> {
  const { data: existing, error: checkErr } = await supabase
    .from('decisions_needed')
    .select('id')
    .eq('context->>seed_key', SEED_KEY)
    .limit(1);

  if (checkErr) {
    throw new Error(`Failed to query decisions_needed: ${checkErr.message}`);
  }

  if (existing && existing.length > 0) {
    console.log(`skip: decision already seeded (${existing[0].id})`);
    return;
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('decisions_needed')
    .insert({
      title:
        'Meal planner printable — Google Trends seed anchor (bake-off #2, WS 0.644)',
      description:
        'Original Trends seed keyword "meal planner printable" with sustained external demand ' +
        'and weak-incumbent classification in niche bake-off v2. Strong candidate for a ' +
        'differentiated digital meal-planning printable bundle targeting buyers who want ' +
        'weekly planning + grocery list in one cohesive layout.',
      urgency: 'high',
      context: {
        source: 'google_trends_seed',
        seed_key: SEED_KEY,
        primary_keyword: 'meal planner printable',
        signal_type: 'demand_anchor',
        seeded: true,
        bakeoff_ws_score: 0.644
      }
    })
    .select('id')
    .single();

  if (insertErr) {
    throw new Error(`Failed to insert decision: ${insertErr.message}`);
  }

  await log({
    agent: 'intel',
    action: 'decision.seeded',
    description: 'Seeded meal planner printable decision (Trends anchor)',
    severity: 'success',
    metadata: { seed_key: SEED_KEY, decision_id: inserted?.id }
  });

  console.log(`ok: decision seeded (${inserted?.id})`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('job crashed:', err);
    process.exit(1);
  });
