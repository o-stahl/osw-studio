import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

/**
 * The built-in routes that serve published sites wherever Caddy does not serve them itself: installs
 * without Caddy, and a subdomain without a block of its own.
 *
 * A production server hands these routes `%2e%2e%2f` decoded inside one segment, as `../`, so the
 * request path is attacker-controlled text and the route itself must keep the read inside the
 * site's folder. Outside it, on the same disk, are `data/` and `.env`.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osw-static-'));
let GET_FILE: typeof import('../[...path]/route').GET;
let GET_INDEX: typeof import('../route').GET;

beforeAll(async () => {
  const site = path.join(root, 'static', 'd1');
  fs.mkdirSync(path.join(site, 'css'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(site, 'css', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(root, 'index.html'), 'OUTSIDE');
  fs.writeFileSync(path.join(root, '404.html'), 'OUTSIDE');
  // Where the id `../d1` points: a folder beside the deployments root, outside it.
  fs.mkdirSync(path.join(root, 'd1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'd1', 'index.html'), 'OUTSIDE');
  fs.writeFileSync(path.join(root, 'd1', '404.html'), 'OUTSIDE');
  fs.writeFileSync(path.join(root, 'static', 'index.html'), 'SIBLING');
  fs.writeFileSync(path.join(root, 'static', '404.html'), 'SIBLING');
  fs.mkdirSync(path.join(root, 'static', 'd1-old'), { recursive: true });
  fs.writeFileSync(path.join(root, 'static', 'd1-old', 'x.txt'), 'NEIGHBOUR');
  process.env.DEPLOYMENTS_STATIC_DIR = path.join(root, 'static');
  ({ GET: GET_FILE } = await import('../[...path]/route'));
  ({ GET: GET_INDEX } = await import('../route'));
});

afterAll(() => {
  delete process.env.DEPLOYMENTS_STATIC_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

async function file(id: string, segments: string[]) {
  const response = await GET_FILE(new NextRequest('http://localhost:3000/deployments/x'), {
    params: Promise.resolve({ id, path: segments }),
  });
  return { status: response.status, body: await response.text() };
}

async function index(id: string) {
  const response = await GET_INDEX(new NextRequest('http://localhost:3000/deployments/x'), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * A backslash is a separator only on Windows. Elsewhere `..\\..\\x` is one file name that does not
 * exist, so these rows get a 404 whatever the route does and can only test anything on win32.
 */
const onWindows = process.platform === 'win32';

describe('a published site file', () => {
  it('serves nested assets', async () => {
    expect(await file('d1', ['css', 'a.css'])).toEqual({ status: 200, body: 'body{}' });
  });

  it.each([
    ['one decoded segment', ['../../secret.txt']],
    ['separate segments', ['..', '..', 'secret.txt']],
    ['a nested start', ['css', '../../../secret.txt']],
    ['an absolute path', [path.join(root, 'secret.txt')]],
    ['a sibling folder sharing the prefix', ['../d1-old/x.txt']],
  ])('stays inside the site through %s', async (_label, segments) => {
    const { status, body } = await file('d1', segments);
    expect(status).toBe(404);
    expect(body).not.toMatch(/SECRET|NEIGHBOUR/);
  });

  it.skipIf(!onWindows)('stays inside the site through a backslash', async () => {
    const { status, body } = await file('d1', ['..\\..\\secret.txt']);
    expect(status).toBe(404);
    expect(body).not.toMatch(/SECRET/);
  });

  it.each(['..', '.', '../d1', 'd1/..', ''])('refuses the deployment id %j', async (id) => {
    const { status, body } = await file(id, ['index.html']);
    expect(status).toBe(404);
    expect(body).not.toMatch(/SIBLING|OUTSIDE|site/);
  });

  it.skipIf(!onWindows)('refuses a deployment id with a backslash', async () => {
    const { status, body } = await file('..\\static', ['index.html']);
    expect(status).toBe(404);
    expect(body).not.toMatch(/SIBLING|OUTSIDE|site/);
  });
});

describe('a published site root', () => {
  it('serves index.html', async () => {
    const response = await GET_INDEX(new NextRequest('http://localhost:3000/deployments/d1'), {
      params: Promise.resolve({ id: 'd1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>site</h1>');
  });

  it('refuses an id that leaves the deployments folder', async () => {
    const response = await GET_INDEX(new NextRequest('http://localhost:3000/deployments/x'), {
      params: Promise.resolve({ id: '..' }),
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe('OUTSIDE');
  });
});

describe('a missing page', () => {
  const site = () => path.join(root, 'static', 'd1');

  it('gets the site\'s 404.html with status 404', async () => {
    fs.writeFileSync(path.join(site(), '404.html'), '<h1>not here</h1>');
    try {
      // Paths arrive as they are, with or without `.html`.
      for (const segments of [['about.html'], ['about'], ['a', 'b'], ['nope']]) {
        expect(await file('d1', segments)).toEqual({ status: 404, body: '<h1>not here</h1>' });
      }
      // A missing asset keeps the bare 404.
      expect(await file('d1', ['css', 'missing.css'])).toEqual({ status: 404, body: 'File not found' });
    } finally {
      fs.rmSync(path.join(site(), '404.html'));
    }
  });

  it.each(['..', '.', '../d1', 'd1/..', ''])('is never answered from outside the site\'s folder, for the deployment id %j', async (id) => {
    const { status, body } = await file(id, ['nope']);
    expect(status).toBe(404);
    expect(body).not.toMatch(/SIBLING|OUTSIDE/);
  });

  it('gets the bare 404 when the site has no 404.html', async () => {
    expect(await file('d1', ['about.html'])).toEqual({ status: 404, body: 'File not found' });
  });
});

describe('a page by its clean URL', () => {
  const site = () => path.join(root, 'static', 'd1');

  it('is found at any depth, a folder by its index, as Caddy finds it', async () => {
    fs.mkdirSync(path.join(site(), 'blog', 'post'), { recursive: true });
    fs.writeFileSync(path.join(site(), 'blog', 'first.html'), 'FIRST');
    fs.writeFileSync(path.join(site(), 'blog', 'post', 'index.html'), 'POST');
    fs.writeFileSync(path.join(site(), 'blog', 'index.html'), 'BLOG');
    try {
      expect(await file('d1', ['blog', 'first'])).toEqual({ status: 200, body: 'FIRST' });
      expect(await file('d1', ['blog', 'post'])).toEqual({ status: 200, body: 'POST' });
      expect(await file('d1', ['blog'])).toEqual({ status: 200, body: 'BLOG' });
    } finally {
      fs.rmSync(path.join(site(), 'blog'), { recursive: true });
    }
  });

  it('is served with Caddy in front too, where a subdomain without its own block reaches it', async () => {
    fs.writeFileSync(path.join(site(), 'about.html'), 'ABOUT');
    process.env.STATIC_PROXY = 'true';
    try {
      expect(await file('d1', ['about'])).toEqual({ status: 200, body: 'ABOUT' });
      expect(await index('d1')).toEqual({ status: 200, body: '<h1>site</h1>' });
    } finally {
      delete process.env.STATIC_PROXY;
      fs.rmSync(path.join(site(), 'about.html'));
    }
  });
});

