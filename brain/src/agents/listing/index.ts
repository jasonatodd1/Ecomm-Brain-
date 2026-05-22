// Listing Agent — orchestrator (v1, Etsy, package-only).
//
// Public entry point: `generateListingPackage(briefId, opts)`. Produces a
// `PublishPackage` per LISTING_AGENT_REQUIREMENTS.md §5 and writes a
// human-reviewable markdown alongside it. Does NOT publish to Etsy in v1 —
// publish is gated on OAuth (Phase 2).
//
// Audit trail:
//   - One `agent_runs` row per (brief_id, store) invocation.
//   - Discrete `activity` rows for each step (taxonomy.resolved,
//     attributes.filled, image.assigned/image.missing, description.rendered,
//     tags.validated, package.scored, listing.preview_ready).
//   - The full PublishPackage is stored in agent_runs.metadata.package so a
//     replay can reproduce the markdown without re-running.
//
// Side effects:
//   - Reads:   product_briefs, decisions_needed, listings, assets,
//              niche_memory, Etsy seller-taxonomy endpoints.
//   - Writes:  agent_runs, activity, brain/packages/<date>-<brief_id>-etsy.md.
//   - LLMs:    Opus called ONCE (max) for the improve-draft pass; only when
//              the deterministic draft scores below the incumbent benchmark.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { supabase } from '../../lib/supabase.js';
import { log } from '../../lib/log.js';
import {
  scoreEtsyListingSeo,
  type SeoScore,
} from '../../lib/etsy-seo-scoring.js';
import type { EtsyListingDetails } from '../../lib/etsy-search.js';
import {
  getTaxonomyProperties,
  mapBreadcrumbToTaxonomyId,
  type BreadcrumbResolution,
  type TaxonomyProperty,
} from '../../lib/etsy-taxonomy.js';

import {
  validateTitle,
  validateTags,
  mapAttributes,
  buildImageManifest,
  type AssetRow,
} from './adapters/etsy.js';
import { renderPackageAsMarkdown } from './render-markdown.js';
import { improveDraft } from './improve.js';
import { renderBriefAsEtsyDescription } from '../research/render-markdown.js';
import type { ProductBrief } from '../research/types.js';
import type {
  PublishPackage,
  IncumbentBenchmark,
  ImageSlot,
} from './types.js';

const PACKAGE_VERSION = 'listing-v1' as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export interface GenerateOptions {
  store?: 'etsy';
  /** Operator override — UUID from `listings.id`. Skips opportunity-based lookup. */
  listingId?: string;
}

export interface GenerateResult {
  package: PublishPackage;
  packageMarkdownPath: string;
  runId: string;
}

export async function generateListingPackage(
  briefId: string,
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const store = opts.store ?? 'etsy';
  let totalCostUsd = 0;
  let currentStep = 'init';
  const startedAt = new Date();

  // ------ Create agent_runs row ------------------------------------------
  const { data: runRow, error: runErr } = await supabase
    .from('agent_runs')
    .insert({
      agent_name: 'listing',
      status: 'running',
      input_ref: briefId,
      model_used: 'claude-opus-4-7',
      cost_usd: 0,
      metadata: { store, options: opts },
    })
    .select('id')
    .single();
  if (runErr || !runRow) {
    throw new Error(`Failed to create listing agent_runs row: ${runErr?.message ?? 'unknown'}`);
  }
  const runId = runRow.id as string;

  try {
    // ------ Step 1: load the brief --------------------------------------
    currentStep = 'load_brief';
    const { data: briefRow, error: briefErr } = await supabase
      .from('product_briefs')
      .select('id, decision_id, brief, agent_version')
      .eq('id', briefId)
      .maybeSingle();
    if (briefErr) throw new Error(`load_brief: ${briefErr.message}`);
    if (!briefRow) throw new Error(`load_brief: brief ${briefId} not found`);
    const brief = briefRow.brief as ProductBrief;

    // ------ Step 2: resolve listing -------------------------------------
    currentStep = 'resolve_listing';
    let listingUuid: string | undefined = opts.listingId;
    let etsyListingId: string | undefined;
    if (!listingUuid) {
      // Look up via decisions_needed.context.opportunity_id (when present)
      // → listings.opportunity_id. Both bunny + planner have a listing this
      // brief was intended for; the planner brief was Reddit-sourced (no
      // opportunity_id in decision.context), so this lookup may miss for it.
      // The operator passes --listing-id explicitly in that case.
      const { data: decision, error: decErr } = await supabase
        .from('decisions_needed')
        .select('context')
        .eq('id', briefRow.decision_id as string)
        .maybeSingle();
      if (decErr) throw new Error(`resolve_listing(decision): ${decErr.message}`);
      const oppId =
        decision?.context &&
        typeof (decision.context as Record<string, unknown>)['opportunity_id'] === 'string'
          ? ((decision.context as Record<string, unknown>)['opportunity_id'] as string)
          : null;
      if (oppId) {
        const { data: lst, error: lstErr } = await supabase
          .from('listings')
          .select('id, etsy_listing_id')
          .eq('opportunity_id', oppId)
          .limit(1)
          .maybeSingle();
        if (lstErr) throw new Error(`resolve_listing(listings): ${lstErr.message}`);
        if (lst) {
          listingUuid = lst.id as string;
          etsyListingId = (lst.etsy_listing_id as string) ?? undefined;
        }
      }
    } else {
      const { data: lst, error: lstErr } = await supabase
        .from('listings')
        .select('id, etsy_listing_id')
        .eq('id', listingUuid)
        .maybeSingle();
      if (lstErr) throw new Error(`resolve_listing(by-id): ${lstErr.message}`);
      if (lst) etsyListingId = (lst.etsy_listing_id as string) ?? undefined;
    }

    await log({
      agent: 'listing',
      action: 'listing.resolved',
      description: listingUuid
        ? `Detected existing listing ${etsyListingId ?? listingUuid.slice(0, 8)} — re-publish path.`
        : `No existing listing — new-publish path.`,
      metadata: { run_id: runId, brief_id: briefId, listing_id: listingUuid, etsy_listing_id: etsyListingId },
    });

    // ------ Step 3: load assets -----------------------------------------
    currentStep = 'load_assets';
    const orFilters: string[] = [];
    if (listingUuid) orFilters.push(`listing_id.eq.${listingUuid}`);
    orFilters.push(`product_brief_id.eq.${briefId}`);
    const { data: assetRowsRaw, error: assetErr } = await supabase
      .from('assets')
      .select('id, kind, source, local_path, cdn_url, width, height')
      .or(orFilters.join(','));
    if (assetErr) throw new Error(`load_assets: ${assetErr.message}`);
    const assets = (assetRowsRaw ?? []) as AssetRow[];

    await log({
      agent: 'listing',
      action: 'assets.loaded',
      description: `Loaded ${assets.length} assets (${countByKind(assets)})`,
      metadata: { run_id: runId, brief_id: briefId, listing_id: listingUuid, asset_count: assets.length },
    });

    // ------ Step 4: load niche_memory (informative; not currently consumed) -
    currentStep = 'load_niche_memory';
    const niche = inferNicheTag(brief);
    if (niche) {
      await supabase.from('niche_memory').select('memory_key').eq('niche_tag', niche);
    }

    // ------ Step 5: resolve taxonomy ------------------------------------
    currentStep = 'resolve_taxonomy';
    const breadcrumb = brief.listing.etsy_category ?? '';
    if (!breadcrumb) throw new Error('resolve_taxonomy: brief.listing.etsy_category missing');
    let breadcrumbRes: BreadcrumbResolution;
    try {
      breadcrumbRes = await mapBreadcrumbToTaxonomyId(breadcrumb);
    } catch (err) {
      throw new Error(`resolve_taxonomy: ${(err as Error).message}`);
    }

    // ------ Step 6: fetch taxonomy properties ---------------------------
    currentStep = 'fetch_properties';
    const properties = await getTaxonomyProperties(breadcrumbRes.taxonomy_id);

    // ------ Step 7: render description plaintext ------------------------
    currentStep = 'render_description';
    const descriptionPlaintext = renderBriefAsEtsyDescription(brief);
    if (descriptionPlaintext.startsWith('(No structured listing.description')) {
      throw new Error(
        `render_description: brief ${briefId} has no structured listing.description (v1 brief — Listing Agent v1 requires v2 brief shape)`
      );
    }
    await log({
      agent: 'listing',
      action: 'description.rendered',
      description: `Rendered ${descriptionPlaintext.length}-char Etsy plaintext description from brief.listing.description.`,
      metadata: { run_id: runId, brief_id: briefId, char_count: descriptionPlaintext.length },
    });

    // ------ Step 8: validate title --------------------------------------
    currentStep = 'validate_title';
    const titleRes = validateTitle(brief.listing.title_template ?? '');
    await log({
      agent: 'listing',
      action: 'title.validated',
      description: titleRes.note,
      metadata: { run_id: runId, brief_id: briefId, title_len: titleRes.title.length, changed: titleRes.changed },
    });

    // ------ Step 9: validate tags ---------------------------------------
    currentStep = 'validate_tags';
    const tagsRes = validateTags(brief.listing.etsy_tags ?? [], titleRes.title);
    await log({
      agent: 'listing',
      action: 'tags.validated',
      description: tagsRes.note,
      metadata: {
        run_id: runId,
        brief_id: briefId,
        kept: tagsRes.tags.length,
        dropped: tagsRes.dropped,
      },
    });

    // ------ Step 10: map attributes -------------------------------------
    currentStep = 'map_attributes';
    const attrRes = mapAttributes(brief, properties);
    await log({
      agent: 'listing',
      action: 'attributes.mapped',
      description: `Mapped ${attrRes.attributes.length} attributes; skipped ${attrRes.attributes_skipped.length}.`,
      metadata: {
        run_id: runId,
        brief_id: briefId,
        taxonomy_id: breadcrumbRes.taxonomy_id,
        mapped: attrRes.attributes.map(a => a.property_name),
        skipped: attrRes.attributes_skipped.map(s => ({ name: s.property_name, reason: s.reason })),
        any_substituted: attrRes.attributes.some(a => a.any_substituted),
      },
    });

    // ------ Step 11: build image manifest --------------------------------
    currentStep = 'build_image_manifest';
    const imageManifest = buildImageManifest({
      imageSpec: brief.listing.image_spec,
      assets,
      product_name: brief.product.name,
      design_mood: (brief.product.design.mood_keywords ?? []).join(', '),
    });
    const readyCount = imageManifest.filter(s => s.status === 'ready').length;
    await log({
      agent: 'listing',
      action: 'image_manifest.built',
      description: `Image manifest: ${readyCount}/${imageManifest.length} slots ready.`,
      metadata: {
        run_id: runId,
        brief_id: briefId,
        slots: imageManifest.map(s => ({
          slot: s.slot,
          kind: s.kind,
          status: s.status,
          asset_id: s.asset_id,
        })),
      },
    });

    // ------ Step 12: pick incumbent benchmark ---------------------------
    currentStep = 'pick_benchmark';
    const benchmark = pickIncumbentBenchmark(brief);

    // ------ Step 13: score draft v1 -------------------------------------
    currentStep = 'score_draft';
    // shop_section_id is set when the listing is actually published. For
    // scoring purposes, treat "brief suggested a section" as "section will be
    // assigned at publish" — this matches Rule 9's binary check. Our `listings`
    // table doesn't store shop_section_id (it lives in Etsy + listings_stats.raw),
    // so we synthesize a non-null placeholder here.
    const draftListing = synthesizeDraftListingForScoring({
      title: titleRes.title,
      description: descriptionPlaintext,
      tags: tagsRes.tags,
      shopSectionId: brief.listing.shop_section_suggestion ? 1 : null,
    });
    const applicableAttributeCount = properties.filter(p => isPropertyApplicable(p)).length;
    let seoScore: SeoScore = scoreEtsyListingSeo(draftListing, {
      primary_keyword: brief.listing.primary_keyword,
      niche_tag: niche ?? undefined,
      applicable_attribute_count: applicableAttributeCount,
      filled_attribute_count: attrRes.attributes.length,
    });

    if (benchmark) {
      benchmark.our_percent = seoScore.percent;
      benchmark.beats = seoScore.percent >= benchmark.incumbent_median_percent;
    }

    await log({
      agent: 'listing',
      action: 'package.scored',
      description: `Draft SEO score ${seoScore.total}/${seoScore.max} (${Math.round(seoScore.percent * 100)}%); ${benchmark ? (benchmark.beats ? 'beats' : 'below') + ' incumbents' : 'no benchmark'}.`,
      metadata: {
        run_id: runId,
        brief_id: briefId,
        weak_areas: seoScore.weak_areas,
        incumbent_benchmark: benchmark,
      },
    });

    // ------ Step 14: one-shot Opus improvement if below benchmark -------
    let preImprovementScore: SeoScore | undefined;
    let finalTitle = titleRes.title;
    let finalTags = tagsRes.tags;
    let finalDescription = descriptionPlaintext;

    if (benchmark && !benchmark.beats && seoScore.weak_areas.length > 0) {
      currentStep = 'improve_draft';
      try {
        const weakNotes = seoScore.weak_areas.map(rule => ({
          rule,
          note: seoScore.detailed_breakdown[rule]?.note ?? '',
        }));
        const improved = await improveDraft({
          title: finalTitle,
          tags: finalTags,
          description: finalDescription,
          primary_keyword: brief.listing.primary_keyword,
          weak_areas: seoScore.weak_areas,
          weak_area_notes: weakNotes,
          persona_hint: brief.audience?.persona,
        });
        totalCostUsd += improved.cost_usd;

        await log({
          agent: 'listing',
          action: 'cost.api_call',
          description: 'Opus draft improvement pass',
          metadata: {
            run_id: runId,
            brief_id: briefId,
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            step: 'improve_draft',
            estimated_cost_usd: improved.cost_usd,
          },
        });

        // Re-validate the Opus output (title length, tags rules).
        const reTitle = validateTitle(improved.title);
        const reTags = validateTags(improved.tags, reTitle.title);
        finalTitle = reTitle.title;
        finalTags = reTags.tags;
        finalDescription = improved.description;

        preImprovementScore = seoScore;
        const reDraft = synthesizeDraftListingForScoring({
          title: finalTitle,
          description: finalDescription,
          tags: finalTags,
          shopSectionId: draftListing.shop_section_id,
        });
        seoScore = scoreEtsyListingSeo(reDraft, {
          primary_keyword: brief.listing.primary_keyword,
          niche_tag: niche ?? undefined,
          applicable_attribute_count: applicableAttributeCount,
          filled_attribute_count: attrRes.attributes.length,
        });

        if (benchmark) {
          benchmark.our_percent = seoScore.percent;
          benchmark.beats = seoScore.percent >= benchmark.incumbent_median_percent;
        }

        await log({
          agent: 'listing',
          action: 'package.rescored',
          description: `After improve: ${seoScore.total}/${seoScore.max} (${Math.round(seoScore.percent * 100)}%); ${benchmark?.beats ? 'beats' : 'still below'} benchmark.`,
          metadata: {
            run_id: runId,
            brief_id: briefId,
            pre: { score: preImprovementScore.total, max: preImprovementScore.max, percent: preImprovementScore.percent },
            post: { score: seoScore.total, max: seoScore.max, percent: seoScore.percent },
            benchmark,
          },
        });
      } catch (err) {
        // Improvement failure is non-fatal — the deterministic draft still
        // ships, with a gap flagging the failure.
        const msg = err instanceof Error ? err.message : String(err);
        await log({
          agent: 'listing',
          action: 'improve_draft.failed',
          description: `Opus improvement pass failed: ${msg}`,
          severity: 'warning',
          metadata: { run_id: runId, brief_id: briefId, error: msg },
        });
      }
    }

    // ------ Step 15: assemble final package + gaps -----------------------
    currentStep = 'assemble_package';
    const materials = (brief.listing.attribute_intent?.materials_intent ?? []).slice(0, 13);

    const gaps = collectGaps({
      titleChanged: finalTitle !== brief.listing.title_template,
      tagsKept: finalTags.length,
      tagsDropped: tagsRes.dropped,
      imageManifest,
      breadcrumbFallback: breadcrumbRes.fallback,
      attributesSubstituted: attrRes.attributes.filter(a => a.any_substituted),
      benchmark,
      improvedRan: !!preImprovementScore,
      shopSectionMissing: !brief.listing.shop_section_suggestion,
    });

    const pkg: PublishPackage = {
      brief_id: briefId,
      listing_id: listingUuid,
      etsy_listing_id: etsyListingId,
      store: 'etsy',
      title: finalTitle,
      description_plaintext: finalDescription,
      tags: finalTags,
      taxonomy_id: breadcrumbRes.taxonomy_id,
      taxonomy_breadcrumb: breadcrumbRes.matched_path,
      taxonomy_fallback: breadcrumbRes.fallback
        ? {
            matched_path: breadcrumbRes.matched_path,
            unmatched_tail: breadcrumbRes.unmatched_tail,
          }
        : undefined,
      attributes: attrRes.attributes,
      attributes_skipped: attrRes.attributes_skipped,
      materials,
      shop_section_suggestion: brief.listing.shop_section_suggestion,
      image_manifest: imageManifest,
      seo_score: seoScore,
      incumbent_benchmark: benchmark,
      pre_improvement_score: preImprovementScore,
      gaps,
      cost_usd: totalCostUsd,
      package_version: PACKAGE_VERSION,
    };

    // ------ Step 16: write markdown to disk -----------------------------
    currentStep = 'write_markdown';
    const generatedAt = startedAt.toISOString();
    const md = renderPackageAsMarkdown(pkg, {
      costUsd: totalCostUsd,
      packageVersion: PACKAGE_VERSION,
      generatedAt,
    });
    const pkgDir = path.resolve(process.cwd(), 'packages');
    await mkdir(pkgDir, { recursive: true });
    const dateStr = generatedAt.slice(0, 10);
    const filename = `${dateStr}-${briefId.slice(0, 8)}-${store}.md`;
    const filepath = path.join(pkgDir, filename);
    await writeFile(filepath, md, 'utf-8');

    // ------ Step 17: finalize agent_runs --------------------------------
    currentStep = 'finalize_run';
    const { error: completeErr } = await supabase
      .from('agent_runs')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        output_ref: filepath,
        cost_usd: totalCostUsd,
        metadata: {
          store,
          options: opts,
          markdown_path: filepath,
          package: pkg,
          // The full package fits comfortably in jsonb (~30-50KB) and gives
          // replay/audit without re-running. Don't omit it.
        },
      })
      .eq('id', runId);
    if (completeErr) throw new Error(`finalize_run: ${completeErr.message}`);

    await log({
      agent: 'listing',
      action: 'listing.preview_ready',
      description: `Listing package ready for ${etsyListingId ?? '(new)'} — see ${filepath}`,
      severity: 'success',
      metadata: {
        run_id: runId,
        brief_id: briefId,
        listing_id: listingUuid,
        seo_score: { score: seoScore.total, max: seoScore.max, percent: seoScore.percent },
        benchmark_beats: benchmark?.beats ?? null,
        gaps_count: gaps.length,
        ready_image_slots: readyCount,
        markdown_path: filepath,
      },
    });

    return { package: pkg, packageMarkdownPath: filepath, runId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: msg,
        cost_usd: totalCostUsd,
        metadata: { store, options: opts, failed_step: currentStep },
      })
      .eq('id', runId);
    await log({
      agent: 'listing',
      action: 'listing.failed',
      description: `Listing Agent failed at step "${currentStep}" for brief ${briefId.slice(0, 8)}`,
      severity: 'error',
      metadata: { run_id: runId, brief_id: briefId, step: currentStep, error: msg },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countByKind(assets: AssetRow[]): string {
  const counts: Record<string, number> = {};
  for (const a of assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function inferNicheTag(brief: ProductBrief): string | null {
  // The Research Agent uses subreddit for Reddit decisions and 'general'
  // otherwise. Briefs don't carry the niche_tag back directly, so we
  // approximate from the primary keyword's most informative noun. v1 just
  // returns null when we can't infer — niche_memory consumption is best-effort.
  if (!brief.listing.primary_keyword) return null;
  const tokens = brief.listing.primary_keyword.toLowerCase().split(/\s+/);
  // Heuristic: pick the longest noun-like token, ≥5 chars, not generic.
  const generic = new Set(['printable', 'digital', 'download', 'template', 'instant', 'wall']);
  const candidate = tokens
    .filter(t => t.length >= 5 && !generic.has(t))
    .sort((a, b) => b.length - a.length)[0];
  return candidate ?? null;
}

function pickIncumbentBenchmark(brief: ProductBrief): IncumbentBenchmark | undefined {
  const cl = brief.listing.competitive_landscape;
  if (!cl || cl.length === 0) return undefined;
  // Pick the keyword with the toughest classification — that's the one we
  // most want to beat. Tie-break by highest incumbent median percent.
  const order: Record<string, number> = {
    red_ocean: 0,
    mixed: 1,
    weak_incumbents: 2,
    open_field: 3,
  };
  const sorted = [...cl].sort((a, b) => {
    const oa = order[a.classification] ?? 99;
    const ob = order[b.classification] ?? 99;
    if (oa !== ob) return oa - ob;
    const ma = median(a.top_incumbents.slice(0, 3).map(i => i.percent));
    const mb = median(b.top_incumbents.slice(0, 3).map(i => i.percent));
    return mb - ma;
  });
  const target = sorted[0];
  const top3 = target.top_incumbents.slice(0, 3);
  if (top3.length === 0) return undefined;
  const incMed = median(top3.map(i => i.percent));
  return {
    keyword: target.keyword,
    incumbent_median_percent: incMed,
    our_percent: 0, // filled in after scoring
    beats: false,
    incumbent_count: top3.length,
  };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Synthesize a minimal `EtsyListingDetails`-shaped object so the existing
// scorer (which expects a fetched live listing) can score our DRAFT. We only
// populate the fields the scorer actually reads — leaving the rest as
// nulls keeps the type honest.
interface DraftScoringListing extends EtsyListingDetails {}
function synthesizeDraftListingForScoring(args: {
  title: string;
  description: string;
  tags: string[];
  shopSectionId: number | null;
}): DraftScoringListing {
  return {
    listing_id: 0,
    shop_id: null,
    state: 'draft',
    title: args.title,
    url: '',
    description: args.description,
    tags: args.tags,
    views: null,
    num_favorers: null,
    price_cents: null,
    currency_code: null,
    last_modified_timestamp: null,
    shop_section_id: args.shopSectionId,
    raw: {},
  };
}

// Mirror of adapters/etsy.ts PROPERTY_BLOCKLIST. Used for SEO Rule 8's
// applicable_attribute_count denominator: count only properties the agent
// would actually try to fill (i.e. not block-listed and not free-text).
function isPropertyApplicable(p: TaxonomyProperty): boolean {
  const blocked = new Set([
    'teeshirtsize', 'device', 'custom1', 'custom2',
    'fabric', 'scent', 'flavor', 'weight',
    'diameter', 'length', 'width', 'height', 'depth', 'dimensions',
    'finish', 'sustainability', 'framing',
    'can be personalized', 'number of pieces included',
    'orientation', 'aspect ratio',
  ]);
  if (blocked.has(p.name.toLowerCase())) return false;
  if (!p.possible_values || p.possible_values.length === 0) return false;
  return true;
}

function collectGaps(args: {
  titleChanged: boolean;
  tagsKept: number;
  tagsDropped: Array<{ tag: string; reason: string }>;
  imageManifest: ImageSlot[];
  breadcrumbFallback: boolean;
  attributesSubstituted: Array<{ property_name: string; values: Array<{ matched_from: string; value: string }> }>;
  benchmark?: IncumbentBenchmark;
  improvedRan: boolean;
  shopSectionMissing: boolean;
}): string[] {
  const gaps: string[] = [];
  if (args.tagsKept < 13) {
    gaps.push(
      `Tags short: ${args.tagsKept}/13. Brief produced ${args.tagsKept + args.tagsDropped.length}, ${args.tagsDropped.length} dropped (${args.tagsDropped.map(d => `"${d.tag}" — ${d.reason}`).join('; ')}). Add ${13 - args.tagsKept} more tags before publish.`
    );
  }
  if (args.titleChanged) {
    gaps.push(`Title was edited from brief verbatim (truncation or trim).`);
  }
  const missing = args.imageManifest.filter(s => s.status === 'missing');
  if (missing.length > 0) {
    gaps.push(
      `${missing.length} image slot${missing.length === 1 ? '' : 's'} missing: ${missing.map(s => `slot ${s.slot} (${s.kind})`).join(', ')}. See image manifest for generation hints.`
    );
  }
  if (args.breadcrumbFallback) {
    gaps.push(
      `Taxonomy fell back to parent — brief's etsy_category breadcrumb didn't match Etsy's tree exactly. Confirm the parent is the right category before publish.`
    );
  }
  if (args.attributesSubstituted.length > 0) {
    const desc = args.attributesSubstituted
      .map(
        a =>
          `${a.property_name} (${a.values.map(v => `"${v.matched_from}"→"${v.value}"`).join(', ')})`
      )
      .join('; ');
    gaps.push(`Attributes substituted (review): ${desc}.`);
  }
  if (args.benchmark && !args.benchmark.beats) {
    gaps.push(
      `SEO score still below incumbent benchmark for "${args.benchmark.keyword}" — ours ${Math.round(args.benchmark.our_percent * 100)}% vs incumbents ${Math.round(args.benchmark.incumbent_median_percent * 100)}%. ${args.improvedRan ? 'One Opus improvement pass already ran.' : ''} Consider manual edits to the weak areas before publish.`
    );
  }
  if (args.shopSectionMissing) {
    gaps.push(
      `No shop_section_suggestion in brief — assign one in Etsy at publish (Shop section is a scored field).`
    );
  }
  return gaps;
}
