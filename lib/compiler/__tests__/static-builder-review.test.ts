import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';
import { blobDir } from '@/lib/vfs/adapters/blob-store';
import { REVIEW_WIDGET_MARKER } from '@/lib/publishing/review-widget';
import { reviewApiBase } from '@/lib/review/api-base';
import { interceptPage } from '@/lib/publishing/__tests__/interceptor-harness';
import type { VirtualFile } from '@/lib/vfs/types';

/**
 * Publishing produces two copies of the site from one compile.
 *
 * The public copy is served from the web root; the review copy carries the comment widget and is
 * written outside it, because a password and an expiry can only be enforced by a route. Both are
 * derived from the same compiled output, so the transform has to run twice over the *original*
 * content — running it twice over the same objects would prefix every asset path a second time and
 * inject the SEO and script blocks again.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceAdapter: vi.fn() }));

// Marked 'server-only' for the bundler; the guard has to be neutralised to load it under vitest.
vi.mock('server-only', () => ({}));

vi.mock('@/lib/vfs/adapters/server', () => ({
  getWorkspaceAdapter: mocks.getWorkspaceAdapter,
  createServerAdapter: async () => mocks.getWorkspaceAdapter(),
}));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let adapter: SQLiteAdapter;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6, 5, 4]);
const HTML =
  '<html><head><link href="/styles/main.css"></head><body><img src="/logo.png"></body></html>';

async function addFile(filePath: string, content: string | ArrayBuffer, type: string) {
  await adapter.createFile({
    id: `f-${filePath}`, projectId: 'p1', path: filePath, name: filePath.slice(1),
    type, content, size: 16, createdAt: new Date(), updatedAt: new Date(),
  } as VirtualFile);
}

async function createDeployment(overrides: Record<string, unknown>) {
  await adapter.createDeployment?.({
    id: 'd1', projectId: 'p1', name: 'Site', enabled: true,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as never);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-review-'));
  vi.stubEnv('DEPLOYMENTS_STATIC_DIR', path.join(dir, 'static'));
  vi.stubEnv('DEPLOYMENTS_DIR', path.join(dir, 'deployments'));

  adapter = new SQLiteAdapter(path.join(dir, 'workspace', 'osws.sqlite'));
  await adapter.init();
  mocks.getWorkspaceAdapter.mockReturnValue(adapter);

  await adapter.createProject({
    id: 'p1', name: 'Reviewed', createdAt: new Date(), updatedAt: new Date(),
    settings: { runtime: 'static' },
  } as never);
  await addFile('/index.html', HTML, 'html');
  await addFile('/styles/main.css', 'body { color: red }', 'css');
  await addFile('/logo.png', PNG.buffer.slice(0) as ArrayBuffer, 'image');
});

afterEach(async () => {
  await adapter.close?.();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const workspaceBase = () => path.join(dir, 'workspace');
const publicDir = () => path.join(dir, 'static', 'd1');
const reviewDir = () => path.join(dir, 'deployments', 'd1', 'review-build');
const read = (base: string, rel: string) => fs.readFileSync(path.join(base, rel), 'utf-8');

describe('review build', () => {
  it('is written when review mode is on, and absent when it is off', async () => {
    const { buildStaticDeployment } = await import('../static-builder');

    await createDeployment({ review: { enabled: false } });
    expect((await buildStaticDeployment('d1', 'w1')).success).toBe(true);
    expect(fs.existsSync(reviewDir())).toBe(false);

    const deployment = await adapter.getDeployment!('d1');
    await adapter.updateDeployment!({ ...deployment!, review: { enabled: true } });
    expect((await buildStaticDeployment('d1', 'w1')).success).toBe(true);

    expect(fs.existsSync(path.join(reviewDir(), 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(reviewDir(), 'styles', 'main.css'))).toBe(true);
  });

  it('carries the real site while the public output is the construction page', async () => {
    // A pre-launch site is exactly what needs reviewing, so the construction page must not replace
    // the review copy the way it replaces the public one.
    const { buildStaticDeployment } = await import('../static-builder');
    await createDeployment({ underConstruction: true, review: { enabled: true } });

    expect((await buildStaticDeployment('d1', 'w1')).success).toBe(true);

    expect(read(publicDir(), 'index.html')).toContain('Under Construction');
    const review = read(reviewDir(), 'index.html');
    expect(review).toContain('logo.png');
    expect(review).not.toContain('Under Construction');
  });

  it('does not prefix asset paths twice', async () => {
    const { buildStaticDeployment } = await import('../static-builder');
    await createDeployment({ review: { enabled: true } });
    await buildStaticDeployment('d1', 'w1');

    const review = read(reviewDir(), 'index.html');
    expect(review).toContain('/review/d1/styles/main.css');
    // The public pass rewrites the same content first. If the review pass ran over its output the
    // path would read `/review/d1/deployments/d1/styles/main.css`, so the public prefix appearing
    // anywhere in the review copy is the failure.
    expect(review).not.toContain('/deployments/d1');
  });

  it('carries the comment widget, which the public copy does not', async () => {
    const { buildStaticDeployment } = await import('../static-builder');
    await createDeployment({ review: { enabled: true } });
    await buildStaticDeployment('d1', 'w1');

    expect(read(reviewDir(), 'index.html')).toContain(REVIEW_WIDGET_MARKER);
    expect(read(publicDir(), 'index.html')).not.toContain(REVIEW_WIDGET_MARKER);
  });

  it('carries a widget whose calls survive the edge-function interceptor', async () => {
    // Both scripts are injected into the same review page, and the interceptor replaces
    // window.fetch for everything after it. A widget call it claims never reaches the comment
    // route, so the reviewer is told comments are unavailable on exactly the deployments that
    // use edge functions.
    const { buildStaticDeployment } = await import('../static-builder');
    await adapter.createEdgeFunction!({
      id: 'ef-1', projectId: 'p1', name: 'products', code: 'return Response.json({})',
      method: 'ANY', enabled: true, timeoutMs: 5000,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await createDeployment({ review: { enabled: true } });
    await buildStaticDeployment('d1', 'w1');

    const review = read(reviewDir(), 'index.html');
    expect(review).toContain(REVIEW_WIDGET_MARKER);

    const origin = 'https://studio.example.com';
    const page = interceptPage(review, origin);
    // Control: the interceptor is present and doing its job, so the assertions below cannot pass
    // by way of it having been disabled.
    expect(page.route('/products')).toBe('/api/deployments/d1/functions/products');

    const base = `${origin}${reviewApiBase('d1')}`;
    expect(page.widgetRequest('/comments', {})).toBe(`${base}/comments`);
    expect(page.widgetRequest('/comments/c-1', { method: 'PATCH', body: '{}' })).toBe(
      `${base}/comments/c-1`
    );
    expect(page.widgetRequest('/participant', { method: 'PATCH', body: '{}' })).toBe(
      `${base}/participant`
    );
  });

  it('injects the head content once', async () => {
    const { buildStaticDeployment } = await import('../static-builder');
    await createDeployment({ review: { enabled: true }, seo: { title: 'Reviewed Site' } });
    await buildStaticDeployment('d1', 'w1');

    const titles = read(reviewDir(), 'index.html').match(/<title>/g) || [];
    expect(titles).toHaveLength(1);
  });

  it('gives each page its own og:url, in both copies', async () => {
    const { buildStaticDeployment } = await import('../static-builder');
    await addFile('/about.html', '<html><head><title>About</title></head><body></body></html>', 'html');
    await createDeployment({ review: { enabled: true }, seo: { title: 'Reviewed Site' } });
    await buildStaticDeployment('d1', 'w1');

    const ogUrl = (html: string) => /<meta property="og:url" content="([^"]*)">/.exec(html)?.[1];
    for (const [copy, base] of [['public', publicDir()], ['review', reviewDir()]]) {
      const site = ogUrl(read(base, 'index.html'));
      expect(site, copy).toMatch(/\/deployments\/d1$/);
      expect(ogUrl(read(base, 'about.html')), copy).toBe(`${site}/about`);
    }
  });

  it('links binary files to the same blob rather than copying them', async () => {
    const { buildStaticDeployment } = await import('../static-builder');
    await createDeployment({ review: { enabled: true } });
    await buildStaticDeployment('d1', 'w1');

    expect(fs.readFileSync(path.join(reviewDir(), 'logo.png'))).toEqual(Buffer.from(PNG));

    const blobs = fs.readdirSync(blobDir(workspaceBase()));
    expect(blobs).toHaveLength(1);
    const blob = fs.statSync(path.join(blobDir(workspaceBase()), blobs[0]));
    expect(fs.statSync(path.join(reviewDir(), 'logo.png')).ino).toBe(blob.ino);
    // The blob, the public copy and the review copy: three names for one set of bytes.
    expect(blob.nlink).toBe(3);
  });
});
