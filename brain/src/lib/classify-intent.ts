import Anthropic from '@anthropic-ai/sdk';
import { log } from './log.js';

export interface ClassifyInput {
  title: string;
  body: string;
  subreddit: string;
  score: number;
}

export interface ClassificationResult {
  intent: 'buyer' | 'seller' | 'other';
  confidence: number;
  reasoning: string;
}

// Lazy singleton — initialised on first call so dotenv has time to load
let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Missing ANTHROPIC_API_KEY. Add it to .env.local and the Railway Variables tab.'
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a signal classifier for an e-commerce market research tool. You read Reddit posts from crafts, Etsy, and digital-product communities and classify the poster's intent.

Classify each post into exactly one category:

**buyer** — The poster is a consumer looking to find, buy, or print a product. They express desire for something that exists or should exist.
Examples:
- "I'm looking for an A5 monthly calendar printable — does anyone have a link?" → buyer
- "Does anyone make wedding invitation templates with a rustic theme?" → buyer
- "Where can I find good SVG files for Cricut that aren't too complicated?" → buyer
- "I wish there was a budget tracker printable that also had a meal planner" → buyer

**seller** — The poster is a maker, creator, or Etsy seller discussing their own business, shop, workflow, pricing, platform policies, or craft technique. They are not looking to purchase anything.
Examples:
- "My Etsy shop got suspended — has anyone successfully appealed?" → seller
- "How do you price digital downloads? I'm charging $3 but not sure if it's right" → seller
- "Just opened my Etsy shop selling SVG files, any tips for getting first sales?" → seller
- "Cricut Design Space keeps crashing when I try to upload my designs" → seller (tool problem, not buying)

**other** — General community discussion, tutorials, sharing completed work, product reviews, complaints about tools without purchase intent, or anything that doesn't fit buyer or seller.
Examples:
- "Look at this planner spread I just finished!" → other (sharing work)
- "Has anyone tried the new Cricut Air 4?" → other (product review)
- "Tips for weeding fine vinyl?" → other (technique question)

Respond with valid JSON only, no markdown fences, no extra text:
{"intent":"buyer"|"seller"|"other","confidence":0.0-1.0,"reasoning":"one sentence"}`;

export async function classifyIntent(
  input: ClassifyInput
): Promise<ClassificationResult> {
  try {
    const anthropic = getClient();

    const userMessage = `Subreddit: r/${input.subreddit}
Score: ${input.score} upvotes
Title: ${input.title}
Body: ${input.body.slice(0, 600) || '(no body)'}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const rawText =
      message.content[0]?.type === 'text' ? message.content[0].text.trim() : '';

    // Haiku sometimes wraps JSON in ```json ... ``` fences despite instructions.
    // Strip them before parsing.
    const raw = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(raw) as {
      intent: string;
      confidence: number;
      reasoning: string;
    };

    if (
      !['buyer', 'seller', 'other'].includes(parsed.intent) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reasoning !== 'string'
    ) {
      throw new Error(`Unexpected JSON shape: ${raw}`);
    }

    return {
      intent: parsed.intent as 'buyer' | 'seller' | 'other',
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reasoning: parsed.reasoning
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await log({
      agent: 'intel',
      action: 'classify_intent.failed',
      description: `Intent classification failed for "${input.title.slice(0, 80)}"`,
      severity: 'warning',
      metadata: {
        subreddit: input.subreddit,
        title: input.title.slice(0, 80),
        error: msg
      }
    });

    return { intent: 'other', confidence: 0, reasoning: 'classification_failed' };
  }
}
