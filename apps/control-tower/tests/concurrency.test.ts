import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, fetchWithRetry } from '../src/engine/concurrency.ts';

describe('mapLimit', () => {
  it('preserves input order despite out-of-order completion', async () => {
    const input = [10, 30, 5, 20, 1];
    const out = await mapLimit(input, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    assert.deepEqual(out, [20, 60, 10, 40, 2]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
  });
});

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : 'body', { status, headers });
}

describe('fetchWithRetry (429 backoff, architecture §3.1)', () => {
  it('retries on 429 then returns the eventual success', async () => {
    const statuses = [429, 429, 200];
    let calls = 0;
    const out = await fetchWithRetry(
      'http://x',
      {},
      {
        sleep: async () => {},
        fetchImpl: (async () => res(statuses[calls++]!)) as unknown as typeof fetch,
      },
    );
    assert.equal(out.status, 200);
    assert.equal(calls, 3);
  });

  it('honours Retry-After (seconds) for the delay', async () => {
    const delays: number[] = [];
    let calls = 0;
    await fetchWithRetry(
      'http://x',
      {},
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        fetchImpl: (async () => (calls++ === 0 ? res(429, { 'retry-after': '2' }) : res(200))) as unknown as typeof fetch,
      },
    );
    assert.deepEqual(delays, [2000]);
  });

  it('gives up after maxRetries and returns the last 429', async () => {
    let calls = 0;
    const out = await fetchWithRetry(
      'http://x',
      {},
      {
        maxRetries: 2,
        sleep: async () => {},
        fetchImpl: (async () => {
          calls++;
          return res(429);
        }) as unknown as typeof fetch,
      },
    );
    assert.equal(out.status, 429);
    assert.equal(calls, 3); // initial + 2 retries
  });
});
