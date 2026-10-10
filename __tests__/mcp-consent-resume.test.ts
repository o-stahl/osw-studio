import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Carrying an MCP authorization request across an external login.
 *
 * On a hosted instance the consent screen cannot hand `/admin/login` a `next`: middleware sends that
 * path on to the gateway, whose login takes no destination and whose handoff names the dashboard. So
 * the request is held in a cookie on the instance's own origin and spent by middleware on the way
 * back in. These pin both halves, and the validation that stops the held value from aiming that
 * redirect anywhere else.
 */

vi.mock('server-only', () => ({}));

const AUTH_QUERY =
  'client_id=abc-123&response_type=code&code_challenge=xyz&code_challenge_method=S256&state=s1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the held value', () => {
  it('accepts the query a client actually sends', async () => {
    const { pendingAuthorizationIsWellFormed } = await import('@/lib/mcp/pending');
    expect(pendingAuthorizationIsWellFormed(AUTH_QUERY)).toBe(true);
  });

  it('refuses what is not an authorization request, or is too big to hold', async () => {
    const { pendingAuthorizationIsWellFormed } = await import('@/lib/mcp/pending');

    expect(pendingAuthorizationIsWellFormed('')).toBe(false);
    // No client_id: not an authorization request, so nothing worth holding.
    expect(pendingAuthorizationIsWellFormed('state=s1&response_type=code')).toBe(false);
    expect(pendingAuthorizationIsWellFormed('client_id=' + 'x'.repeat(4096))).toBe(false);
    // Control characters travel through a cookie and a redirect header.
    expect(pendingAuthorizationIsWellFormed('client_id=x\nLocation: evil')).toBe(false);
    expect(pendingAuthorizationIsWellFormed('client_id=x\u0000y')).toBe(false);
  });

  it('accepts a client that does not encode its redirect_uri', async () => {
    const { pendingAuthorizationIsWellFormed } = await import('@/lib/mcp/pending');

    // Refusing these looked safer and only broke the sign-in round trip for such a client: the
    // value cannot steer the redirect, so there is nothing to refuse it for.
    expect(pendingAuthorizationIsWellFormed('client_id=x&redirect_uri=https://claude.ai/cb')).toBe(true);
    expect(pendingAuthorizationIsWellFormed('client_id=x&state=a#b')).toBe(true);
  });
});

describe('middleware resuming a held authorization', () => {
  async function run(opts: { pending?: string; signedIn: boolean; path?: string; method?: string }) {
    const { middleware } = await import('@/middleware');
    const { NextRequest } = await import('next/server');
    const { createSession, sessionCookieName } = await import('@/lib/auth/session');
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();

    const req = new NextRequest(`https://inst-1.oswstudio.com${opts.path ?? '/w/ws-1/dashboard'}`, {
      method: opts.method ?? 'GET',
    });
    if (opts.pending !== undefined) req.cookies.set(PENDING_MCP_COOKIE, opts.pending);
    if (opts.signedIn) {
      req.cookies.set(sessionCookieName(), await createSession('user-1', 'u@a.test', false));
    }
    return middleware(req);
  }

  it('sends a signed-in visitor back to consent with the request intact', async () => {
    const res = await run({ pending: AUTH_QUERY, signedIn: true });
    const location = res.headers.get('location')!;

    expect(location).toContain('/mcp/authorize');
    const url = new URL(location);
    expect(url.searchParams.get('client_id')).toBe('abc-123');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('code_challenge')).toBe('xyz');
    expect(url.searchParams.get('redirect_uri')).toBe('https://claude.ai/api/mcp/auth_callback');
  });

  it('spends the cookie, so it does not redirect every later page view', async () => {
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();
    const res = await run({ pending: AUTH_QUERY, signedIn: true });

    // Explicitly deleted, not merely absent: an absent cookie on the response would leave the
    // browser's copy in place and redirect every page view until it expired.
    // Cleared with Max-Age=0 and the cookie's own attributes, which a `__Host-` cookie requires.
    const cleared = res.cookies.get(PENDING_MCP_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');
    expect(cleared!.maxAge === 0 || new Date(cleared!.expires!).getTime() < Date.now()).toBe(true);
  });

  it('leaves a signed-out visitor to the login they were already being sent to', async () => {
    const res = await run({ pending: AUTH_QUERY, signedIn: false });
    expect(res.headers.get('location') ?? '').not.toContain('/mcp/authorize');
  });

  it('does not touch the consent screen itself, which would loop', async () => {
    const res = await run({ pending: AUTH_QUERY, signedIn: true, path: '/mcp/authorize' });
    expect(res.headers.get('location')).toBeNull();
  });

  it('does not hijack an API call', async () => {
    const res = await run({ pending: AUTH_QUERY, signedIn: true, path: '/api/auth/me' });
    expect(res.headers.get('location') ?? '').not.toContain('/mcp/authorize');
  });

  it('drops a held value that fails validation instead of redirecting to it', async () => {
    const { pendingMcpCookieName } = await import('@/lib/mcp/pending');
    const PENDING_MCP_COOKIE = pendingMcpCookieName();
    const res = await run({ pending: 'no-client-id-here=1', signedIn: true });

    expect(res.headers.get('location') ?? '').not.toContain('/mcp/authorize');
    const cleared = res.cookies.get(PENDING_MCP_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');
  });

  it('lands on the consent screen even when the held value looks like a path', async () => {
    // What keeps the redirect safe is that the value is assigned to `URL.search`, which reaches
    // neither the path nor the host. This is the assertion the validation rules used to stand in for.
    const res = await run({ pending: 'client_id=x&r=//evil.com/cb', signedIn: true });
    const url = new URL(res.headers.get('location')!);

    expect(url.host).toBe('inst-1.oswstudio.com');
    expect(url.pathname).toBe('/mcp/authorize');
  });

  it('stays out of the way when nothing is held', async () => {
    const res = await run({ signedIn: true });
    expect(res.headers.get('location') ?? '').not.toContain('/mcp/authorize');
  });
});
