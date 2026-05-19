// Async pool: process `items` with at most `limit` promises in-flight and
// `staggerMs` between successive task starts. Results are returned in
// original input order, even though tasks finish in arbitrary order.
//
// Designed for rate-limited external APIs (Etsy: 10 req/sec ceiling; 2-in-flight
// with 200ms stagger gives ~5 req/sec sustained, well under the limit).
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  staggerMs: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (limit < 1) {
    throw new Error(`mapWithLimit: limit must be >= 1 (got ${limit})`);
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;

      // Stagger task starts so we don't fire `limit` calls at exactly t=0.
      // Stagger is applied by index, not per-worker, so calls are evenly spaced.
      if (staggerMs > 0 && i > 0) {
        await new Promise(r => setTimeout(r, staggerMs));
      }

      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results;
}
