import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The built HTML of a published page, for the studio's sandboxed capture (SEC-6). Only for someone
 * with access to the deployment, only HTML, and only from inside that deployment's build.
 */

const access = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/deployment-access', () => ({ requireDeploymentAccess: access }));

let dir: string;

beforeEach(() => {
  vi.resetModules();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-pages-'));
  vi.stubEnv('DEPLOYMENTS_STATIC_DIR', dir);
  vi.stubEnv('STATIC_PROXY', 'true');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.oswstudio.com');
  fs.mkdirSync(path.join(dir, 'd1', 'blog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'd1', 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(dir, 'd1', 'about.html'), '<h1>about</h1>');
  fs.writeFileSync(path.join(dir, 'd1', 'blog', 'index.html'), '<h1>blog</h1>');
  fs.writeFileSync(path.join(dir, 'd1', 'data.json'), '{}');
  fs.writeFileSync(path.join(dir, 'secret.html'), '<h1>outside</h1>');
  access.mockResolvedValue({ ok: true, context: { deployment: { id: 'd1', slug: 'sunny' } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function page(p: string) {
  const { GET } = await import('../route');
  const res = await GET(new NextRequest(`https://inst-1.oswstudio.com/api/deployment-pages/d1?path=${encodeURIComponent(p)}`), {
    params: Promise.resolve({ deploymentId: 'd1' }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

describe('GET /api/deployment-pages/{id}', () => {
  it('finds a page the way a visitor addresses it, with its public URL', async () => {
    expect(await page('/')).toEqual({ status: 200, body: { html: '<h1>home</h1>', url: 'https://sunny.inst-1.oswstudio.com/index.html' } });
    expect((await page('/about')).body.html).toBe('<h1>about</h1>');
    expect((await page('/blog/')).body.html).toBe('<h1>blog</h1>');
    expect((await page('/deployments/d1/about.html')).body.html).toBe('<h1>about</h1>');
  });

  it('serves nothing but HTML from inside the build', async () => {
    expect((await page('/data.json')).status).toBe(404);
    expect((await page('/../secret.html')).status).toBe(404);
    expect((await page('/../../etc/passwd')).status).toBe(404);
  });

  it('answers only someone with access to the deployment', async () => {
    await page('/');
    // Viewing is enough: the page is what the site already shows its visitors.
    expect(access).toHaveBeenCalledWith('d1', 'viewer');
    access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await page('/')).status).toBe(401);
  });
});
