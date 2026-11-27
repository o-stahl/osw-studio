// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { RenderJob, RenderResult } from '@/lib/canvas/render-types';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The page render itself runs in a browser; here it answers with fixed bytes for the job it gets.
const renderPage = vi.fn<(job: RenderJob) => Promise<RenderResult>>();
vi.mock('@/lib/canvas/render-job', () => ({ renderPage: (job: RenderJob) => renderPage(job) }));

import { vfs } from '@/lib/vfs';
import { vfsShell } from '../cli-shell';

/**
 * A page saved as an image (`screenshot --out`) and an image in the project given to the image
 * model to rework (`generate-image --image`): the two steps of turning a page, such as a 3D scene,
 * into a generated picture.
 */
globalThis.indexedDB = new IDBFactory();

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

let seq = 0;
async function seed(files: Record<string, string | ArrayBuffer> = {}): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('img', 'fixture', `p-img-${++seq}`);
  await vfs.createFile(project.id, '/index.html', '<h1 class="hero">Hi</h1>', { silent: true });
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}
const bytes = async (id: string, path: string) => new Uint8Array((await vfs.readFile(id, path)).content as ArrayBuffer);

beforeEach(() => {
  renderPage.mockReset().mockImplementation(async (job) => ({
    ok: true, kind: 'screenshot', width: job.width, height: 900, pageHeight: 900,
    images: [{ mediaType: job.save ?? 'image/jpeg', data: PNG, width: 640, height: 360, region: { x: 0, y: 0, w: 640, h: 360 } }],
  }));
});

describe('screenshot --out', () => {
  it('saves exactly the element, in the format its name asks for, with no model that reads images', async () => {
    const id = await seed();
    const result = await vfsShell.execute(id, ['screenshot', '/index.html', '.hero', '--out', '/renders/hero.png']);
    expect(result.success, result.stderr).toBe(true);
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({ page: '/index.html', target: '.hero', save: 'image/png' }));
    expect(await bytes(id, '/renders/hero.png')).toEqual(bytesOf(PNG));
    // The output names where the file went and what it holds: its path, pixel size and byte count.
    expect(result.stdout).toMatch(new RegExp(`/renders/hero\\.png\\b.*640×360.*\\b${bytesOf(PNG).length} bytes`));
  });

  it('asks for JPEG for a .jpg name, and replaces a file already there', async () => {
    const id = await seed({ '/shot.jpg': new Uint8Array([1, 2, 3]).buffer });
    const result = await vfsShell.execute(id, ['screenshot', '/index.html', '--out=/shot.jpg']);
    expect(result.success, result.stderr).toBe(true);
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({ save: 'image/jpeg' }));
    expect(await bytes(id, '/shot.jpg')).toEqual(bytesOf(PNG));
  });

  it('refuses a name that is not .png or .jpg, before rendering', async () => {
    const id = await seed();
    const result = await vfsShell.execute(id, ['screenshot', '/index.html', '--out', '/shot.gif']);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('.png or .jpg');
    expect(renderPage).not.toHaveBeenCalled();
  });

  it('writes nothing when the render fails', async () => {
    renderPage.mockResolvedValueOnce({ ok: false, error: 'the image would be 5000×300 px, and a saved image is at most 4096 px on a side' });
    const id = await seed();
    const result = await vfsShell.execute(id, ['screenshot', '/index.html', '--full', '--out', '/big.png']);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('at most 4096 px');
    expect(await vfs.fileExists(id, '/big.png')).toBe(false);
  });
});

describe('generate-image --image', () => {
  const generated = { base64: PNG, mimeType: 'image/png' };

  it('hands the project image to the model as the source, typed by its name', async () => {
    const id = await seed({ '/renders/view.png': bytesOf(PNG).buffer });
    const generateImage = vi.fn(async () => generated);
    const result = await vfsShell.execute(id, ['generate-image', '--image', '/renders/view.png', '--out', '/final.png', 'a photoreal dining corner'], undefined, { generateImage });
    expect(result.success, result.stderr).toBe(true);
    expect(generateImage).toHaveBeenCalledWith('a photoreal dining corner', expect.objectContaining({ source: { base64: PNG, mimeType: 'image/png' } }));
    expect(await bytes(id, '/final.png')).toEqual(bytesOf(PNG));
    expect(result.stdout).toContain('from /renders/view.png');
  });

  it('names the file by the format the model returned, and says so', async () => {
    const id = await seed();
    const generateImage = vi.fn(async () => ({ base64: '/9j/4AAQ', mimeType: 'image/jpeg' }));
    const result = await vfsShell.execute(id, ['generate-image', '--out', '/renders/final.png', 'p'], undefined, { generateImage });
    expect(result.success, result.stderr).toBe(true);
    expect(await vfs.fileExists(id, '/renders/final.png')).toBe(false);
    expect(await bytes(id, '/renders/final.jpg')).toEqual(bytesOf('/9j/4AAQ'));
    // The output gives the path the file was saved at, not the one asked for.
    expect(result.stdout).toContain('/renders/final.jpg');
    await vfsShell.execute(id, ['generate-image', '--out', '/renders/same.jpeg', 'p'], undefined, { generateImage });
    expect(await vfs.fileExists(id, '/renders/same.jpeg')).toBe(true);
  });

  it('sends no source without --image', async () => {
    const id = await seed();
    const generateImage = vi.fn(async () => generated);
    await vfsShell.execute(id, ['generate-image', '--out', '/a.png', 'a lighthouse'], undefined, { generateImage });
    expect(generateImage).toHaveBeenCalledWith('a lighthouse', { aspectRatio: undefined, imageSize: undefined });
  });

  it('refuses a missing file, a text file and a type models do not read, without calling the model', async () => {
    const id = await seed({ '/notes.png': 'not bytes', '/doc.svg': new Uint8Array([60]).buffer });
    const generateImage = vi.fn(async () => generated);
    const run = (path: string) => vfsShell.execute(id, ['generate-image', '--image', path, 'p'], undefined, { generateImage });
    expect((await run('/nope.png')).stderr).toContain('/nope.png: No such file');
    expect((await run('/notes.png')).stderr).toContain('/notes.png is not an image file');
    expect((await run('/doc.svg')).stderr).toContain('PNG, JPEG, WebP or GIF');
    expect(generateImage).not.toHaveBeenCalled();
  });
});
