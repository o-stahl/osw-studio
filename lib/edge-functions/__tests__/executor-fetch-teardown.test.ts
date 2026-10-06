import { describe, it, expect, afterEach, vi } from 'vitest';
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
 * Any edge function that called `fetch` used to abort the whole WASM runtime at teardown:
 *
 *   Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,1998, JS_FreeRuntime)
 *
 * The sandbox's `fetch` builds a deferred promise in QuickJS and returns that handle from a
 * `newFunction` callback, which hands ownership to the VM. The async continuation then resolved it
 * through the same handle the VM had already freed, corrupting refcounts so objects were still on
 * the GC list when the runtime was freed. The VM now gets a duplicate and the host keeps its own.
 *
 * The failure was total, not a leak that shows up under load: one fetch, one 500. So the guard is
 * simply that a function which fetches returns its response.
 */

const deploymentDb = {
  query: () => [],
  run: () => ({}),
  all: () => [],
  exec: () => {},
  listServerFunctions: () => [],
  listSecretsWithValues: () => [],
} as never;

const request = { method: 'POST', path: '/t', headers: {}, query: {}, body: {} } as never;

const fn = (code: string) =>
  ({ id: 'f1', name: 't', path: '/t', method: 'POST', code, timeoutMs: 30000, enabled: true }) as never;

afterEach(() => vi.unstubAllGlobals());

/** A fetch that resolves without touching the network, so this stays offline and deterministic. */
function stubFetch(init: { status?: number; body?: string } = {}) {
  vi.stubGlobal('fetch', async () =>
    new Response(init.body ?? '{"ok":true}', {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('a sandboxed function that fetches', () => {
  it('returns its response instead of aborting the runtime', async () => {
    stubFetch({ body: '{"answer":42}' });

    const result = await executeFunction(
      fn(`const res = await fetch('https://api.example.com/v1/thing');
          const data = await res.json();
          Response.json({ status: res.status, answer: data.answer }, 200);`),
      request,
      deploymentDb
    );

    expect(result.error).toBeUndefined();
    expect(result.response.status).toBe(200);
    expect(result.response.body).toMatchObject({ status: 200, answer: 42 });
  });

  it('survives an upstream error status, which is a normal reply to the sandbox', async () => {
    stubFetch({ status: 401, body: '{"error":"bad key"}' });

    const result = await executeFunction(
      fn(`const res = await fetch('https://api.example.com/v1/thing');
          Response.json({ ok: res.ok, status: res.status }, 200);`),
      request,
      deploymentDb
    );

    expect(result.error).toBeUndefined();
    expect(result.response.body).toMatchObject({ ok: false, status: 401 });
  });

  it('survives a rejected fetch, where the promise is rejected rather than resolved', async () => {
    // The reject path uses the same handle as the resolve path, so it could leak the same way.
    vi.stubGlobal('fetch', async () => { throw new Error('connection refused'); });

    const result = await executeFunction(
      fn(`try { await fetch('https://api.example.com/v1/thing'); Response.json({ reached: true }, 200); }
          catch (e) { Response.json({ caught: true }, 200); }`),
      request,
      deploymentDb
    );

    expect(result.error).toBeUndefined();
    expect(result.response.body).toMatchObject({ caught: true });
  });

  it('still runs two fetches in one invocation', async () => {
    stubFetch({ body: '{"n":1}' });

    const result = await executeFunction(
      fn(`const a = await fetch('https://api.example.com/a');
          const b = await fetch('https://api.example.com/b');
          Response.json({ both: a.status + b.status }, 200);`),
      request,
      deploymentDb
    );

    expect(result.error).toBeUndefined();
    expect(result.response.body).toMatchObject({ both: 400 });
  });
});
