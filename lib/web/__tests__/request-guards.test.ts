import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The web proxy (`/api/web/fetch`, `/api/web/search`) sits outside middleware's auth. Its
 * same-origin check reads Origin and Host, which a non-browser client writes itself, so in server
 * mode a signed-in session is what keeps it to the instance's users.
 */

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getSession }));

const sameOrigin = (cookie?: string) => new NextRequest('https://studio.test/api/web/fetch', {
  method: 'POST',
  headers: { host: 'studio.test', origin: 'https://studio.test', ...(cookie ? { cookie } : {}) },
});

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('webRequestPreflight in server mode', () => {
  it('refuses a request with matching headers and a workspace cookie but no session', async () => {
    getSession.mockResolvedValue(null);
    const { webRequestPreflight } = await import('../request-guards');
    const pre = await webRequestPreflight(sameOrigin('osw_workspace=a'));
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.response.status).toBe(401);
  });

  it('admits a signed-in user, rate-limited per user', async () => {
    getSession.mockResolvedValue({ userId: 'u1', email: 'a@b.c', isAdmin: false, exp: 0 });
    const { webRequestPreflight } = await import('../request-guards');
    const pre = await webRequestPreflight(sameOrigin());
    expect(pre).toEqual({ ok: true, rlKey: 'user:u1' });
  });
});
