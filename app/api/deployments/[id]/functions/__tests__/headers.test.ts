import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * What crosses the function route in each direction.
 *
 * Functions are written by whoever can edit a project, and a published site runs them for every
 * visitor on the app's own origin. The visitor's browser sends that origin's cookies, including the
 * admin's session and the ChatGPT refresh token, so the route is the only place that can keep them
 * out of function code, and the only place that can stop a function's response setting them.
 */

const mocks = vi.hoisted(() => ({
  resolveDeploymentByIdOrSlug: vi.fn(),
  executeFunction: vi.fn(),
}));

vi.mock('@/lib/vfs/adapters/deployment-adapter', () => ({
  resolveDeploymentByIdOrSlug: mocks.resolveDeploymentByIdOrSlug,
}));
vi.mock('@/lib/edge-functions/executor', () => ({ executeFunction: mocks.executeFunction }));

import { GET, POST } from '../[...path]/route';

const fn = { id: 'f1', name: 'echo', method: 'ANY', enabled: true };

beforeEach(() => {
  mocks.resolveDeploymentByIdOrSlug.mockReset().mockResolvedValue({
    deployment: { id: 'd1', publishedAt: '2026-10-01', databaseEnabled: true },
    adapter: {
      getDeploymentDatabaseForAnalytics: () => ({
        getFunctionByName: () => fn,
        logFunctionExecution: () => {},
      }),
    },
  });
  mocks.executeFunction.mockReset();
});

/** Run the route with a function that returns `headers` and reports the request it was given. */
async function call(init: { cookie?: string; headers?: Record<string, string>; responseHeaders?: Record<string, string> }) {
  let seen: { headers: Record<string, string> } | undefined;
  mocks.executeFunction.mockImplementation(async (_fn, request) => {
    seen = request;
    return {
      response: { status: 200, headers: init.responseHeaders ?? {}, body: { ok: true } },
      logs: [],
      durationMs: 1,
    };
  });
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  const response = await GET(new NextRequest('http://localhost:3000/api/deployments/d1/functions/echo', { headers }), {
    params: Promise.resolve({ id: 'd1', path: ['echo'] }),
  });
  return { response, request: seen! };
}

describe('the request a function receives', () => {
  it('keeps the site’s own cookies and drops every osw_ cookie', async () => {
    const { request } = await call({
      cookie: 'osw_session=jwt; blog_session=t1; osw_codex_rt=rt; theme=dark; osw_workspace=w1',
    });
    expect(request.headers.cookie).toBe('blog_session=t1; theme=dark');
  });

  it('has no cookie header when every cookie was the app’s', async () => {
    const { request } = await call({ cookie: 'osw_session=jwt; osw_gateway_session=g' });
    expect(request.headers).not.toHaveProperty('cookie');
  });

  it('drops a prefixed or differently cased app cookie', async () => {
    const { request } = await call({ cookie: '__Host-osw_session=a; OSW_SESSION=b; site=1' });
    expect(request.headers.cookie).toBe('site=1');
  });

  it('still passes the ordinary request headers', async () => {
    const { request } = await call({
      headers: { 'content-type': 'application/json', 'accept-language': 'fi', 'x-api-key': 'k1', 'authorization': 'Basic x' },
    });
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['accept-language']).toBe('fi');
    expect(request.headers['x-api-key']).toBe('k1');
    expect(request.headers).not.toHaveProperty('authorization');
  });

  it('keeps the gateway’s instance credential out', async () => {
    const { request } = await call({ headers: { 'x-instance-api-key': 'secret', 'x-ok': '1' } });
    expect(request.headers).not.toHaveProperty('x-instance-api-key');
    expect(request.headers['x-ok']).toBe('1');
  });
});

describe('the response a function sends', () => {
  it('cannot set an osw_ cookie', async () => {
    for (const cookie of ['osw_session=evil; Path=/', '__Secure-osw_session=evil; Path=/; Secure', 'OSW_Codex_RT=x']) {
      const { response } = await call({ responseHeaders: { 'Set-Cookie': cookie } });
      expect(response.headers.get('set-cookie'), cookie).toBeNull();
    }
  });

  it('cannot set a nameless cookie, which the browser would send back as an osw_ one', async () => {
    for (const cookie of ['=osw_session=evil; Path=/', ' =x', '=']) {
      const { response } = await call({ responseHeaders: { 'Set-Cookie': cookie } });
      expect(response.headers.get('set-cookie'), cookie).toBeNull();
    }
  });

  it('sets its own cookie, host-only', async () => {
    const { response } = await call({
      responseHeaders: { 'Set-Cookie': 'blog_session=t; Domain=example.com; Path=/; HttpOnly; SameSite=Lax' },
    });
    expect(response.headers.get('set-cookie')).toBe('blog_session=t; Path=/; HttpOnly; SameSite=Lax');
  });

  it('keeps content, caching, redirect and x- headers and drops the rest', async () => {
    const { response } = await call({
      responseHeaders: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'Location': '/thanks',
        'ETag': '"1"',
        'Last-Modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
        'X-Request-Id': 'r1',
        'Content-Security-Policy': "default-src *",
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Strict-Transport-Security': 'max-age=0',
        'Refresh': '0; url=https://example.com',
        'X-Accel-Redirect': '/internal/data/osws.sqlite',
        'X-Sendfile': '/etc/passwd',
        'X-Middleware-Rewrite': '/admin',
        'X-Nextjs-Redirect': '/admin',
      },
    });
    const h = response.headers;
    expect(h.get('content-type')).toBe('text/html');
    expect(h.get('cache-control')).toBe('no-store');
    expect(h.get('location')).toBe('/thanks');
    expect(h.get('etag')).toBe('"1"');
    expect(h.get('last-modified')).toBe('Wed, 01 Oct 2026 00:00:00 GMT');
    expect(h.get('x-request-id')).toBe('r1');
    // The function's own policy is dropped; the route's sandbox is what the response carries.
    expect(h.get('content-security-policy')).toBe('sandbox');
    for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'strict-transport-security', 'refresh', 'x-accel-redirect', 'x-sendfile', 'x-middleware-rewrite', 'x-nextjs-redirect']) {
      expect(h.get(name), name).toBeNull();
    }
  });

  it('applies to every method', async () => {
    mocks.executeFunction.mockResolvedValue({
      response: { status: 200, headers: { 'Set-Cookie': 'osw_session=evil' }, body: '' },
      logs: [],
      durationMs: 1,
    });
    const response = await POST(new NextRequest('http://localhost:3000/api/deployments/d1/functions/echo', { method: 'POST' }), {
      params: Promise.resolve({ id: 'd1', path: ['echo'] }),
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('a function response opened as a page', () => {
  it('cannot run with the origin it was served from', async () => {
    const { response } = await call({ responseHeaders: { 'Content-Type': 'text/html' } });
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('is guarded on a refusal too', async () => {
    mocks.resolveDeploymentByIdOrSlug.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost:3000/api/deployments/d1/functions/echo'), {
      params: Promise.resolve({ id: 'd1', path: ['echo'] }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
  });
});
