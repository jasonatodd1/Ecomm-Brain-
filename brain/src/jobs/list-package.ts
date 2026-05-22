// CLI entry point for the Listing Agent.
//
// Usage:
//   npm run list:package -- --brief-id=<uuid> [--store=etsy] [--listing-id=<uuid>]
//
// Prints the generated package summary, the SEO-vs-incumbent verdict, the
// gaps checklist, and the on-disk markdown path. Exits non-zero on agent
// failure so CI / orchestration can detect.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { generateListingPackage } from '../agents/listing/index.js';

interface ParsedArgs {
  briefId?: string;
  store: 'etsy';
  listingId?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run list:package -- --brief-id=<uuid> [--store=etsy] [--listing-id=<uuid>]',
    '',
    'Flags:',
    '  --brief-id=<uuid>      Product brief to generate the package from (required).',
    '  --store=etsy           Destination store (default: etsy; only etsy supported in v1).',
    '  --listing-id=<uuid>    Optional override: forces use of this existing listings row',
    '                         (otherwise auto-detected via decisions_needed.context.opportunity_id).',
  ].join('\n');
}

function parseArgs(): ParsedArgs {
  const out: ParsedArgs = { store: 'etsy' };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--brief-id=')) out.briefId = a.slice('--brief-id='.length);
    else if (a.startsWith('--store=')) {
      const s = a.slice('--store='.length);
      if (s !== 'etsy') {
        throw new Error(`--store=${s} not supported in v1 (only "etsy"). ${usage()}`);
      }
      out.store = s;
    } else if (a.startsWith('--listing-id=')) out.listingId = a.slice('--listing-id='.length);
    else if (a === '--help' || a === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}\n${usage()}`);
    }
  }
  if (!out.briefId) {
    throw new Error(`--brief-id is required.\n${usage()}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`> listing-agent: brief=${args.briefId} store=${args.store}${args.listingId ? ` listing=${args.listingId}` : ''}`);

  const result = await generateListingPackage(args.briefId!, {
    store: args.store,
    listingId: args.listingId,
  });

  const p = result.package;
  const pct = Math.round(p.seo_score.percent * 100);
  console.log('');
  console.log('✓ listing package generated');
  console.log(`  markdown:        ${result.packageMarkdownPath}`);
  console.log(`  run_id:          ${result.runId}`);
  console.log(`  title:           ${p.title.length}/140 chars`);
  console.log(`  tags:            ${p.tags.length}/13`);
  console.log(`  description:     ${p.description_plaintext.length} chars`);
  console.log(`  taxonomy_id:     ${p.taxonomy_id} (${p.taxonomy_breadcrumb.join(' > ')})${p.taxonomy_fallback ? ' [FALLBACK]' : ''}`);
  console.log(`  attributes:      ${p.attributes.length} mapped, ${p.attributes_skipped.length} skipped`);
  const ready = p.image_manifest.filter(s => s.status === 'ready').length;
  console.log(`  image slots:     ${ready}/${p.image_manifest.length} ready`);
  console.log(`  SEO:             ${p.seo_score.total}/${p.seo_score.max} (${pct}%) [${p.seo_score.version}]`);
  if (p.incumbent_benchmark) {
    const inc = Math.round(p.incumbent_benchmark.incumbent_median_percent * 100);
    const our = Math.round(p.incumbent_benchmark.our_percent * 100);
    console.log(`  vs incumbents:   our ${our}% vs ${inc}% median for "${p.incumbent_benchmark.keyword}" — ${p.incumbent_benchmark.beats ? 'BEATS' : 'BELOW'}`);
  } else {
    console.log(`  vs incumbents:   no benchmark`);
  }
  console.log(`  cost:            $${p.cost_usd.toFixed(4)}`);
  console.log(`  gaps:            ${p.gaps.length}`);
  if (p.gaps.length > 0) {
    p.gaps.forEach((g, i) => console.log(`    ${i + 1}. ${g}`));
  }
}

main()
  .then(async () => {
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  })
  .catch(err => {
    console.error('list:package failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
