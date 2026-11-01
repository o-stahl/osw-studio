import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The API answers only the studio's own pages. Routes authenticate with the session cookie, which the
 * browser attaches to a cross-site form and to any request from a same-site page (a published site on
 * a sibling subdomain), and which project code running on the studio's origin would send as the user.
 * So without this a page on any site could publish, add members or hand out a ChatGPT token in the
 * name of a signed-in user, and project code could read their workspace. Routes that other pages
 * reach by design are exempt, and a request with neither Sec-Fetch-Site nor Origin passes: a server or
 * CLI client, or a same-origin read over plain HTTP.
 */

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
});

afterEach(() => vi.unstubAllEnvs());

const HOST = 'inst-1.oswstudio.com';

async function call(path: string, opts: { method?: string; origin?: string | null; host?: string; headers?: Record<string, string> } = {}) {
  const { NextRequest } = await import('next/server');
  const { createSession, sessionCookieName } = await import('@/lib/auth/session');
  const { middleware } = await import('@/middleware');
  const host = opts.host ?? HOST;
  const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? `https://${host}`;
  const req = new NextRequest(`https://${host}${path}`, { method: opts.method ?? 'POST', headers });
  req.cookies.set(sessionCookieName(), await createSession('user-1', 'u@a.test', false));
  return middleware(req);
}

const refused = (res: Response) => res.status === 403;

describe('a write from another site', () => {
  it.each([
    '/api/w/ws-1/deployments/d1/publish',
    '/api/admin/users',
    '/api/auth/codex/token',
    '/api/server-generate/start',
    '/api/mcp/oauth/authorize',
    '/api/mcp/grants',
    '/api/analytics/d1/clear',
    '/api/generate',
  ])('is refused for %s', async (path) => {
    expect(refused(await call(path, { origin: 'https://evil.example' }))).toBe(true);
  });

  it('is refused for every write method, and for an opaque origin', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(refused(await call('/api/w/ws-1/projects/p1', { method, origin: 'https://evil.example' }))).toBe(true);
    }
    expect(refused(await call('/api/w/ws-1/projects/p1', { origin: 'null' }))).toBe(true);
  });

  it('is refused on the desktop app too, which has no session to stop it', async () => {
    vi.stubEnv('OSW_DESKTOP', 'true');
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:30011', origin: 'https://evil.example' }))).toBe(true);
  });
});

describe('a read from another page', () => {
  const get = (path: string, opts: { origin?: string | null; headers?: Record<string, string> }) =>
    call(path, { method: 'GET', ...opts });

  it('is refused when it names another origin', async () => {
    expect(refused(await get('/api/w/ws-1/projects', { origin: 'https://evil.example' }))).toBe(true);
  });

  it('is refused from project code on an opaque origin', async () => {
    for (const path of ['/api/auth/me', '/api/w/ws-1/sync/status', '/api/admin/users']) {
      expect(refused(await get(path, { origin: 'null', headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true);
      // Over plain HTTP, or from an older browser, only the Origin comes.
      expect(refused(await get(path, { origin: 'null' }))).toBe(true);
    }
  });

  it('is refused from a same-site page, which the Lax session cookie still reaches', async () => {
    // A published site on a sibling subdomain, by fetch or by an <img> that sends no Origin.
    expect(refused(await get('/api/w/ws-1/projects', { origin: null, headers: { 'sec-fetch-site': 'same-site' } }))).toBe(true);
    expect(refused(await get('/api/w/ws-1/projects', { origin: 'https://shop.inst-1.oswstudio.com', headers: { 'sec-fetch-site': 'same-site' } }))).toBe(true);
  });

  it('is refused on a cross-site navigation to an API address', async () => {
    expect(refused(await get('/api/analytics/d1/overview', { origin: null, headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true);
  });

  it('is refused on the desktop app, whose API has no session', async () => {
    vi.stubEnv('OSW_DESKTOP', 'true');
    expect(refused(await call('/api/w/ws-1/projects', { method: 'GET', host: 'localhost:30011', origin: null, headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true);
  });

  it.each([
    ['/api/auth/handoff', 'the gateway\'s login redirect'],
    ['/api/mcp/oauth/hold', 'the consent page\'s redirect on an MCP client\'s navigation'],
    ['/api/deployments/d1/functions/contact', 'a published site\'s function call'],
    ['/api/analytics/track', 'a published site\'s pageview'],
  ])('passes for %s, %s', async (path) => {
    expect(refused(await get(path, { origin: null, headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false);
    expect(refused(await get(path, { origin: null, headers: { 'sec-fetch-site': 'same-site' } }))).toBe(false);
  });
});

describe('what still gets through', () => {
  it('a write from the app\'s own pages', async () => {
    expect(refused(await call('/api/w/ws-1/deployments/d1/publish'))).toBe(false);
  });

  it('a read from the studio\'s own pages, and the user\'s own navigation', async () => {
    const read = (headers?: Record<string, string>) => call('/api/w/ws-1/projects', { method: 'GET', origin: null, headers });
    expect(refused(await read({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(refused(await read({ 'sec-fetch-site': 'none' }))).toBe(false);
    // Over plain HTTP a same-origin read carries neither header.
    expect(refused(await read())).toBe(false);
  });

  it('a request marked Sec-Fetch-Site same-origin behind a proxy that hides the public host', async () => {
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:3000', origin: 'https://studio.example', headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(false);
  });

  it('the desktop app\'s own pages over plain http', async () => {
    vi.stubEnv('OSW_DESKTOP', 'true');
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:30011', origin: 'http://localhost:30011' }))).toBe(false);
  });

  it('a request with no Origin, as a server-side or CLI client sends', async () => {
    expect(refused(await call('/api/admin/users', { origin: null }))).toBe(false);
  });

  it('a page navigation from another site, which is not the API', async () => {
    expect(refused(await call('/w/ws-1/projects', { method: 'GET', origin: null, headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false);
  });

  it.each([
    '/api/deployments/d1/functions/contact',
    '/api/analytics/track',
    '/api/analytics/interaction',
    '/api/mcp',
    '/api/mcp/oauth/token',
    '/api/mcp/oauth/register',
    '/api/mcp/oauth/revoke',
    '/api/mcp/files/tok-1',
  ])('a route other origins call by design: %s', async (path) => {
    expect(refused(await call(path, { origin: 'https://customer-site.example' }))).toBe(false);
  });

  it('the public host behind a proxy that rewrites Host', async () => {
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:3000', origin: 'https://studio.example', headers: { 'x-forwarded-host': 'studio.example' } }))).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://studio.example');
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:3000', origin: 'https://studio.example' }))).toBe(false);
  });

  it('origins listed in ALLOWED_ORIGINS, and the HuggingFace Space\'s own host', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://a.example, https://b.example');
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:3000', origin: 'https://b.example' }))).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');
    vi.stubEnv('SPACE_HOST', 'otst-osw-studio.hf.space');
    expect(refused(await call('/api/generate', { host: 'localhost:7860', origin: 'https://otst-osw-studio.hf.space' }))).toBe(false);
  });
});
