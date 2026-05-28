/**
 * THROWAWAY PROBE — Etsy search autocomplete via unofficial suggestions_ajax.php.
 * NOT wired into discovery. Usage: npx tsx scripts/probe-etsy-autocomplete.ts
 *
 * Verdict (2026-05-28): BLOCKED/UNRELIABLE from Railway/Node server context.
 * See TODO.md paid keyword-volume tool item — autocomplete folded there.
 */
const ENDPOINT =
  'https://www.etsy.com/suggestions_ajax.php?extras=EXTRA&version=10&search_query=';

const SEEDS = ['meal planner', 'nursery wall art', 'weekly planner'] as const;

const NODE_HEADERS = {
  'User-Agent': 'node/20.11.0',
  Accept: 'application/json',
} as const;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/javascript,*/*;q=0.1',
  Referer: 'https://www.etsy.com/',
  'X-Requested-With': 'XMLHttpRequest',
  'Accept-Language': 'en-US,en;q=0.9',
} as const;

interface SuggestionResult {
  query?: string;
}

interface SuggestionsResponse {
  results?: SuggestionResult[];
  url?: string;
}

interface ProbeRow {
  term: string;
  profile: 'node' | 'browser';
  status: number;
  server: string | null;
  blocked: boolean;
  suggestion_count: number;
  sample: string[];
  note: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function probeTerm(
  term: string,
  profile: 'node' | 'browser'
): Promise<ProbeRow> {
  const headers = profile === 'node' ? NODE_HEADERS : BROWSER_HEADERS;
  const res = await fetch(ENDPOINT + encodeURIComponent(term), { headers });
  const text = await res.text();
  const server = res.headers.get('server');

  let parsed: SuggestionsResponse | null = null;
  try {
    parsed = JSON.parse(text) as SuggestionsResponse;
  } catch {
    // non-JSON (HTML interstitial)
  }

  const captcha =
    parsed?.url?.includes('captcha-delivery') ||
    text.includes('captcha-delivery') ||
    text.includes('Please enable JS');
  const blocked = res.status === 403 || captcha;
  const queries =
    parsed?.results?.map(r => r.query).filter((q): q is string => !!q) ?? [];

  let note = '';
  if (blocked) {
    note = server === 'DataDome' ? 'DataDome bot block / captcha interstitial' : 'blocked';
  } else if (queries.length === 0) {
    note = '200 but no results[] — unexpected shape';
  } else {
    note = 'clean JSON with results[]';
  }

  return {
    term,
    profile,
    status: res.status,
    server,
    blocked,
    suggestion_count: queries.length,
    sample: queries.slice(0, 4),
    note,
  };
}

async function main(): Promise<void> {
  console.log('Etsy autocomplete probe');
  console.log('Endpoint:', ENDPOINT + '<term>');
  console.log('Official Open API v3: no autocomplete endpoint (confirmed)\n');

  const rows: ProbeRow[] = [];

  console.log('--- Profile: node (Railway/default fetch) ---');
  for (const term of SEEDS) {
    const row = await probeTerm(term, 'node');
    rows.push(row);
    console.log(JSON.stringify(row));
    await sleep(500);
  }

  console.log('\n--- Profile: browser (spoofed headers — NOT our job default) ---');
  for (const term of SEEDS) {
    const row = await probeTerm(term, 'browser');
    rows.push(row);
    console.log(JSON.stringify(row));
    await sleep(1500);
  }

  const nodeBlocked = rows.filter(r => r.profile === 'node').every(r => r.blocked);
  const browserOk = rows
    .filter(r => r.profile === 'browser')
    .every(r => !r.blocked && r.suggestion_count > 0);

  console.log('\n=== VERDICT ===');
  if (nodeBlocked) {
    console.log(
      'BLOCKED/UNRELIABLE for Railway/Node server context — default fetch gets DataDome 403/captcha.'
    );
    if (browserOk) {
      console.log(
        'Note: spoofed browser headers returned real JSON from this IP, but that is fragile (DataDome flips under burst probing), undocumented, and likely worse from datacenter IPs. Do not build a collector.'
      );
    }
    console.log('Fold into paid keyword-volume tool evaluation (eRank/Marmalead).');
  } else {
    console.log('REACHABLE — safe to build collect-etsy-autocomplete.ts');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
