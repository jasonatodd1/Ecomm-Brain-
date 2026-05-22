// One-shot Opus pass to lift a draft listing's SEO score above the
// incumbent benchmark, when the deterministic assembly couldn't get there
// on its own.
//
// Per LISTING_AGENT_REQUIREMENTS.md §3:
//   "If the draft scores below the ceiling, iterate with Opus on the
//   specific weak_areas returned by the scorer (max 2 retry passes
//   recorded in agent_runs.metadata.draft_iterations[])."
//
// For v1 we ship ONE pass (not two) because each pass is ~$0.10–0.15 and
// we want explicit operator visibility into how many tries the agent
// spent. If quality demands more passes we'll widen the cap in v1.1.
//
// The model is constrained to OUTPUT JUST THE THREE EDITABLE FIELDS
// (title, tags, description) — never invent attributes, never expand the
// schema. Anything else it returns is dropped.
import Anthropic from '@anthropic-ai/sdk';

const OPUS_MODEL = 'claude-opus-4-7';
// Empirically: a focused rewrite pass on (title + 13 tags + a 2000-char
// description) lands at ~2.5-3k output tokens. Budget $0.10 per pass and
// log it; reality is metered downstream by Anthropic's billing.
export const IMPROVE_COST_USD = 0.1;

export interface ImproveInput {
  title: string;
  tags: string[];
  description: string;
  primary_keyword: string;
  /** From scoreEtsyListingSeo. Each is a rule key like "title_keyword_placement". */
  weak_areas: string[];
  /** From SeoScore.detailed_breakdown — gives the LLM concrete failure notes. */
  weak_area_notes: Array<{ rule: string; note: string }>;
  /** Just to anchor voice + persona. Free-form. */
  persona_hint?: string;
}

export interface ImproveOutput {
  title: string;
  tags: string[];
  description: string;
  /** Estimated cost contribution from this call. */
  cost_usd: number;
  /** Diagnostic — raw model output for audit trail. */
  raw_text: string;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function getText(message: Anthropic.Message): string {
  const b = message.content[0];
  if (b && b.type === 'text') return b.text;
  throw new Error('Opus response had no text block');
}

const SYSTEM = `You are an Etsy listing copy editor.
Your only job: produce a minimally-edited title, tag list, and description that
fix the listed SEO weak areas without changing the product's fundamental
positioning or persona. You MUST output valid JSON with exactly these keys:
  { "title": string, "tags": string[], "description": string }
No commentary, no markdown fences, no extra fields.

Hard constraints:
- title ≤140 characters
- exactly 13 tags, each ≤20 characters, no full-phrase duplicates of the title
- description is Etsy-plaintext: ALL-CAPS section headers, dash bullets, NO markdown
- the primary keyword MUST appear in the first 30 chars of the title AND the first 160 chars of the description (those are the two highest-leverage SEO placements)
- preserve the persona / voice / claims from the input — you are editing, not rewriting`;

function buildUserPrompt(input: ImproveInput): string {
  const notesBlock = input.weak_area_notes
    .map(n => `- ${n.rule}: ${n.note}`)
    .join('\n');
  return `Primary keyword to rank for: "${input.primary_keyword}"

${input.persona_hint ? `Persona: ${input.persona_hint}\n` : ''}
Current draft scored below the incumbent benchmark. The scorer flagged these
weak areas (highest gap first):
${input.weak_areas.map(w => `  - ${w}`).join('\n')}

Per-rule notes from the scorer:
${notesBlock}

Current title (${input.title.length} chars):
${input.title}

Current tags (${input.tags.length}):
${input.tags.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Current description:
${input.description}

Output JSON only.`;
}

export async function improveDraft(input: ImproveInput): Promise<ImproveOutput> {
  const anthropic = getAnthropic();
  const userPrompt = buildUserPrompt(input);

  const resp = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 5000,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = getText(resp);
  const stripped = stripFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `improveDraft: Opus output was not valid JSON: ${(err as Error).message}\nRaw: ${stripped.slice(0, 400)}`
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('improveDraft: Opus output not an object');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o['title'] !== 'string' || !Array.isArray(o['tags']) || typeof o['description'] !== 'string') {
    throw new Error('improveDraft: Opus output missing required keys');
  }
  const tags = (o['tags'] as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim())
    .filter(Boolean);

  return {
    title: (o['title'] as string).trim(),
    tags,
    description: (o['description'] as string).trim(),
    cost_usd: IMPROVE_COST_USD,
    raw_text: stripped,
  };
}
