import { describe, it, expect, vi, afterEach } from 'vitest';
// The executor resolves a host before fetching it, to refuse private addresses. These tests are about
// the request, not where it goes, so every name resolves to one public address.
vi.mock('node:dns', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { default: { promises: { lookup } }, promises: { lookup } };
});

// The executor fetches through undici; send its requests to the stubbed global `fetch`.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init),
}));

import { executeFunction } from '@/lib/edge-functions/executor';

/**
 * An outbound request is bounded by the invoking function's remaining budget, not by a constant.
 *
 * The cap used to be a flat 10s while a function may run for 30s, so a slow upstream was aborted
 * well inside the budget it had been given. Model calls hit this routinely: the same question would
 * answer in 6s and abort at 10.1s on the next attempt.
 *
 * The bound is easy to reintroduce because nothing fails loudly when it is wrong. The executor's own
 * loop also gives up at the deadline, so a function with a hanging fetch ends either way. What
 * separates the two is whether the *request* was aborted, so that is what these assert rather than
 * how long `executeFunction` took.
 */

const deploymentDb = {
  query: () => [], run: () => ({}), all: () => [], exec: () => {},
  listServerFunctions: () => [],
  listSecretsWithValues: () => [],
} as never;

const request = { method: 'POST', path: '/t', headers: {}, query: {}, body: {} } as never;

const fn = (code: string, timeoutMs: number) =>
  ({ id: 'f1', name: 't', path: '/t', method: 'POST', code, timeoutMs, enabled: true }) as never;

const HANGING_FETCH = `await fetch('https://api.example.com/slow');
                       Response.json({ reached: true }, 200);`;

/** A request that never resolves on its own, so only an abort can end it. */
function stubHangingFetch() {
  const seen: { signal?: AbortSignal } = {};
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    seen.signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('an outbound request from a short-lived function', () => {
  it('is aborted when the function runs out of budget', async () => {
    const seen = stubHangingFetch();

    await executeFunction(fn(HANGING_FETCH, 400), request, deploymentDb);

    // With a flat ceiling the abort would still be ~30s away when the function gave up here.
    expect(seen.signal?.aborted).toBe(true);
  });

  it('leaves the request alone while the function still has budget', async () => {
    const seen = stubHangingFetch();

    const run = executeFunction(fn(HANGING_FETCH, 30_000), request, deploymentDb);
    await new Promise((r) => setTimeout(r, 300));

    expect(seen.signal?.aborted).toBe(false);

    // Let the run finish rather than leaving a 30s function in flight behind the suite.
    seen.signal?.dispatchEvent(new Event('abort'));
    await Promise.race([run, new Promise((r) => setTimeout(r, 2000))]);
  }, 40_000);
});
