import type { ProductBrief, DecisionRecord } from './types.js';

interface RenderContext {
  briefId: string;
  costUsd: number;
  /**
   * Schema version of the brief being rendered. v1 briefs lack the Tuning
   * Pass 2 fields; the renderer tolerates absence either way (each new section
   * checks `brief.audience` / `brief.listing.description` / etc. before
   * rendering), but knowing the version lets us label the brief header
   * accurately for operator review.
   */
  agentVersion?: string;
}

export function renderBriefAsMarkdown(
  brief: ProductBrief,
  decision: DecisionRecord,
  ctx: RenderContext
): string {
  const date = new Date().toISOString().slice(0, 10);
  const confidencePct = `${(brief.confidence * 100).toFixed(0)}%`;
  const cost = `$${ctx.costUsd.toFixed(4)}`;

  const lines: string[] = [];

  lines.push(`# Research Brief: ${decision.title}`);
  lines.push('');
  lines.push(
    `> Generated ${date} | Recommendation: **${brief.recommendation.toUpperCase()}** | Confidence: ${confidencePct}`
  );
  lines.push('');

  // Recommendation
  lines.push('## Recommendation');
  lines.push('');
  lines.push(brief.reasoning);
  lines.push('');

  // Audience Persona (v2+)
  if (brief.audience) {
    lines.push('## Audience Persona');
    lines.push('');
    lines.push(`**Persona:** ${brief.audience.persona}`);
    lines.push('');
    lines.push(`**Primary search intent:** ${brief.audience.primary_search_intent}`);
    lines.push('');
    if (brief.audience.decision_factors.length > 0) {
      lines.push('**Decision factors:**');
      brief.audience.decision_factors.forEach(f => lines.push(`- ${f}`));
      lines.push('');
    }
  }

  // Market Summary
  const m = brief.market_summary;
  lines.push('## Market Summary');
  lines.push('');
  lines.push(`- **Saturation:** ${m.saturation}`);
  lines.push(`- **Listings analyzed:** ${m.listings_analyzed}`);
  lines.push(
    `- **Price range:** $${m.price_range.p25.toFixed(2)} (p25) — $${m.price_range.p50.toFixed(2)} (median) — $${m.price_range.p75.toFixed(2)} (p75)`
  );
  lines.push(`- **Median favorers:** ${m.median_favorers}`);
  lines.push('');

  if (m.top_sellers.length > 0) {
    lines.push('### Top Sellers');
    lines.push('');
    m.top_sellers.forEach((s, i) => {
      const shopLabel = s.shop_url
        ? `[${s.shop_name || 'shop'}](${s.shop_url})`
        : s.shop_name || '(shop unavailable)';
      const reviewBadge =
        typeof s.shop_review_average === 'number' &&
        typeof s.shop_review_count === 'number'
          ? ` (${s.shop_review_count} reviews, ★${s.shop_review_average.toFixed(2)})`
          : '';
      lines.push(
        `${i + 1}. **${shopLabel}**${reviewBadge} — ${s.listing_title} — $${s.price.toFixed(2)} — ${s.num_favorers} favorers — [listing](${s.listing_url})`
      );
      if (s.notable_features.length > 0) {
        lines.push(`   - Notable: ${s.notable_features.join(', ')}`);
      }
    });
    lines.push('');
  }

  if (m.common_formats.length > 0) {
    lines.push(`**Common formats:** ${m.common_formats.join(', ')}`);
    lines.push('');
  }

  if (m.common_features.length > 0) {
    lines.push(`**Common features:** ${m.common_features.join(', ')}`);
    lines.push('');
  }

  if (m.opportunity_gaps.length > 0) {
    lines.push('### Opportunity Gaps');
    lines.push('');
    m.opportunity_gaps.forEach(g => lines.push(`- ${g}`));
    lines.push('');
  }

  // Product Specification
  const p = brief.product;
  lines.push('## Product Specification');
  lines.push('');
  lines.push(`**Name:** ${p.name}`);
  lines.push('');
  lines.push('### Format');
  lines.push(`- **File type:** ${p.format.file_type}`);
  lines.push(`- **Sizes:** ${p.format.sizes.join(', ')}`);
  lines.push(`- **Orientation:** ${p.format.orientation}`);
  lines.push(`- **Page count:** ${p.format.page_count}`);
  if (p.format.includes.length > 0) {
    lines.push('- **Includes:**');
    p.format.includes.forEach(item => lines.push(`  - ${item}`));
  }
  lines.push('');

  lines.push('### Design Direction');
  lines.push(`- **Style:** ${p.design.style}`);
  lines.push(`- **Palette:** ${p.design.palette.join(', ')}`);
  lines.push(`- **Mood:** ${p.design.mood_keywords.join(', ')}`);
  lines.push(`- **Typography:** ${p.design.typography}`);
  if (p.design.reference_descriptions.length > 0) {
    lines.push('- **References:**');
    p.design.reference_descriptions.forEach(r => lines.push(`  - ${r}`));
  }
  if (p.design.required_elements.length > 0) {
    lines.push('- **Required elements:**');
    p.design.required_elements.forEach(e => lines.push(`  - ${e}`));
  }
  lines.push('');

  // Listing Strategy
  const l = brief.listing;
  lines.push('## Listing Strategy');
  lines.push('');
  lines.push(`- **Primary keyword:** ${l.primary_keyword}`);
  lines.push(`- **Title template:** \`${l.title_template}\``);
  lines.push(`- **Etsy category:** ${l.etsy_category}`);
  lines.push(`- **Differentiation angle:** ${l.differentiation_angle}`);
  lines.push('');
  if (l.supporting_keywords.length > 0) {
    lines.push(`**Supporting keywords:** ${l.supporting_keywords.join(', ')}`);
    lines.push('');
  }
  if (l.etsy_tags.length > 0) {
    lines.push(`**Etsy tags:** ${l.etsy_tags.map(t => `\`${t}\``).join(', ')}`);
    lines.push('');
  }
  if (l.description_angles.length > 0) {
    lines.push('**Description angles (legacy summary):**');
    l.description_angles.forEach(a => lines.push(`- ${a}`));
    lines.push('');
  }

  // Structured description preview (v2+) — render the Etsy-plaintext shape
  // inside a code block so operators see exactly what would be published.
  if (l.description) {
    lines.push('### Listing Description (publish-ready, Etsy plaintext)');
    lines.push('');
    lines.push('```');
    lines.push(renderBriefAsEtsyDescription(brief));
    lines.push('```');
    lines.push('');
    if (l.description.attribute_vocabulary.length > 0) {
      lines.push(
        `**Cross-field vocabulary:** ${l.description.attribute_vocabulary.map(t => `\`${t}\``).join(', ')}`
      );
      lines.push('');
    }
  }

  // Attribute intent (v2+) — SEMANTIC descriptors, never raw store values.
  if (l.attribute_intent) {
    const ai = l.attribute_intent;
    lines.push('### Attribute Intent (semantic — Listing Agent maps to live possible_values)');
    lines.push('');
    lines.push(`- **Style descriptors:** ${ai.style_descriptors.join(', ') || '(none)'}`);
    lines.push(`- **Audience descriptors:** ${ai.audience_descriptors.join(', ') || '(none)'}`);
    lines.push(`- **Occasion descriptors:** ${ai.occasion_descriptors.join(', ') || '(none)'}`);
    lines.push(`- **Color descriptors:** ${ai.color_descriptors.join(', ') || '(none)'}`);
    lines.push(`- **Materials intent:** ${ai.materials_intent.join(', ') || '(none)'}`);
    lines.push('');
  }

  // Image spec (v2+)
  if (l.image_spec && l.image_spec.length > 0) {
    lines.push('### Image Spec');
    lines.push('');
    l.image_spec.forEach((slot, i) => {
      lines.push(`${i + 1}. **${slot.kind}** — ${slot.dims_recommended}`);
      lines.push(`   - *Purpose:* ${slot.purpose}`);
      lines.push(`   - *Style notes:* ${slot.style_notes}`);
    });
    lines.push('');
  }

  // Shop section suggestion (v2+)
  if (l.shop_section_suggestion) {
    lines.push(`**Shop section suggestion:** ${l.shop_section_suggestion}`);
    lines.push('');
  }

  // Competitive landscape (v2+) — the central Tuning Pass 2 capability.
  if (l.competitive_landscape && l.competitive_landscape.length > 0) {
    lines.push('## Competitive SEO Landscape');
    lines.push('');
    lines.push(
      'Per-keyword supply-side analysis. Engine: `scoreEtsyListingSeo` (v1 rubric, 10 rules, deterministic). See `brain/COMPETITIVE_SEO_SCORING.md`.'
    );
    lines.push('');
    l.competitive_landscape.forEach((entry, i) => {
      const cls = entry.classification.toUpperCase();
      lines.push(
        `### ${i + 1}. \`${entry.keyword}\` → **${cls}**`
      );
      lines.push('');
      lines.push(entry.gap_summary);
      lines.push('');
      if (entry.top_incumbents.length > 0) {
        lines.push('**Top incumbents (by favorers):**');
        entry.top_incumbents.forEach((inc, j) => {
          const pct = (inc.percent * 100).toFixed(0);
          lines.push(
            `${j + 1}. \`${inc.listing_id}\` — **${inc.score}/${inc.max} (${pct}%)** — ${inc.title}`
          );
          if (inc.weak_areas.length > 0) {
            lines.push(
              `   - *Weak:* ${inc.weak_areas.slice(0, 5).join(', ')}`
            );
          }
        });
        lines.push('');
      }
    });
  }

  // Pricing
  const pr = brief.pricing;
  lines.push('## Pricing');
  lines.push('');
  lines.push(`- **Recommended:** $${pr.recommended.toFixed(2)}`);
  lines.push(`- **Floor:** $${pr.floor.toFixed(2)}`);
  lines.push(`- **Ceiling:** $${pr.ceiling.toFixed(2)}`);
  lines.push('');
  lines.push(pr.reasoning);
  lines.push('');

  // Risks
  if (brief.risks.length > 0) {
    lines.push('## Risks');
    lines.push('');
    brief.risks.forEach(r => {
      lines.push(`### ${r.severity.toUpperCase()}: ${r.description}`);
      lines.push(`*Mitigation:* ${r.mitigation}`);
      lines.push('');
    });
  }

  // Footer
  lines.push('---');
  const agentLabel = ctx.agentVersion ?? 'research-v1';
  lines.push(`*Brief ID: ${ctx.briefId} | Cost: ${cost} | Agent: ${agentLabel}*`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sibling renderer — emits the publish-ready Etsy plaintext description for
// the structured listing.description field added in Tuning Pass 2.
//
// Plain text only (Etsy does not render markdown). ALL CAPS section headers,
// dashes for bullets, numbered "1. " for steps, "Q. " / "A. " for FAQ entries.
// Order is fixed per the Tuning Pass 2 schema. Sections backed by empty
// arrays are skipped; print_sizes is optional by spec.
//
// Used by:
//   - renderBriefAsMarkdown (above) — inline preview in the operator markdown
//   - the future Listing Agent — direct render to the Etsy description field
//   - operators copy-pasting from the markdown preview today (manual publish)
//
// If listing.description is absent (v1 brief), returns a single-line note
// pointing the caller at the legacy description_angles array.
// ---------------------------------------------------------------------------
export function renderBriefAsEtsyDescription(brief: ProductBrief): string {
  const d = brief.listing.description;
  if (!d) {
    return '(No structured listing.description — v1 brief. See listing.description_angles for the legacy advisory strings.)';
  }

  const out: string[] = [];

  // 1. Hook (no header — this IS the search-preview snippet)
  if (d.hook) {
    out.push(d.hook);
    out.push('');
  }

  // 2. WHY THIS ONE
  if (d.why_this_one) {
    out.push('WHY THIS ONE');
    out.push('');
    out.push(d.why_this_one);
    out.push('');
  }

  // 3. WHAT'S INCLUDED
  if (d.whats_included.length > 0) {
    out.push("WHAT'S INCLUDED");
    out.push('');
    d.whats_included.forEach(item => out.push(`- ${item}`));
    out.push('');
  }

  // 4. PRINT SIZES INCLUDED (optional)
  if (d.print_sizes && d.print_sizes.length > 0) {
    out.push('PRINT SIZES INCLUDED');
    out.push('');
    d.print_sizes.forEach(size => out.push(`- ${size}`));
    out.push('');
  }

  // 5. HOW IT WORKS
  if (d.how_it_works.length > 0) {
    out.push('HOW IT WORKS');
    out.push('');
    d.how_it_works.forEach((step, i) => out.push(`${i + 1}. ${step}`));
    out.push('');
  }

  // 6. FREQUENTLY ASKED QUESTIONS
  if (d.faq.length > 0) {
    out.push('FREQUENTLY ASKED QUESTIONS');
    out.push('');
    d.faq.forEach(({ q, a }, i) => {
      // Allow either "Q. ..." or bare text — normalize to "Q. ..." / "A. ...".
      const qNorm = /^Q\b/i.test(q.trim()) ? q.trim() : `Q. ${q.trim()}`;
      const aNorm = /^A\b/i.test(a.trim()) ? a.trim() : `A. ${a.trim()}`;
      out.push(qNorm);
      out.push(aNorm);
      if (i < d.faq.length - 1) out.push('');
    });
    out.push('');
  }

  // 7. Soft separator + closing
  if (d.closing) {
    out.push('—');
    out.push('');
    out.push(d.closing);
  }

  return out.join('\n').trimEnd();
}
