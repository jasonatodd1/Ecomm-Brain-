import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { researchDecision } from '../agents/research/index.js';

const PLANNERADDICTS_POST_URL =
  'https://reddit.com/r/PlannerAddicts/comments/1t6wx4t/looking_for_something_i_cant_find/';

function parseDecisionIdArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--decision-id' && i + 1 < args.length) {
      return args[i + 1];
    }
    if (a?.startsWith('--decision-id=')) {
      return a.slice('--decision-id='.length);
    }
  }
  return null;
}

async function resolveDecisionId(): Promise<string> {
  const fromArg = parseDecisionIdArg();
  if (fromArg) return fromArg;

  // Default: planneraddicts seed
  const { data, error } = await supabase
    .from('decisions_needed')
    .select('id')
    .eq('context->>post_url', PLANNERADDICTS_POST_URL)
    .limit(1);

  if (error) {
    throw new Error(`Failed to resolve default decision: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      `No --decision-id provided and the default planneraddicts decision was not found.`
    );
  }

  return data[0].id as string;
}

async function main(): Promise<void> {
  const decisionId = await resolveDecisionId();
  console.log(`> researching decision ${decisionId}`);

  const result = await researchDecision(decisionId);

  console.log('');
  console.log(`✓ research complete`);
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
