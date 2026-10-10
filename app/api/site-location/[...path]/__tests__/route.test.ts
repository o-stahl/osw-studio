import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Where a site page or review copy asked for on the studio host is sent (SEC-6). Old links keep
 * working: they land on the site's own host, and never on the studio's origin.
 */

const resolve = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vfs/adapters/deployment-adapter', () => ({ resolveDeploymentByIdOrSlug: resolve }));

const ask = async (path: string) => {
  const { GET } = await import('../route');
  return GET(new NextRequest(`https://inst-1.oswstudio.com/api/site-location${path}`));
};

beforeEach(() => {
  vi.resetModules();
  resolve.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('with a proxy', () => {
  beforeEach(() => {
    vi.stubEnv('STATIC_PROXY', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.oswstudio.com');
  });

  it("sends a site page to the root of the site's subdomain", async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1', slug: 'pale-plum-place' } });
    const res = await ask('/deployments/d1/about.html?x=1');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://pale-plum-place.inst-1.oswstudio.com/about.html?x=1');
  });

  it('prefers the custom domain, and keeps the review path', async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1', slug: 'pale-plum-place', customDomain: 'papertop.app' } });
    expect((await ask('/deployments/d1/')).headers.get('location')).toBe('https://papertop.app/');
    expect((await ask('/review/d1/page.html')).headers.get('location')).toBe('https://papertop.app/review/d1/page.html');
  });

  it('never sends a request back to the studio', async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1' } });
    expect((await ask('/deployments/d1/')).status).toBe(404);
    resolve.mockResolvedValue(null);
    expect((await ask('/deployments/nope/')).status).toBe(404);
    expect((await ask('/api/w/ws/deployments')).status).toBe(404);
  });

  it('answers 404 when the lookup fails, instead of an error page', async () => {
    resolve.mockRejectedValue(new Error('database is locked'));
    expect((await ask('/deployments/d1/')).status).toBe(404);
  });
});

describe('with a sites origin', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://studio.example.com');
    vi.stubEnv('SITES_ORIGIN', 'https://sites.example.com');
  });

  it('keeps the path and swaps the origin', async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1', slug: 'sunny' } });
    expect((await ask('/review/d1/')).headers.get('location')).toBe('https://sites.example.com/review/d1/');
    expect((await ask('/deployments/d1/about.html')).headers.get('location')).toBe('https://sites.example.com/deployments/d1/about.html');
  });

  it('sends a deployment with a custom domain there, where its root-relative assets work', async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1', customDomain: 'shop.example.org' } });
    expect((await ask('/deployments/d1/about.html')).headers.get('location')).toBe('https://shop.example.org/about.html');
  });

  it("keeps that deployment's review copy on the sites address, since only Caddy serves /review/ on a domain", async () => {
    resolve.mockResolvedValue({ deployment: { id: 'd1', customDomain: 'shop.example.org' } });
    expect((await ask('/review/d1/')).headers.get('location')).toBe('https://sites.example.com/review/d1/');
  });
});
