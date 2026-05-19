# Brain — Architecture Principles

> Living document. The "what" lives in TODO.md. The "why" and "how" live here.

## What We're Building

An autonomous end-to-end e-commerce automation system that discovers digital product opportunities, researches them, designs and creates the products, publishes them to Etsy (Shopify later), handles customer service, and continuously optimizes itself. The human operator (Jason) oversees strategically and intervenes only on escalations.

## Why

Test the viability of an AI-operated commerce business. Target: $1k/month profit, ad-free. Validation milestones in order: first sale → break-even (~40–60 sales/mo) → net profit. Each milestone proves something specific.

## Core Architectural Principles

1. **Closed-loop, not pipeline.** Agents collaborate as a learning system. Information flows back from downstream (sales, reviews, customer messages) to upstream (discovery, research, design). The system improves itself through feedback loops, not just by being executed.

2. **Human as overseer, not operator.** The system runs autonomously within defined limits. Escalates to human for: new product categories, listings priced over $75, refund disputes, ad spend decisions, low-confidence calls, and strategic pattern shifts.

3. **Agents are tunable without code changes.** System prompts, decision thresholds, scoring weights, and behavioral parameters live in `agent_config`. They can be updated by the orchestrator or eventually by agents themselves based on observed outcomes.

4. **Shared memory is first-class.** `niche_memory` accumulates learnings across runs. Every agent reads relevant memory before acting and writes new learnings back. Decisions are never made in a vacuum after the first run.

5. **All work is auditable.** Every agent run logs to `agent_runs` with cost, confidence, assumptions, model, time, and outcome. Every brief, listing, and decision is traceable to its inputs and reasoning. No black boxes.

6. **Best tool for the job.** Not the cheapest. Opus 4.7 for high-judgment synthesis. Haiku 4.5 for routine classification. Paid APIs (SerpApi, eRank) over fragile scraping. Pay for quality where it compounds across downstream agents.

7. **Build, validate, automate.** New agents start as manual scripts. Validate output quality. Then schedule via cron. Then connect to feedback loops. Don't automate before correctness.

8. **No silent failures.** The activity logger escalates with `[ACTIVITY_LOG_FAILED]`. Cost tracking captures every spend in `cost_log`. Status fields enforce coordination. Errors are loud, traceable, and recoverable.

## System Map

### Agents

| Agent | Status | Purpose |
|---|---|---|
| Discovery | Built | Collect signals (Reddit, Google Trends) → score opportunities |
| Research | Next | Take a decision → produce structured product brief |
| Design | Future | Brief → product files (PDFs, SVGs, etc.) |
| Listing | Future | Brief + product → Etsy listing (title, description, tags, photos) |
| Customer Service | Future | Customer messages → drafted responses, escalations |
| Optimization | Future | Sales data → tune scoring weights, prompts, prices, designs |
| Orchestrator | Future | Cadence, coordination, escalation routing |

### Data Layer

- `signals` — raw signals from collectors (Reddit posts, Google Trends keywords)
- `opportunities` — scored opportunities derived from signals
- `decisions_needed` — opportunities surfaced for human or agent action (canonical state in `status` field)
- `product_briefs` — structured briefs produced by the research agent
- `listings` — Etsy/Shopify listings created by the listing agent
- `niche_memory` — accumulated learnings per niche (supports both hypothesis-driven and key-value patterns)
- `agent_config` — tunable parameters per agent
- `agent_runs` — every agent execution, structured for analytics
- `activity` — chronological event log
- `cost_log` — every spend across the system
- `system_state` — global system state (caps, flags, mode)

## Autonomy Rules

**Can act autonomously:**
- Run discovery and scoring on schedule
- Generate research briefs for surfaced decisions
- Create listings priced under $75
- Adjust listing prices within ±20%
- Draft routine customer service replies
- Run A/B tests within defined parameters

**Escalates to human:**
- New product categories never tried before
- Listings priced over $75
- Refund disputes
- Ad spend decisions
- Decisions with confidence below configured threshold
- Detected pattern shifts (engagement/conversion drops, niche saturation)

**Flags for strategic review:**
- New tooling opportunities
- Persistent low-conversion across multiple products
- Major external changes (Etsy policy, market shifts)

## Tech Stack

- **Data:** Supabase (Postgres, RLS)
- **Compute:** Railway (Node.js, cron, env management)
- **Frontend:** Vercel (dashboard, when built)
- **Source:** GitHub (auto-deploy to Railway)
- **AI:** Anthropic Claude (Opus 4.7 for synthesis, Haiku 4.5 for classification, Sonnet 4.6 for routine work)
- **Search/Intel:** SerpApi (Google Trends, Etsy, Reddit)
- **Design (planned):** Recraft (vectors), Ideogram (typography), Flux (illustrations)
- **Storefront:** Etsy API (Shopify later)
- **Dev workflow:** Cursor IDE with MCP integrations for Supabase, Railway, Vercel

## How We Use This Document

- Claude reads this at the start of every conversation/session before doing anything else
- Before writing any architectural Cursor prompt, the proposal is checked against these principles
- When a principle-level decision is made, this document is updated immediately
- TODO.md tracks tactical work. PRINCIPLES.md tracks architecture. They reinforce each other.
