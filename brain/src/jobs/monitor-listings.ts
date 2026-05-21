// Daily snapshot of every listing we own.
//
// Flow per row in `listings`:
//   1. Fetch current state from Etsy via getListing() (public endpoint, no OAuth)
//   2. INSERT into listings_stats (append-only time series)
//   3. UPDATE listings mirror columns (views, num_favorers, etsy_state, …,
//      last_snapshot_at) so SELECT * FROM listings gives current state
//      without a JOIN
//   4. Activity row per listing with agent='listing', action='listing.snapshotted'
//
// Concurrency: max 2 in-flight, 200ms stagger — matches the limits used by
// the Research Agent (~5 req/sec sustained, well under Etsy's 10 req/sec).
// Designed to be run from cron (daily) once Railway scheduling is configured.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { log } from '../lib/log.js';
import { getListing, type EtsyListingDetails } from '../lib/etsy-search.js';
import { mapWithLimit } from '../lib/concurrency.js';

interface ListingRow {
  id: string;
  etsy_listing_id: string;
}

type SnapshotOutcome =
  | { ok: true; row: ListingRow; details: EtsyListingDetails }
  | { ok: false; row: ListingRow; reason: string };

function epochSecondsToIso(secs: number | null): string | null {
  if (secs == null) return null;
  return new Date(secs * 1000).toISOString();
}

async function snapshotOne(row: ListingRow): Promise<SnapshotOutcome> {
  const numericId = Number(row.etsy_listing_id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return {
      ok: false,
      row,
      reason: `etsy_listing_id "${row.etsy_listing_id}" is not a positive integer`
    };
  }

  const details = await getListing(numericId);
  if (!details) {
    return { ok: false, row, reason: 'getListing returned null (see prior activity logs)' };
  }

  const etsyLastModifiedIso = epochSecondsToIso(details.last_modified_timestamp);

  // Append to listings_stats first; if that fails we don't touch the mirrors
  // (mirrors would otherwise advance ahead of the time series).
  const { error: statsErr } = await supabase.from('listings_stats').insert({
    listing_id: row.id,
    views: details.views,
    num_favorers: details.num_favorers,
    price_cents: details.price_cents,
    etsy_state: details.state,
    title: details.title,
    tags: details.tags,
    etsy_last_modified_at: etsyLastModifiedIso,
    raw: details.raw
  });
  if (statsErr) {
    return {
      ok: false,
      row,
      reason: `listings_stats insert failed: ${statsErr.message}`
    };
  }

  const nowIso = new Date().toISOString();
  const { error: mirrorErr } = await supabase
    .from('listings')
    .update({
      title: details.title,
      price_cents: details.price_cents,
      views: details.views,
      num_favorers: details.num_favorers,
      etsy_state: details.state,
      tags: details.tags,
      etsy_last_modified_at: etsyLastModifiedIso,
      last_snapshot_at: nowIso,
      updated_at: nowIso
    })
    .eq('id', row.id);
  if (mirrorErr) {
    // Time-series row already landed; flag the mirror divergence so the
    // operator can reconcile. Don't fail the whole run for one row.
    await log({
      agent: 'listing',
      action: 'listing.mirror_update_failed',
      description: `listings_stats snapshot landed but mirror update failed for ${row.etsy_listing_id}`,
      severity: 'warning',
      metadata: { listing_id: row.id, etsy_listing_id: row.etsy_listing_id, error: mirrorErr.message }
    });
  }

  const titlePreview = details.title.length > 60
    ? `${details.title.slice(0, 57)}...`
    : details.title;

  await log({
    agent: 'listing',
    action: 'listing.snapshotted',
    description: `Snapshotted ${row.etsy_listing_id} "${titlePreview}" — views=${details.views ?? 'null'}, favorers=${details.num_favorers ?? 'null'}, state=${details.state ?? 'null'}`,
    severity: 'success',
    metadata: {
      listing_id: row.id,
      etsy_listing_id: row.etsy_listing_id,
      views: details.views,
      num_favorers: details.num_favorers,
      price_cents: details.price_cents,
      etsy_state: details.state,
      tag_count: details.tags.length,
      etsy_last_modified_at: etsyLastModifiedIso
    }
  });

  return { ok: true, row, details };
}

async function main(): Promise<void> {
  const { data: rows, error } = await supabase
    .from('listings')
    .select('id, etsy_listing_id')
    .not('etsy_listing_id', 'is', null);

  if (error) {
    throw new Error(`Failed to read listings: ${error.message}`);
  }

  const listings = (rows ?? []) as ListingRow[];
  console.log(`> monitoring ${listings.length} listings`);

  if (listings.length === 0) {
    console.log('  nothing to do — listings table is empty. Run seed:listings first.');
    return;
  }

  const startedAt = Date.now();
  const outcomes = await mapWithLimit(listings, 2, 200, snapshotOne);

  const succeeded = outcomes.filter((o): o is Extract<SnapshotOutcome, { ok: true }> => o.ok);
  const failed = outcomes.filter((o): o is Extract<SnapshotOutcome, { ok: false }> => !o.ok);
  const durationMs = Date.now() - startedAt;

  console.log('');
  console.log(`✓ snapshot complete: ${succeeded.length}/${listings.length} succeeded in ${(durationMs / 1000).toFixed(1)}s`);
  for (const o of succeeded) {
    const d = o.details;
    console.log(
      `  ${o.row.etsy_listing_id}  views=${d.views ?? 'null'}  favorers=${d.num_favorers ?? 'null'}  ` +
      `state=${d.state ?? 'null'}  price_cents=${d.price_cents ?? 'null'}  tags=${d.tags.length}`
    );
  }
  for (const o of failed) {
    console.warn(`  ✗ ${o.row.etsy_listing_id}  ${o.reason}`);
  }

  await log({
    agent: 'listing',
    action: 'listings.monitor_complete',
    description: `Listings monitor: ${succeeded.length}/${listings.length} snapshotted in ${(durationMs / 1000).toFixed(1)}s`,
    severity: failed.length === 0 ? 'success' : 'warning',
    metadata: {
      total: listings.length,
      succeeded: succeeded.length,
      failed: failed.length,
      duration_ms: durationMs,
      failures: failed.map(f => ({
        etsy_listing_id: f.row.etsy_listing_id,
        reason: f.reason
      }))
    }
  });

  if (failed.length > 0) process.exit(1);
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('monitor-listings failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
