// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { applyImageSrc } from '../apply-image';

/**
 * The write path for Replace.
 *
 * Same arrangement as `apply-style.test.ts`, and for the same reason: `vfs` is a module singleton
 * that caches its open database handle, so one IDBFactory for the file and one project per test.
 */
globalThis.indexedDB = new IDBFactory();

let projectSeq = 0;

async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Replace image', 'fixture', `p-image-${++projectSeq}`);
  for (const [path, content] of Object.entries(files)) {
    await vfs.createFile(project.id, path, content, { silent: true });
  }
  return project.id;
}

const read = async (projectId: string, path: string): Promise<string> =>
  String((await vfs.readFile(projectId, path)).content);

const src = (path: string, content: string, needle: string) =>
  `${path}:${content.indexOf(needle)}`;

afterEach(() => { vi.restoreAllMocks(); });

const PAGE = '<html><head></head><body><img src="/old.png" alt="A cat"></body></html>';

describe('applyImageSrc', () => {
  it('rewrites the src at the provenance index and reports the file it wrote', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<img'), tagName: 'img', attributes: { src: '/old.png' } },
      '/images/new.png',
    );

    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual(['/index.html']);
    expect(await read(projectId, '/index.html'))
      .toBe('<html><head></head><body><img src="/images/new.png" alt="A cat"></body></html>');
  });

  it('tells the recorder what the page held before and after, for undo', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const writes: unknown[] = [];
    await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<img'), tagName: 'img', attributes: { src: '/old.png' } },
      '/images/new.png',
      { record: (write) => writes.push(write) },
    );
    expect(writes).toEqual([{
      path: '/index.html',
      before: PAGE,
      after: '<html><head></head><body><img src="/images/new.png" alt="A cat"></body></html>',
      silent: false,
    }]);
  });

  it('writes into the partial the image came from, not the page that includes it', async () => {
    const partial = '<header><img src="/logo.png"></header>';
    const projectId = await seed({
      '/index.html': '<html><head></head><body>{{> header}}</body></html>',
      '/templates/header.hbs': partial,
    });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/templates/header.hbs', partial, '<img'), tagName: 'img' },
      '/logo-2.png',
    );

    expect(result.filesWritten).toEqual(['/templates/header.hbs']);
    expect(await read(projectId, '/templates/header.hbs')).toBe('<header><img src="/logo-2.png"></header>');
    expect(await read(projectId, '/index.html')).not.toContain('logo-2');
  });

  it('holds a multi-instance write until it is confirmed, then performs it', async () => {
    const page = '<body>{{#each cards}}<img src="/card.png">{{/each}}</body>';
    const projectId = await seed({ '/index.html': page });
    const selection = {
      srcAttr: src('/index.html', page, '<img'),
      tagName: 'img',
      instanceCount: 3,
    };

    const held = await applyImageSrc(projectId, selection, '/new.png');

    // One source tag rendering three images: swapping "this one" swaps all three, so the refusal is
    // the point. Nothing may reach the file before the user has been told the number.
    expect(held).toEqual({
      ok: false,
      reason: 'needs-confirmation',
      file: '/index.html',
      instances: 3,
      filesWritten: [],
    });
    expect(await read(projectId, '/index.html')).toBe(page);

    const confirmed = await applyImageSrc(projectId, selection, '/new.png', {
      confirmedMultiInstance: true,
    });

    expect(confirmed.ok).toBe(true);
    expect(await read(projectId, '/index.html'))
      .toBe('<body>{{#each cards}}<img src="/new.png">{{/each}}</body>');
  });

  it('refuses while the agent is generating, before reading anything', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<img'), tagName: 'img' },
      '/new.png',
      { isGenerating: () => true },
    );

    expect(result).toEqual({ ok: false, reason: 'generating', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('refuses an element with no provenance', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    expect(await applyImageSrc(projectId, { tagName: 'img' }, '/new.png'))
      .toEqual({ ok: false, reason: 'unresolvable', filesWritten: [] });
  });

  it('refuses when the file is gone', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: '/deleted.html:42', tagName: 'img' },
      '/new.png',
    );

    expect(result).toEqual({ ok: false, reason: 'missing-file', file: '/deleted.html', filesWritten: [] });
  });

  it('refuses an index that no longer names the same element', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    // A stale index usually still lands on *some* open tag — here, the `<body>` before the image.
    // Without the tag-name check this rewrites, or fails to find a src on, the wrong element.
    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<body'), tagName: 'img' },
      '/new.png',
    );

    expect(result).toEqual({ ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('refuses a src the template computes, and leaves the binding intact', async () => {
    const page = '<body><img src="{{hero.image}}"></body>';
    const projectId = await seed({ '/index.html': page });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', page, '<img'), tagName: 'img' },
      '/new.png',
    );

    expect(result).toEqual({ ok: false, reason: 'expression-src', file: '/index.html', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(page);
  });

  it('refuses an element that has no src at all', async () => {
    const page = '<body><img data-lazy="/a.png"></body>';
    const projectId = await seed({ '/index.html': page });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', page, '<img'), tagName: 'img' },
      '/new.png',
    );

    expect(result).toEqual({ ok: false, reason: 'no-src', file: '/index.html', filesWritten: [] });
  });

  it('does not write when the picked image is the one already there', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<img'), tagName: 'img' },
      '/old.png',
    );

    // Reported as done, with nothing written: the write is what forces a recompile, and one that
    // changes nothing would cost the user their toolbar and their scroll position for no reason.
    expect(result).toEqual({ ok: true, filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('writes normally, so the recompile that fixes every later provenance index happens', async () => {
    // The one thing that must not be copied from `applyStyleOverride`, which writes
    // `/overrides.css` with `{ silent: true }`. That file carries no provenance; this one does, and
    // every `data-osw-src` after the edit shifts by the length change.
    const projectId = await seed({ '/index.html': PAGE });
    const updateFile = vi.spyOn(vfs, 'updateFile');

    await applyImageSrc(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<img'), tagName: 'img' },
      '/a-much-longer-name.png',
    );

    expect(updateFile).toHaveBeenCalledTimes(1);
    const options = updateFile.mock.calls[0][3];
    expect(options?.silent).not.toBe(true);
  });
});
