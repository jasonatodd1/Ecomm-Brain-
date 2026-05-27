// One-time seed for our live HillwardStudio Etsy listings.
//
// Inserts a row in `listings` per known listing_id so monitor-listings.ts
// has something to snapshot. Idempotent: re-running skips listings whose
// etsy_listing_id is already present (relies on the unique index added in
// migration 0006).
//
// All other listing fields (title, views, num_favorers, etsy_state, tags, …)
// are intentionally left null at seed time — monitor-listings.ts will
// populate them on its first run from Etsy's authoritative state.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';

interface SeedListing {
  etsy_listing_id: string;
  note: string; // human-readable label for the console output; not stored
  opportunity_id?: string;
}

const SEED_LISTINGS: SeedListing[] = [
  { etsy_listing_id: '4508059444', note: 'A5 Monthly Calendar Printable' },
  { etsy_listing_id: '4508704536', note: 'Vintage Bunny Nursery Wall Art' },
  {
    etsy_listing_id: '4512363257',
    note: 'Meal Planner Printable with Grocery List',
    opportunity_id: 'a4376656-6b32-4b0a-a223-bfd32d43f23f',
  },
];

async function main(): Promise<void> {
  console.log(`> seeding ${SEED_LISTINGS.length} listings`);

  let inserted = 0;
  let skipped = 0;

  for (const l of SEED_LISTINGS) {
    const { data: existing, error: checkErr } = await supabase
      .from('listings')
      .select('id, etsy_listing_id, status')
      .eq('etsy_listing_id', l.etsy_listing_id)
      .maybeSingle();

    if (checkErr) {
      throw new Error(
        `Failed to query listings for ${l.etsy_listing_id}: ${checkErr.message}`
      );
    }

    if (existing) {
      console.log(`  skip  ${l.etsy_listing_id}  (${l.note}) — id=${existing.id}`);
      skipped++;
      continue;
    }

    const insertRow: Record<string, unknown> = {
      etsy_listing_id: l.etsy_listing_id,
      status: 'active',
    };
    if (l.opportunity_id) insertRow.opportunity_id = l.opportunity_id;

    const { data: inserted_row, error: insertErr } = await supabase
      .from('listings')
      .insert(insertRow)
      .select('id')
      .single();

    if (insertErr || !inserted_row) {
      throw new Error(
        `Failed to insert listing ${l.etsy_listing_id}: ${insertErr?.message ?? 'unknown'}`
      );
    }

    console.log(`  ✓     ${l.etsy_listing_id}  (${l.note}) — id=${inserted_row.id}`);
    inserted++;
  }

  await log({
    agent: 'listing',
    action: 'listings.seeded',
    description: `Seeded ${inserted} listing(s), skipped ${skipped} already present`,
    severity: 'success',
    metadata: {
      inserted,
      skipped,
      etsy_listing_ids: SEED_LISTINGS.map(l => l.etsy_listing_id)
    }
  });

  console.log('');
  console.log(`✓ seed complete: ${inserted} inserted, ${skipped} skipped`);
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 250));
    process.exit(0);
  })
  .catch(err => {
    console.error('seed-listings failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
