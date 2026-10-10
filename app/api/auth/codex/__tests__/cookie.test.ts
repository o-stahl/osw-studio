import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

/**
 * The ChatGPT sign-in cookies take the `__Host-` prefix wherever cookies are Secure, like the
 * session cookie, so a site on a sibling subdomain cannot plant a refresh token for the studio.
 * Plain HTTP keeps the old names; a Secure install clears the old names when it writes the new.
 */

vi.mock('server-only', () => ({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
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
