// Operator-review markdown for a PublishPackage.
//
// This is what an operator opens in their editor before publishing a draft
// on Etsy. It must be self-contained — every field, substitution reason,
// ready/missing image slot, SEO comparison, and gap are visible without
// hunting through Supabase. Designed for diffing across runs (so re-runs
// produce stable, line-stable output).
import type { PublishPackage } from './types.js';

interface RenderContext {
  costUsd: number;
  packageVersion: 'listing-v1';
  generatedAt: string; // ISO date string
}

export function renderPackageAsMarkdown(
  pkg: PublishPackage,
  ctx: RenderContext
): string {
  const lines: string[] = [];

  // ------ Header ----------------------------------------------------------
  lines.push(`# Listing Package — Etsy`);
  lines.push('');
  lines.push(
    `> brief_id: \`${pkg.brief_id}\` | listing_id: ${pkg.etsy_listing_id ? `\`${pkg.etsy_listing_id}\`` : '_(new)_'}`
  );
  lines.push(
    `> Generated ${ctx.generatedAt.slice(0, 10)} | cost $${ctx.costUsd.toFixed(4)} | package_version \`${ctx.packageVersion}\``
  );
  lines.push('');

  // ------ Gaps (most important — top of file) -----------------------------
  if (pkg.gaps.length > 0) {
    lines.push('## ⚠️ Gaps to address before publish');
    lines.push('');
    pkg.gaps.forEach(g => lines.push(`- [ ] ${g}`));
    lines.push('');
  } else {
    lines.push('## ✓ No gaps — package is publish-ready pending operator review');
    lines.push('');
  }

  // ------ SEO score vs incumbents -----------------------------------------
  lines.push('## SEO Score (pre-publish gate)');
  lines.push('');
  const pct = (pkg.seo_score.percent * 100).toFixed(0);
  lines.push(
    `**Draft score: ${pkg.seo_score.total} / ${pkg.seo_score.max} (${pct}%)** — scorer \`${pkg.seo_score.version}\``
  );
  lines.push('');
  if (pkg.incumbent_benchmark) {
    const b = pkg.incumbent_benchmark;
    const inc = (b.incumbent_median_percent * 100).toFixed(0);
    const our = (b.our_percent * 100).toFixed(0);
    const verdict = b.beats ? '✅ beats incumbents' : '❌ below incumbents';
    lines.push(
      `Incumbent benchmark for \`${b.keyword}\`: median of top ${b.incumbent_count} = ${inc}% · our ${our}% · ${verdict}.`
    );
    lines.push('');
  } else {
    lines.push(
      `_No incumbent benchmark available — brief.listing.competitive_landscape is empty._`
    );
    lines.push('');
  }
  if (pkg.pre_improvement_score) {
    const prePct = (pkg.pre_improvement_score.percent * 100).toFixed(0);
    lines.push(
      `_Pre-improvement score: ${pkg.pre_improvement_score.total}/${pkg.pre_improvement_score.max} (${prePct}%) — Opus pass moved it to current._`
    );
    lines.push('');
  }
  lines.push('### Per-rule breakdown');
  lines.push('');
  lines.push('| Rule | Score | Max | Note |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const [rule, entry] of Object.entries(pkg.seo_score.detailed_breakdown)) {
    lines.push(
      `| \`${rule}\` | ${entry.score} | ${entry.max} | ${entry.note.replace(/\|/g, '\\|')} |`
    );
  }
  lines.push('');
  if (pkg.seo_score.weak_areas.length > 0) {
    lines.push(
      `**Weak areas (top 3):** ${pkg.seo_score.weak_areas.slice(0, 3).join(', ')}`
    );
    lines.push('');
  }

  // ------ Title -----------------------------------------------------------
  lines.push('## Title');
  lines.push('');
  lines.push('```');
  lines.push(pkg.title);
  lines.push('```');
  lines.push(`_${pkg.title.length}/140 chars_`);
  lines.push('');

  // ------ Tags ------------------------------------------------------------
  lines.push('## Tags');
  lines.push('');
  pkg.tags.forEach((t, i) => lines.push(`${i + 1}. \`${t}\` (${t.length})`));
  if (pkg.tags.length < 13) {
    lines.push('');
    lines.push(`_${pkg.tags.length}/13 tags — gap of ${13 - pkg.tags.length}_`);
  } else {
    lines.push('');
    lines.push(`_${pkg.tags.length}/13 tags — ok_`);
  }
  lines.push('');

  // ------ Taxonomy --------------------------------------------------------
  lines.push('## Taxonomy');
  lines.push('');
  lines.push(`**taxonomy_id:** \`${pkg.taxonomy_id}\``);
  lines.push(`**path:** ${pkg.taxonomy_breadcrumb.join(' > ')}`);
  if (pkg.taxonomy_fallback) {
    lines.push('');
    lines.push(
      `⚠️ Fallback to parent — matched \`${pkg.taxonomy_fallback.matched_path.join(' > ')}\`, unmatched tail: \`${pkg.taxonomy_fallback.unmatched_tail.join(' > ')}\`.`
    );
  }
  lines.push('');

  // ------ Attributes ------------------------------------------------------
  lines.push('## Attributes');
  lines.push('');
  if (pkg.attributes.length === 0) {
    lines.push('_No attributes mapped._');
  } else {
    for (const a of pkg.attributes) {
      const flag = a.any_substituted ? ' ⚠️ (substituted)' : '';
      lines.push(`### \`${a.property_name}\` (property_id ${a.property_id})${flag}`);
      lines.push('');
      for (const v of a.values) {
        const subFlag = v.was_substituted ? ' _(substituted)_' : '';
        lines.push(
          `- **${v.value}** (value_id ${v.value_id}) — confidence \`${v.confidence}\`${subFlag} — _${v.reason}_`
        );
      }
      lines.push('');
    }
  }

  if (pkg.attributes_skipped.length > 0) {
    lines.push('### Skipped properties');
    lines.push('');
    lines.push('| Property | Reason | Detail |');
    lines.push('| --- | --- | --- |');
    for (const s of pkg.attributes_skipped) {
      lines.push(
        `| \`${s.property_name}\` | \`${s.reason}\` | ${s.detail.replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  }

  // ------ Materials -------------------------------------------------------
  if (pkg.materials.length > 0) {
    lines.push('## Materials (listing-level free-text)');
    lines.push('');
    pkg.materials.forEach(m => lines.push(`- ${m}`));
    lines.push('');
  }

  // ------ Shop section ----------------------------------------------------
  lines.push('## Shop section suggestion');
  lines.push('');
  if (pkg.shop_section_suggestion) {
    lines.push(`\`${pkg.shop_section_suggestion}\` — _operator: match against shop sections list or create if missing._`);
  } else {
    lines.push('_None suggested by brief._');
  }
  lines.push('');

  // ------ Image manifest --------------------------------------------------
  lines.push('## Image manifest');
  lines.push('');
  const ready = pkg.image_manifest.filter(s => s.status === 'ready').length;
  const total = pkg.image_manifest.length;
  lines.push(`**${ready}/${total} slots ready.**`);
  lines.push('');
  for (const slot of pkg.image_manifest) {
    const badge = slot.status === 'ready' ? '✅' : '🟡';
    lines.push(`### ${badge} Slot ${slot.slot} — \`${slot.kind}\` (${slot.status})`);
    lines.push('');
    if (slot.spec) {
      lines.push(`- **Purpose:** ${slot.spec.purpose}`);
      lines.push(`- **Dims:** ${slot.spec.dims_recommended}`);
      lines.push(`- **Style:** ${slot.spec.style_notes}`);
    }
    if (slot.status === 'ready') {
      lines.push(`- **Asset:** \`${slot.asset_path ?? '(no local_path)'}\``);
      if (slot.asset_width && slot.asset_height) {
        lines.push(`- **Actual dims:** ${slot.asset_width}×${slot.asset_height}`);
      }
      lines.push(`- **Source:** \`${slot.asset_source}\``);
      lines.push(`- **asset_id:** \`${slot.asset_id}\``);
    } else if (slot.generation_hint) {
      lines.push(`- **Generation hint:** ${slot.generation_hint}`);
    }
    lines.push('');
  }

  // ------ Description (last because it's the longest) ---------------------
  lines.push('## Description (Etsy plaintext — paste verbatim)');
  lines.push('');
  lines.push('```');
  lines.push(pkg.description_plaintext);
  lines.push('```');
  lines.push('');
  lines.push(`_${pkg.description_plaintext.length} chars._`);

  return lines.join('\n');
}
