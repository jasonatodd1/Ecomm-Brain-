import type { ProductBrief, DecisionRecord } from './types.js';

interface RenderContext {
  briefId: string;
  costUsd: number;
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
      lines.push(
        `${i + 1}. **[${s.listing_title}](${s.listing_url})** — ${s.shop_name} — $${s.price.toFixed(2)} — ${s.num_favorers} favorers`
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
    lines.push('**Description angles:**');
    l.description_angles.forEach(a => lines.push(`- ${a}`));
    lines.push('');
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
  lines.push(`*Brief ID: ${ctx.briefId} | Cost: ${cost} | Agent: research-v1*`);

  return lines.join('\n');
}
