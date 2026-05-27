/**
 * Post-publish registration for meal planner listing 4512363257.
 * - Links brief assets → listings row
 * - Audits Etsy photo order vs recommended display_order 1–7
 * Run after: npm run seed:listings
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase } from '../lib/supabase.js';
import { getListing } from '../lib/etsy-search.js';
import { log } from '../lib/log.js';

const ETSY_LISTING_ID = '4512363257';
const PRODUCT_BRIEF_ID = 'cb213bf4-5225-4bc9-b4ac-67f2167c9b8f';

/** Expected Etsy slot order (display_order 1–7). */
const RECOMMENDED = [
  {
    slot: 1,
    file: 'meal-planner-01-hero.png',
    role: 'hero',
    width: 1024,
    height: 1024,
  },
  {
    slot: 2,
    file: 'meal-planner-02-lifestyle-in-use.png',
    role: 'lifestyle in-use',
    width: 1024,
    height: 1024,
  },
  {
    slot: 3,
    file: 'meal-planner-03-lifestyle-grocery-store.jpg',
    role: 'grocery store',
    width: 848,
    height: 1216,
  },
  {
    slot: 4,
    file: 'meal-planner-04-lifestyle-kitchen.png',
    role: 'kitchen counter',
    width: 714,
    height: 1024,
  },
  {
    slot: 5,
    file: 'meal-planner-05-pdf-preview.png',
    role: 'PDF preview',
    width: 2550,
    height: 3300,
  },
  {
    slot: 6,
    file: 'meal-planner-06-detail-aisle-headers.png',
    role: 'aisle detail',
    width: 1001,
    height: 2339,
  },
  {
    slot: 7,
    file: 'meal-planner-07-whats-included.png',
    role: "what's included",
    width: 3000,
    height: 3000,
  },
];

interface EtsyImage {
  listing_image_id: number;
  rank: number;
  url_fullxfull?: string;
  full_width?: number;
  full_height?: number;
}

async function fetchListingImages(listingId: number): Promise<EtsyImage[]> {
  const key = `${process.env.ETSY_API_KEYSTRING}:${process.env.ETSY_SHARED_SECRET}`;
  const res = await fetch(
    `https://openapi.etsy.com/v3/application/listings/${listingId}/images`,
    { headers: { 'x-api-key': key, Accept: 'application/json' } }
  );
  if (!res.ok) {
    throw new Error(`listing images HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { results?: EtsyImage[] };
  const images = data.results ?? [];
  return images.sort((a, b) => a.rank - b.rank);
}

function matchByDims(w: number, h: number): (typeof RECOMMENDED)[0] | null {
  const exact = RECOMMENDED.find(e => e.width === w && e.height === h);
  if (exact) return exact;
  const ratio = w / h;
  const pdf = RECOMMENDED.find(e => e.file.includes('05-pdf-preview'));
  if (pdf && Math.abs(ratio - pdf.width / pdf.height) < 0.01 && h > 2000) {
    return pdf;
  }
  return null;
}

function matchExpected(
  img: EtsyImage,
  square1024Index: number | null
): (typeof RECOMMENDED)[0] | null {
  const w = img.full_width;
  const h = img.full_height;
  if (w == null || h == null) return null;

  if (w === 1024 && h === 1024 && square1024Index != null) {
    if (square1024Index === 0) {
      return RECOMMENDED.find(e => e.file.includes('01-hero')) ?? null;
    }
    if (square1024Index === 1) {
      return RECOMMENDED.find(e => e.file.includes('02-lifestyle-in-use')) ?? null;
    }
    return null;
  }

  return matchByDims(w, h);
}

async function main(): Promise<void> {
  const { data: listing, error: listingErr } = await supabase
    .from('listings')
    .select('id, etsy_listing_id, opportunity_id')
    .eq('etsy_listing_id', ETSY_LISTING_ID)
    .maybeSingle();

  if (listingErr || !listing) {
    throw new Error(
      `No listings row for etsy_listing_id=${ETSY_LISTING_ID}. Run npm run seed:listings first.`
    );
  }

  console.log(`> listings.id=${listing.id} (etsy ${ETSY_LISTING_ID})`);

  const { data: assets, error: assetsErr } = await supabase
    .from('assets')
    .select('id, kind, local_path')
    .eq('product_brief_id', PRODUCT_BRIEF_ID);

  if (assetsErr) throw new Error(assetsErr.message);

  const { error: linkErr } = await supabase
    .from('assets')
    .update({ listing_id: listing.id })
    .eq('product_brief_id', PRODUCT_BRIEF_ID)
    .is('listing_id', null);

  if (linkErr) throw new Error(`asset link failed: ${linkErr.message}`);

  console.log(`> linked ${assets?.length ?? 0} assets (brief ${PRODUCT_BRIEF_ID}) → listing ${listing.id}`);

  const etsyImages = await fetchListingImages(Number(ETSY_LISTING_ID));
  console.log(`\n=== Photo order audit (${etsyImages.length} images on Etsy) ===\n`);

  const auditRows: Array<{
    etsy_slot: number;
    dims: string;
    matched_file: string | null;
    expected_slot: number | null;
    ok: boolean;
  }> = [];

  let square1024Seen = 0;
  for (const img of etsyImages) {
    const etsySlot = img.rank;
    const squareIdx =
      img.full_width === 1024 && img.full_height === 1024
        ? square1024Seen
        : null;
    if (squareIdx != null) square1024Seen++;
    const match = matchExpected(img, squareIdx);
    const expectedSlot = match?.slot ?? null;
    auditRows.push({
      etsy_slot: etsySlot,
      dims: `${img.full_width ?? '?'}×${img.full_height ?? '?'}`,
      matched_file: match?.file ?? null,
      expected_slot: expectedSlot,
      ok: expectedSlot === etsySlot,
    });
  }

  for (const row of auditRows) {
    const status = row.ok ? '✅' : row.matched_file ? '⚠️ wrong slot' : '❓ unmatched';
    console.log(
      `  Etsy #${row.etsy_slot}  ${row.dims.padEnd(12)}  →  ${row.matched_file ?? '(unknown)'}  ${status}` +
        (row.expected_slot != null && !row.ok ? ` (expected slot ${row.expected_slot})` : '')
    );
  }

  const missing = RECOMMENDED.filter(
    exp => !auditRows.some(r => r.matched_file === exp.file)
  );
  if (missing.length > 0) {
    console.log('\n  Missing from Etsy listing:');
    for (const m of missing) {
      console.log(`    slot ${m.slot}: ${m.file} (${m.role})`);
    }
  }

  const allOk =
    etsyImages.length === 7 &&
    auditRows.every(r => r.ok) &&
    missing.length === 0;

  console.log(
    allOk
      ? '\n✓ Photo order matches recommended 1–7 sequence'
      : `\n⚠ Photo order diverges from recommended sequence — see listing-package-v1.md operator notes`
  );

  await log({
    agent: 'listing',
    action: 'listing.registered',
    description: `Meal planner listing ${ETSY_LISTING_ID} registered — ${assets?.length ?? 0} assets linked, ${etsyImages.length} Etsy photos audited`,
    severity: 'success',
    metadata: {
      listing_id: listing.id,
      etsy_listing_id: ETSY_LISTING_ID,
      product_brief_id: PRODUCT_BRIEF_ID,
      opportunity_id: listing.opportunity_id,
      asset_count: assets?.length ?? 0,
      etsy_image_count: etsyImages.length,
      photo_order_ok: allOk,
      photo_audit: auditRows,
    },
  });

  // Refresh mirror columns from Etsy (same as monitor-listings, single row).
  const details = await getListing(Number(ETSY_LISTING_ID));
  if (details) {
    const nowIso = new Date().toISOString();
    await supabase.from('listings_stats').insert({
      listing_id: listing.id,
      views: details.views,
      num_favorers: details.num_favorers,
      price_cents: details.price_cents,
      etsy_state: details.state,
      title: details.title,
      tags: details.tags,
      etsy_last_modified_at: details.last_modified_timestamp
        ? new Date(details.last_modified_timestamp * 1000).toISOString()
        : null,
      raw: details.raw,
    });
    await supabase
      .from('listings')
      .update({
        title: details.title,
        price_cents: details.price_cents,
        views: details.views,
        num_favorers: details.num_favorers,
        etsy_state: details.state,
        tags: details.tags,
        last_snapshot_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', listing.id);
    console.log(
      `\n> snapshot: views=${details.views ?? 0}, favorers=${details.num_favorers ?? 0}, price=$${((details.price_cents ?? 0) / 100).toFixed(2)}`
    );
  }
}

main().catch(err => {
  console.error('register-meal-planner-listing failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
