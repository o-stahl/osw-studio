import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The ChatGPT sign-in cookies take the `__Host-` prefix wherever cookies are Secure, like the
 * session cookie, so a site on a sibling subdomain cannot plant a refresh token for the studio.
 * Plain HTTP keeps the old names; a Secure install clears the old names when it writes the new.
 */

vi.mock('server-only', () => ({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  (globalThis as { oswCodexFlows?: Map<string, unknown> }).oswCodexFlows?.clear();
});

describe('ChatGPT cookie names', () => {
  it('are prefixed exactly when cookies are Secure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const c = await import('../cookie');
    expect([c.codexCookieName(), c.codexLoginCookieName()]).toEqual(['__Host-osw_codex_rt', '__Host-osw_codex_login']);
    expect(c.legacyCodexCookieNames()).toEqual(['osw_codex_rt', 'osw_codex_login']);
    expect(c.codexCookieOptions()).toMatchObject({ secure: true, path: '/', httpOnly: true });

    vi.stubEnv('SECURE_COOKIES', 'false');
    expect([c.codexCookieName(), c.codexLoginCookieName()]).toEqual(['osw_codex_rt', 'osw_codex_login']);
    expect(c.legacyCodexCookieNames()).toEqual([]);
  });

  it('disconnecting clears both the prefixed cookies and any left under the old names', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { POST } = await import('../disconnect/route');
    const res: NextResponse = await POST();
    const cleared = res.headers.getSetCookie().map((h) => h.split('=')[0]);
    expect(cleared.sort()).toEqual(['__Host-osw_codex_login', '__Host-osw_codex_rt', 'osw_codex_login', 'osw_codex_rt']);
  });
});

describe('on a Secure install', () => {
  const tokens = (body: object) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  /** Set-Cookie lines that clear `name` (empty value, already expired). */
  const clears = (res: NextResponse, name: string) =>
    res.headers.getSetCookie().some((h) => h.startsWith(`${name}=;`) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(h));

  it('completing a sign-in stores the refresh token under the prefix and clears the old names', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('fetch', tokens({ access_token: 'a', refresh_token: 'rt-new', expires_in: 3600 }));
    const { POST, PATCH } = await import('../connect/route');
    const start = await POST(new NextRequest('https://studio.example/api/auth/codex/connect', { method: 'POST' }));
    const flow = start.cookies.get('__Host-osw_codex_login')?.value;
    const state = new URL((await start.json()).authorizationUrl).searchParams.get('state');
    const res = await PATCH(new NextRequest('https://studio.example/api/auth/codex/connect', {
      method: 'PATCH',
      headers: { cookie: `__Host-osw_codex_login=${flow}`, 'content-type': 'application/json' },
      body: JSON.stringify({ redirectUrl: `http://localhost:1455/auth/callback?code=c&state=${state}` }),
    }));
    expect(res.headers.getSetCookie().find((h) => h.startsWith('__Host-osw_codex_rt=rt-new'))).toMatch(/Secure/i);
    expect(clears(res, 'osw_codex_rt')).toBe(true);
    expect(clears(res, 'osw_codex_login')).toBe(true);
  });

  it('a rotated refresh token is stored under the prefix and the old names are cleared', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('fetch', tokens({ access_token: 'a', refresh_token: 'rt-rotated', expires_in: 3600 }));
    const { POST } = await import('../token/route');
    const res = await POST(new NextRequest('https://studio.example/api/auth/codex/token', {
      method: 'POST',
      headers: { cookie: '__Host-osw_codex_rt=rt-old' },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().find((h) => h.startsWith('__Host-osw_codex_rt=rt-rotated'))).toMatch(/Secure/i);
    expect(clears(res, 'osw_codex_rt')).toBe(true);
    expect(clears(res, 'osw_codex_login')).toBe(true);
  });

  it('status reads the prefixed refresh token, not one planted under the old name', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { GET } = await import('../status/route');
    const status = async (cookie: string) =>
      (await GET(new NextRequest('https://studio.example/api/auth/codex/status', { headers: { cookie } }))).json();
    expect(await status('__Host-osw_codex_rt=rt')).toEqual({ hasRefreshToken: true });
    expect(await status('osw_codex_rt=planted')).toEqual({ hasRefreshToken: false });
  });
});
