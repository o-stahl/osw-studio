import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * The session cookie carries the `__Host-` prefix wherever cookies are Secure. The browser then
 * accepts it only from the studio's exact host, with `Path=/` and no `Domain`, so a published site
 * on a subdomain of the same domain cannot plant a session for the studio (cookie tossing). Plain
 * HTTP cannot carry the prefix, so those installs keep the old name.
 */

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
});
afterEach(() => vi.unstubAllEnvs());

describe('sessionCookieName', () => {
  it('is __Host- prefixed exactly when cookies are Secure', async () => {
    const session = await import('../session');
    vi.stubEnv('NODE_ENV', 'production');
    expect([session.secureCookies(), session.sessionCookieName()]).toEqual([true, '__Host-osw_session']);
    vi.stubEnv('SECURE_COOKIES', 'false');
    expect([session.secureCookies(), session.sessionCookieName()]).toEqual([false, 'osw_session']);
    vi.stubEnv('SECURE_COOKIES', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect([session.secureCookies(), session.sessionCookieName()]).toEqual([false, 'osw_session']);
  });
});

describe('setSessionOnResponse', () => {
  it('sets a cookie the browser will accept under the prefix, and clears the old one', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { setSessionOnResponse } = await import('../session');
    const response = NextResponse.json({});
    setSessionOnResponse(response, 'tok');
    const headers = response.headers.getSetCookie();
    const session = headers.find(h => h.startsWith('__Host-osw_session=tok'))!;
    expect(session).toMatch(/Path=\//i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).not.toMatch(/Domain=/i);
    expect(headers.some(h => /^osw_session=;/.test(h) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(h))).toBe(true);
  });

  it('sets the plain name on plain HTTP and clears nothing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SECURE_COOKIES', 'false');
    const { setSessionOnResponse } = await import('../session');
    const response = NextResponse.json({});
    setSessionOnResponse(response, 'tok');
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^osw_session=tok/)]);
  });
});

describe('middleware with Secure cookies', () => {
  async function call(cookieName: string) {
    const { createSession } = await import('../session');
    const { middleware } = await import('@/middleware');
    const req = new NextRequest('https://inst-1.oswstudio.com/api/w/ws-1/deployments', { headers: { host: 'inst-1.oswstudio.com' } });
    req.cookies.set(cookieName, await createSession('user-1', 'u@a.test', false));
    return middleware(req);
  }

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.oswstudio.com');
  });

  it('accepts the prefixed session', async () => {
    expect((await call('__Host-osw_session')).status).toBe(200);
  });

  it('no longer accepts a session under the old name, which a sibling subdomain could have set', async () => {
    expect((await call('osw_session')).status).toBe(401);
  });
});
