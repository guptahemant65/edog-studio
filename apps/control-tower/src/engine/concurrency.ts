/**
 * Bounded-concurrency + retry helpers for the ADO data engine (architecture §3.1).
 */

/**
 * Map over items with at most `limit` concurrent calls to `fn`, preserving
 * input order in the result array. Used to cap concurrent ADO requests.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch with exponential backoff on HTTP 429, honouring `Retry-After` when present
 * (architecture §3.1, mitigation 3). Non-429 responses are returned as-is — the
 * caller decides how to treat other status codes.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let attempt = 0;
  while (true) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const retryAfterSec = Number(res.headers.get('retry-after'));
    const delay =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : baseDelayMs * 2 ** attempt;
    await sleep(delay);
    attempt++;
  }
}
