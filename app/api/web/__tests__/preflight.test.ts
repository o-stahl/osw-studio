import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The web proxy routes sit outside middleware's auth, so each must run the shared preflight before
 * anything else. In server mode a request with no session is refused by the route itself, before it
 * reaches out to any URL or search provider.
 */

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getSession }));

const outbound = vi.fn();

const post = (path: string, body: object) => new NextRequest(`https://studio.test${path}`, {
  method: 'POST',
  headers: { host: 'studio.test', origin: 'https://studio.test', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  outbound.mockReset();
  vi.stubGlobal('fetch', outbound);
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each([
  ['/api/web/fetch', () => import('../fetch/route'), { url: 'https://example.com/' }],
  ['/api/web/search', () => import('../search/route'), { provider: 'searxng', query: 'q', auth: { searxngUrl: 'https://searx.example.com' } }],
] as const)('%s in server mode', (path, load, body) => {
  it('refuses a caller with no session, and reaches out to nothing', async () => {
    getSession.mockResolvedValue(null);
    const { POST } = await load();
    const res = await POST(post(path, body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'authentication required' });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('lets a signed-in caller past the preflight', async () => {
    getSession.mockResolvedValue({ userId: 'u1', email: 'a@b.c', isAdmin: false, exp: 0 });
    const { POST } = await load();
    // An empty body stops at the route's own validation, after the preflight.
    expect((await POST(post(path, {}))).status).toBe(400);
  });
});
