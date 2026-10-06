import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The connection is what is checked, not only the name.
 *
 * A name can answer one address to the check and another to the connection (a short-TTL record
 * flipping between a public and a private address). These run the real undici client with a resolver
 * that does exactly that, so the refusal has to come from the connect-time lookup.
 */

const dnsAnswers = vi.hoisted(() => ({
  /** What the up-front check (`dns.promises.lookup`) sees. */
  check: {} as Record<string, string>,
  /** What the connection (`dns.lookup`) sees. */
  connect: {} as Record<string, string>,
}));

vi.mock('node:dns', () => {
  const answer = (table: Record<string, string>, host: string) => {
    const address = table[host];
    if (!address) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };
  const promises = { lookup: async (host: string) => answer(dnsAnswers.check, host) };
  const lookup = (host: string, _opts: unknown, cb: (err: Error | null, list?: unknown) => void) => {
    try {
      cb(null, answer(dnsAnswers.connect, host));
    } catch (error) {
      cb(error as Error);
    }
  };
  return { default: { promises, lookup }, promises, lookup };
});

const network = vi.hoisted(() => ({
  stub: null as null | ((url: string, init: RequestInit) => Promise<Response>),
}));

vi.mock('undici', async (importOriginal) => {
  const real = await importOriginal<typeof import('undici')>();
  return {
    ...real,
    fetch: (url: string, init: RequestInit) => (network.stub ? network.stub(url, init) : real.fetch(url, init as never)),
  };
});

import { publicFetch, publicLookup } from '../public-fetch';

beforeEach(() => {
  network.stub = null;
  dnsAnswers.check = {};
  dnsAnswers.connect = {};
  delete process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH;
});

afterEach(() => {
  delete process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH;
});

describe('the address a function connects to', () => {
  it('is refused when the name answers privately at connect time after a public check', async () => {
    dnsAnswers.check['flip.example.com'] = '93.184.216.34';
    dnsAnswers.connect['flip.example.com'] = '127.0.0.1';
    await expect(publicFetch('http://flip.example.com/', {})).rejects.toThrow(/private\/internal/);
  });

  it('is refused by the connect-time lookup on its own', async () => {
    dnsAnswers.connect['meta.example.com'] = '169.254.169.254';
    const result = await new Promise<{ err: Error | null }>((resolve) =>
      publicLookup('meta.example.com', {}, (err) => resolve({ err })),
    );
    expect(result.err?.message).toMatch(/private\/internal/);
  });

  it('passes a lookup failure through rather than an empty answer', async () => {
    const result = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) =>
      publicLookup('missing.example.com', {}, (err) => resolve({ err })),
    );
    expect(result.err?.code).toBe('ENOTFOUND');
  });

  it('passes a public answer through in the shape asked for', async () => {
    dnsAnswers.connect['api.example.com'] = '93.184.216.34';
    const single = await new Promise<unknown[]>((resolve) =>
      publicLookup('api.example.com', {}, (_err, address, family) => resolve([address, family])),
    );
    expect(single).toEqual(['93.184.216.34', 4]);
    const all = await new Promise<unknown>((resolve) =>
      publicLookup('api.example.com', { all: true }, (_err, address) => resolve(address)),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('redirects', () => {
  type Hop = { status: number; location?: string };
  function stubHops(routes: Record<string, Hop>) {
    const sent: Array<{ url: string; method?: string; headers: Record<string, string>; body?: unknown }> = [];
    network.stub = async (url, init) => {
      sent.push({ url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body });
      const hop = routes[url] ?? { status: 200 };
      return new Response(hop.status === 200 ? 'ok' : null, {
        status: hop.status,
        headers: hop.location ? { location: hop.location } : undefined,
      });
    };
    return sent;
  }

  beforeEach(() => {
    dnsAnswers.check = { 'api.example.com': '93.184.216.34', 'other.example.com': '93.184.216.35' };
  });

  it('returns a 300 or 304 with a location instead of following it', async () => {
    for (const status of [300, 304]) {
      const sent = stubHops({ 'https://api.example.com/a': { status, location: 'https://api.example.com/b' } });
      const { response } = await publicFetch('https://api.example.com/a', {});
      expect(response.status).toBe(status);
      expect(sent.map((s) => s.url)).toEqual(['https://api.example.com/a']);
    }
  });

  it('drops the body and its headers when a 303 turns the request into a GET', async () => {
    const sent = stubHops({ 'https://api.example.com/form': { status: 303, location: '/done' } });
    await publicFetch('https://api.example.com/form', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 't' },
    });
    expect(sent[1]).toMatchObject({ url: 'https://api.example.com/done', method: 'GET', body: undefined });
    expect(sent[1].headers['content-type']).toBeUndefined();
    expect(sent[1].headers['x-trace']).toBe('t');
  });

  it('keeps the method and body through a 307', async () => {
    const sent = stubHops({ 'https://api.example.com/form': { status: 307, location: '/again' } });
    await publicFetch('https://api.example.com/form', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect(sent[1]).toMatchObject({ method: 'POST', body: 'x' });
    expect(sent[1].headers['content-type']).toBe('text/plain');
  });

  it('keeps the method and body of a PUT or DELETE through a 301 or 302', async () => {
    for (const method of ['PUT', 'DELETE']) {
      for (const status of [301, 302]) {
        const sent = stubHops({ 'https://api.example.com/item': { status, location: '/item2' } });
        await publicFetch('https://api.example.com/item', { method, body: 'x', headers: { 'Content-Type': 'text/plain' } });
        expect(sent[1]).toMatchObject({ url: 'https://api.example.com/item2', method, body: 'x' });
        expect(sent[1].headers['content-type']).toBe('text/plain');
      }
    }
  });

  it('drops credentials when a redirect moves from https to http on the same host', async () => {
    const sent = stubHops({ 'https://api.example.com/a': { status: 302, location: 'http://api.example.com/b' } });
    await publicFetch('https://api.example.com/a', {
      headers: { Authorization: 'Bearer k', Cookie: 'c=1', 'X-Trace': 't' },
    });
    expect(sent[1].url).toBe('http://api.example.com/b');
    expect(sent[1].headers.authorization).toBeUndefined();
    expect(sent[1].headers.cookie).toBeUndefined();
    expect(sent[1].headers['x-trace']).toBe('t');
  });

  it('refuses a redirect to another scheme, even with private fetches allowed', async () => {
    process.env.FUNCTIONS_ALLOW_PRIVATE_FETCH = 'true';
    stubHops({ 'https://api.example.com/a': { status: 302, location: 'file:///etc/passwd' } });
    await expect(publicFetch('https://api.example.com/a', {})).rejects.toThrow(/http and https/);
  });

  it('counts every hop after the first against the request limit', async () => {
    stubHops({
      'https://api.example.com/1': { status: 302, location: 'https://other.example.com/2' },
      'https://other.example.com/2': { status: 302, location: 'https://api.example.com/3' },
    });
    const count = vi.fn();
    await publicFetch('https://api.example.com/1', {}, count);
    expect(count).toHaveBeenCalledTimes(2);

    const limit = () => { throw new Error('Maximum fetch requests (10) exceeded'); };
    await expect(publicFetch('https://api.example.com/1', {}, limit)).rejects.toThrow(/Maximum fetch requests/);
  });
});
