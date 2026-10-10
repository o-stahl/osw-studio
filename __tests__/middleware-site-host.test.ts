import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Published sites live away from the studio's origin (SEC-6, lib/web/site-origin.ts). On a site
 * host the app answers only what a site needs, so a site's script cannot reach the studio's API on
 * its own origin; on the studio host, a site document is sent to where it lives. On desktop, whose
 * API has no session, a request addressed to anything but loopback is refused.
 */

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubEnv('SESSION_SECRET', 'test-secret-value-that-is-long-enough');
});

afterEach(() => vi.unstubAllEnvs());

async function call(url: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  const { NextRequest } = await import('next/server');
  const { middleware } = await import('@/middleware');
  const { host } = new URL(url);
  return middleware(new NextRequest(url, { method: opts.method ?? 'GET', headers: { host, ...(opts.headers ?? {}) } }));
}

const rewrittenTo = (res: Response) => res.headers.get('x-middleware-rewrite');

describe('with a separate sites origin (SITES_ORIGIN)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://studio.example.com');
    vi.stubEnv('SITES_ORIGIN', 'https://sites.example.com');
  });

  it('answers a site, its functions, analytics and review copy on the sites host', async () => {
    for (const path of ['/deployments/d1/', '/deployments/d1/logo.svg', '/api/deployments/d1/functions/contact', '/api/analytics/track', '/review/d1/']) {
      const res = await call(`https://sites.example.com${path}`, { method: path.includes('analytics') ? 'POST' : 'GET', headers: { origin: 'https://sites.example.com' } });
      expect(res.status, path).toBe(200);
      expect(rewrittenTo(res), path).toBeNull();
    }
  });

  it("refuses the studio's API and pages on the sites host", async () => {
    for (const path of ['/api/w/ws-1/deployments', '/api/admin/users', '/w/ws-1/projects', '/api/workspaces', '/']) {
      expect((await call(`https://sites.example.com${path}`)).status, path).toBe(404);
    }
  });

  it("sends a site page or review copy on the studio host to where it lives, keeping the review panel's API", async () => {
    for (const path of ['/deployments/d1/', '/deployments/d1/evil.svg', '/review/d1/', '/review/d1/page.html']) {
      expect(rewrittenTo(await call(`https://studio.example.com${path}`)), path).toContain('/api/site-location/');
    }
    expect(rewrittenTo(await call('https://studio.example.com/review/d1/osw-api/comments'))).toBeNull();
    expect((await call('https://studio.example.com/deployments/d1/', { method: 'POST', headers: { origin: 'https://studio.example.com' } })).status).toBe(404);
  });

  it('ignores an X-Forwarded-Host claiming to be the studio', async () => {
    const res = await call('https://sites.example.com/api/w/ws-1/deployments', { headers: { 'x-forwarded-host': 'studio.example.com' } });
    expect(res.status).toBe(404);
  });
});

describe('with a proxy (STATIC_PROXY)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.oswstudio.com');
    vi.stubEnv('STATIC_PROXY', 'true');
  });

  it("treats slug subdomains and custom domains as site hosts, and the app host and loopback as the studio's", async () => {
    expect((await call('https://sunny.inst-1.oswstudio.com/api/admin/users')).status).toBe(404);
    expect((await call('https://papertop.app/api/w/ws-1/deployments')).status).toBe(404);
    expect((await call('https://papertop.app/review/d1/')).status).toBe(200);
    expect(rewrittenTo(await call('https://inst-1.oswstudio.com/deployments/d1/'))).toContain('/api/site-location');
    // Caddy's own on-demand TLS check arrives on loopback.
    expect((await call('http://localhost:3000/api/resolve-domain?domain=papertop.app')).status).toBe(200);
  });
});

describe('with neither (same-origin fallback)', () => {
  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://osws.example.com'));

  it('serves sites on the studio host as before', async () => {
    const res = await call('https://osws.example.com/deployments/d1/');
    expect(res.status).toBe(200);
    expect(rewrittenTo(res)).toBeNull();
  });
});

describe('desktop', () => {
  beforeEach(() => {
    vi.stubEnv('OSW_DESKTOP', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:30011');
    vi.stubEnv('SITES_ORIGIN', 'http://localhost:30012');
  });

  it('answers the studio on loopback only', async () => {
    expect((await call('http://localhost:30011/api/w/ws-1/deployments')).status).toBe(200);
    expect((await call('http://127.0.0.1:30011/api/w/ws-1/deployments')).status).toBe(200);
    expect((await call('http://rebound.attacker.test:30011/api/w/ws-1/deployments')).status).toBe(404);
  });

  it('answers only site paths on the sites port', async () => {
    expect((await call('http://localhost:30012/api/w/ws-1/deployments')).status).toBe(404);
    expect((await call('http://localhost:30012/deployments/d1/')).status).toBe(200);
  });
});
