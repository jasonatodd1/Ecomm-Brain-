import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { researchDecision } from '../agents/research/index.js';

const SEED_KEY = 'meal_planner_printable';

async function resolveDecisionId(): Promise<string> {
  const { data, error } = await supabase
    .from('decisions_needed')
    .select('id, status')
    .eq('context->>seed_key', SEED_KEY)
    .limit(1);

  if (error) {
    throw new Error(`Failed to resolve meal planner decision: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      'Meal planner decision not found. Run: npm run seed:meal-planner'
    );
  }

  const row = data[0];
  if (row.status !== 'open') {
    console.warn(
      `  warning: decision status is "${row.status}" (expected "open" for fresh run)`
    );
  }

  return row.id as string;
}

async function main(): Promise<void> {
  const decisionId = await resolveDecisionId();
  console.log(`> researching meal planner printable decision ${decisionId}`);

  const started = Date.now();
  const result = await researchDecision(decisionId);
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log(`✓ research complete (${elapsedSec}s)`);
  console.log(`  brief_id:       ${result.briefId}`);
  console.log(`  total cost:     $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  markdown saved: brain/briefs/<date>-${decisionId.slice(0, 8)}.md`);
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('research job failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
