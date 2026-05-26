import Anthropic from '@anthropic-ai/sdk';
import { log } from './log.js';

export interface TrendClassifyInput {
  query: string;
  categories: Array<{ id: number; name: string }>;
  search_volume: number;
  increase_percentage: number;
  trend_breakdown?: string[];
}

export type TrendDropReason = 'noise' | 'ip' | 'none';

export interface TrendClassificationResult {
  verdict: 'keep' | 'drop';
  drop_reason: TrendDropReason;
  classification: string;
  reasoning: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing ANTHROPIC_API_KEY. Add it to .env.local and Railway Variables.'
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a trend relevance gate for a small e-commerce shop (digital printables, physical maker goods, dropship). You classify Google Trends "Trending Now" queries.

Apply TWO filters in order:

**1. PRODUCT vs NOISE**
KEEP only if the trend represents a buyable consumer PRODUCT CATEGORY a small maker/print/dropship shop could create and sell around (digital or physical).
DROP if it is noise: a one-off news event, celebrity gossip, election/politics, sports game result, stock ticker, weather event, generic service, or non-product trend with no merchandise angle.

Examples KEEP (generic product angles):
- "weighted blanket" → keep (generic product category)
- "meal prep containers" → keep
- "cottagecore aesthetic" → keep (generic aesthetic → decor/printables)
- "pickleball" → keep (generic sport → gear/printables, NOT a specific team)

Examples DROP (noise):
- "tom thibodeau" → drop (person/news)
- "game 7 nba finals" → drop (one-off event)
- "dutch government collapses" → drop (news)

**2. HARD IP BLOCK** (even if product-adjacent)
DROP if the trend's value depends on a NAMED franchise, team, league, celebrity, public figure, copyrighted property, or branded product. Fan merch of named IP is forbidden.
Especially strict for Entertainment, Games, Sports, Autos categories.

Examples DROP (IP):
- "Taylor Swift Eras Tour" → drop (named celebrity)
- "Minecraft update" → drop (named game IP) — but "sandbox game merch" without the name would be keep
- "Lakers vs Celtics" → drop (named teams)
- "PS6" → drop (named product IP)
- "Ford F-150" → drop (named brand/model)

Examples KEEP (generic in IP-heavy categories):
- "retro gaming room decor" → keep (no named IP)
- "marathon training plan printable" → keep (generic sport, no team)
- "car organization accessories" → keep (generic autos)

Respond with valid JSON only, no markdown:
{"verdict":"keep"|"drop","drop_reason":"noise"|"ip"|"none","classification":"short label e.g. home_decor|news_event|named_ip","reasoning":"one sentence"}`;

export async function classifyTrendRelevance(
  input: TrendClassifyInput
): Promise<TrendClassificationResult> {
  try {
    const anthropic = getClient();
    const categoryNames = input.categories.map(c => c.name).join(', ') || 'unknown';
    const breakdown =
      input.trend_breakdown && input.trend_breakdown.length > 0
        ? input.trend_breakdown.slice(0, 5).join('; ')
        : '(none)';

    const userMessage = `Query: ${input.query}
Categories: ${categoryNames}
Search volume: ${input.search_volume}
Increase %: ${input.increase_percentage}
Related queries: ${breakdown}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const rawText =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';
    const raw = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(raw) as {
      verdict: string;
      drop_reason: string;
      classification: string;
      reasoning: string;
    };

    if (
      !['keep', 'drop'].includes(parsed.verdict) ||
      !['noise', 'ip', 'none'].includes(parsed.drop_reason) ||
      typeof parsed.classification !== 'string' ||
      typeof parsed.reasoning !== 'string'
    ) {
      throw new Error(`Unexpected JSON shape: ${raw}`);
    }

    return {
      verdict: parsed.verdict as 'keep' | 'drop',
      drop_reason: parsed.drop_reason as TrendDropReason,
      classification: parsed.classification,
      reasoning: parsed.reasoning
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await log({
      agent: 'intel',
      action: 'classify_trend.failed',
      description: `Trend relevance classification failed for "${input.query.slice(0, 80)}"`,
      severity: 'warning',
      metadata: { query: input.query.slice(0, 80), error: msg }
    });

    return {
      verdict: 'drop',
      drop_reason: 'noise',
      classification: 'classification_failed',
      reasoning: 'classification_failed — dropped conservatively'
    };
  }
}
