# Brain — Autonomous E-Commerce Orchestrator

The brain of an autonomous Etsy + multi-marketplace store. Continuously scans
for opportunities, generates products, manages listings, handles customer
service, and surfaces strategic decisions for your review.

## Day 1: Supabase schema ✅

Run `supabase/migrations/0001_init.sql` and `0002_rls.sql` in your Supabase
SQL Editor.

## Day 2: First signal collector running locally

This step sets up the TypeScript project and runs the first signal collector
(Google Trends). You'll see real data populate the `signals` table.

### Prerequisites

- Node.js 20 or newer. Check with `node --version`. If you don't have it,
  download from nodejs.org or use a version manager like nvm.

### Steps

1. **Drop these files into a folder.** Recommended: somewhere you can find
   it like `~/code/brain` or `~/Documents/brain`. Open a terminal in that
   folder.

2. **Install dependencies:**
   ```
   npm install
   ```
   Takes 30-60 seconds. Creates `node_modules/`.

3. **Set up your credentials.** Copy the env template and fill in your
   Supabase values:
   ```
   cp .env.example .env.local
   ```
   Open `.env.local` in any editor. Fill in:
   - `SUPABASE_URL` — from Supabase dashboard > Project Settings > API
   - `SUPABASE_SERVICE_ROLE_KEY` — same place, the secret one

   Save the file. It's gitignored, won't get committed.

4. **Run the collector:**
   ```
   npm run collect:trends
   ```

   You should see output like:
   ```
   [info] [intel] gtrends.start: Google Trends scan starting: 10 seed keywords
     ok   "printable wall art": interest=47.3 velocity=12.4% related=5
     ok   "digital planner": interest=68.1 velocity=-3.2% related=4
     ...
   [success] [intel] gtrends.complete: Google Trends scan done: 10 succeeded, 0 skipped in 28s
   ```

   The whole run takes about 30 seconds (it's deliberately polite to Google's
   endpoint — 2 sec between keywords).

### Verify it worked

Open Supabase dashboard > Table Editor > `signals` table. You should see
roughly 20-30 new rows: each keyword wrote an `interest_score` row, a
`velocity` row, and sometimes a `rising_related_count` row (with the actual
related queries stored in the metadata jsonb column).

Also check the `activity` table — two new rows: `gtrends.start` and
`gtrends.complete`.

### If something failed

- "Missing SUPABASE_URL" — your `.env.local` isn't set up. See step 3.
- "no data returned" on some keywords — Google rate-limited or refused;
  re-run, it'll usually work the second time.
- "fetch failed" on every keyword — your network is blocking Google Trends;
  rare on residential connections. We'll address this on Railway later if
  it crops up there (may need a proxy).

Paste any persistent error and I'll debug.

### What you just built

A working signal collector that pulls real Google Trends data and persists
it into structured rows the scoring engine will later consume. The pattern
(`safeParse`, `log()`, batched inserts, polite rate limiting) is the same
one we'll reuse for every other source — Reddit, Pinterest, eRank, TikTok.

### Reply with

"trends running" once you see signals in your table, and we move to Day 3:
Reddit + eRank collectors, deployment to Railway with a cron schedule, and
the scoring engine that synthesizes signals into ranked opportunities.

---

## Project layout so far

```
brain/
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example          ← copy to .env.local, fill in
├── README.md
├── supabase/
│   └── migrations/
│       ├── 0001_init.sql ← creates 8 tables
│       └── 0002_rls.sql  ← enables RLS + read policies
└── src/
    ├── types/
    │   └── google-trends-api.d.ts
    ├── lib/
    │   ├── supabase.ts   ← Supabase client (service_role)
    │   └── log.ts        ← activity logger
    └── jobs/
        └── collect-google-trends.ts ← first signal collector
```
