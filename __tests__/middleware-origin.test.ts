import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A write to the API from another site's page is refused (SEC-4). Routes authenticate with the
 * session cookie, which the browser attaches to a cross-site form or fetch, so without this a page on
 * any site could publish, add members or hand out a ChatGPT token in the name of a signed-in user.
 * Routes that other origins call by design are exempt, and a request with no Origin (a server or CLI
 * client) is not a browser's cross-site request and passes.
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

describe('what still gets through', () => {
  it('a write from the app\'s own pages', async () => {
    expect(refused(await call('/api/w/ws-1/deployments/d1/publish'))).toBe(false);
  });

  it('the desktop app\'s own pages over plain http', async () => {
    vi.stubEnv('OSW_DESKTOP', 'true');
    expect(refused(await call('/api/w/ws-1/projects/p1', { host: 'localhost:30011', origin: 'http://localhost:30011' }))).toBe(false);
  });

  it('a request with no Origin, as a server-side or CLI client sends', async () => {
    expect(refused(await call('/api/admin/users', { origin: null }))).toBe(false);
  });

  it('a read from another site, which changes nothing', async () => {
    expect(refused(await call('/api/w/ws-1/projects', { method: 'GET', origin: 'https://evil.example' }))).toBe(false);
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
