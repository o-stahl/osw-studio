import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Where a function's `fetch` may go.
 *
 * Function code is written by whoever can edit a project and runs on the server, next to the app's own
 * port, the Caddy admin API and the cloud metadata address. A refusal has to hold for the address a
 * name resolves to, not the name, and for every hop of a redirect, not only the first URL.
 */

const DNS: Record<string, string[]> = {
  'api.example.com': ['93.184.216.34'],
  'other.example.com': ['93.184.216.35'],
  'private-a.example.com': ['127.0.0.1'],
  'mixed.example.com': ['93.184.216.36', '10.0.0.5'],
};

vi.mock('node:dns', () => {
  const lookup = async (host: string) => {
    const addresses = DNS[host];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { default: { promises: { lookup } }, promises: { lookup } };
});

// The executor fetches through undici; send its requests to the stubbed global `fetch`.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init),
}));

import { executeFunction } from '@/lib/edge-functions/executor';
import { MAX_FETCH_REDIRECTS } from '@/lib/edge-functions/public-fetch';

const deploymentDb = {
  query: () => [], run: () => ({}), all: () => [], exec: () => {},
  listServerFunctions: () => [],
  listSecretsWithValues: () => [],
} as never;

const request = { method: 'GET', path: '/t', headers: {}, query: {}, body: null } as never;

/** Run a function that fetches `url` and reports what came back, or the error it got. */
async function fetchFrom(url: string) {
  const code = `
    let out;
    try {
      const r = await fetch(${JSON.stringify(url)});
      out = { status: r.status, body: r.text(), url: r.url };
    } catch (e) {
      out = { error: String(e && e.message ? e.message : e) };
    }
    Response.json(out, 200);`;
  const fn = { id: 'f1', name: 't', path: '/t', method: 'GET', code, timeoutMs: 5000, enabled: true } as never;
  const result = await executeFunction(fn, request, deploymentDb);
  return result.response.body as { status?: number; body?: string; url?: string; error?: string };
}

type Hop = { status: number; location?: string; body?: string };

/** The network: each URL answers with its hop, and every URL the executor reaches is recorded. */
function stubNetwork(routes: Record<string, Hop>) {
  const reached: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    reached.push(url);
    const hop = routes[url] ?? { status: 200, body: 'ok' };
    if (hop.location && init?.redirect !== 'manual') {
      // A fetch left to follow redirects would go there without asking.
      reached.push(hop.location);
      return new Response(routes[hop.location]?.body ?? 'followed', { status: 200 });
    }
    const headers = hop.location ? { location: hop.location } : undefined;
    return new Response(hop.body ?? '', { status: hop.status, headers });
  });
  return reached;
}

beforeEach(() => {
  delete process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH;
});

describe('a function fetching a private address', () => {
  it.each([
    'http://[::1]/',
    'http://0.0.0.0/',
    'http://127.0.0.2/',
    'http://100.64.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:3000/api/auth/me',
    'http://private-a.example.com/',
    'http://mixed.example.com/',
  ])('is refused for %s', async (url) => {
    const reached = stubNetwork({});
    const out = await fetchFrom(url);
    expect(out.error).toMatch(/private|internal/i);
    expect(reached).toEqual([]);
  });

  it('is refused when a public address redirects there', async () => {
    const reached = stubNetwork({
      'https://api.example.com/go': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const out = await fetchFrom('https://api.example.com/go');
    expect(out.error).toMatch(/private|internal/i);
    expect(reached).toEqual(['https://api.example.com/go']);
  });

  it('is allowed only behind the opt-in', async () => {
    process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH = 'true';
    const reached = stubNetwork({ 'http://127.0.0.1:8080/': { status: 200, body: 'local' } });
    const out = await fetchFrom('http://127.0.0.1:8080/');
    expect(out).toMatchObject({ status: 200, body: 'local' });
    expect(reached).toEqual(['http://127.0.0.1:8080/']);
  });
});

describe('a function fetching a public address', () => {
  it('gets the response', async () => {
    const reached = stubNetwork({ 'https://api.example.com/data': { status: 200, body: 'hello' } });
    expect(await fetchFrom('https://api.example.com/data')).toMatchObject({ status: 200, body: 'hello' });
    expect(reached).toEqual(['https://api.example.com/data']);
  });

  it('follows a redirect to another public address and reports where it ended', async () => {
    stubNetwork({
      'https://api.example.com/old': { status: 301, location: 'https://other.example.com/new' },
      'https://other.example.com/new': { status: 200, body: 'moved' },
    });
    expect(await fetchFrom('https://api.example.com/old')).toMatchObject({
      status: 200, body: 'moved', url: 'https://other.example.com/new',
    });
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    const sent: Record<string, Record<string, string>> = {};
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      sent[input] = Object.fromEntries(new Headers(init?.headers).entries());
      if (input === 'https://api.example.com/a') return new Response('', { status: 302, headers: { location: '/b' } });
      if (input === 'https://api.example.com/b') return new Response('', { status: 302, headers: { location: 'https://other.example.com/c' } });
      return new Response('done', { status: 200 });
    });
    const code = `
      const r = await fetch('https://api.example.com/a', { headers: { Authorization: 'Bearer k', 'X-Trace': 't' } });
      Response.json({ body: r.text() }, 200);`;
    const fn = { id: 'f1', name: 't', path: '/t', method: 'GET', code, timeoutMs: 5000, enabled: true } as never;
    const result = await executeFunction(fn, request, deploymentDb);
    expect(result.response.body).toEqual({ body: 'done' });
    expect(sent['https://api.example.com/b'].authorization).toBe('Bearer k');
    expect(sent['https://other.example.com/c'].authorization).toBeUndefined();
    expect(sent['https://other.example.com/c']['x-trace']).toBe('t');
  });

  it('gives up on a redirect loop', async () => {
    const reached = stubNetwork({
      'https://api.example.com/a': { status: 302, location: 'https://api.example.com/b' },
      'https://api.example.com/b': { status: 302, location: 'https://api.example.com/a' },
    });
    const out = await fetchFrom('https://api.example.com/a');
    expect(out.error).toMatch(/redirect/i);
    // The first request and one per redirect followed, then it stops.
    expect(reached).toHaveLength(MAX_FETCH_REDIRECTS + 1);
  });
});

describe('the request limit', () => {
  /** Run a function that fetches each URL in turn, reporting each status or error. */
  async function fetchAll(urls: string[]) {
    const code = `
      const out = [];
      for (const u of ${JSON.stringify(urls)}) {
        try { const r = await fetch(u); out.push(r.status); }
        catch (e) { out.push(String(e && e.message ? e.message : e)); }
      }
      Response.json(out, 200);`;
    const fn = { id: 'f1', name: 't', path: '/t', method: 'GET', code, timeoutMs: 5000, enabled: true } as never;
    const result = await executeFunction(fn, request, deploymentDb);
    return result.response.body as Array<number | string>;
  }

  const hops = {
    'https://api.example.com/hop': { status: 302, location: 'https://api.example.com/end' },
    'https://api.example.com/end': { status: 200, body: 'end' },
  };

  it('refuses a redirect hop once the limit is reached', async () => {
    const reached = stubNetwork(hops);
    const out = await fetchAll([...Array(9).fill('https://api.example.com/plain'), 'https://api.example.com/hop']);
    expect(out.slice(0, 9)).toEqual(Array(9).fill(200));
    expect(out[9]).toMatch(/Maximum fetch requests \(10\) exceeded/);
    expect(reached).not.toContain('https://api.example.com/end');
  });

  it('counts a redirect hop as a request', async () => {
    stubNetwork(hops);
    // One fetch that redirects once is two requests, so only eight more fit under ten.
    const out = await fetchAll(['https://api.example.com/hop', ...Array(9).fill('https://api.example.com/plain')]);
    expect(out.slice(0, 9)).toEqual(Array(9).fill(200));
    expect(out[9]).toMatch(/Maximum fetch requests \(10\) exceeded/);
  });
});
