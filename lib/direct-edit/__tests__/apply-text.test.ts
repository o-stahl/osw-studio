// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { applyText, readSourceText } from '../apply-text';

/**
 * The read and write paths for Text.
 *
 * Same arrangement as `apply-image.test.ts`, and for the same reason: `vfs` is a module singleton
 * that caches its open database handle, so one IDBFactory for the file and one project per test.
 */
globalThis.indexedDB = new IDBFactory();

let projectSeq = 0;

async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Edit text', 'fixture', `p-text-${++projectSeq}`);
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

const PAGE = '<html><head></head><body><h1 class="hero">Old words</h1></body></html>';

describe('readSourceText', () => {
  it('reads what the element says, decoded', async () => {
    const page = '<body><h1>Ben &amp; Jerry</h1></body>';
    const projectId = await seed({ '/index.html': page });

    expect(await readSourceText(projectId, {
      srcAttr: src('/index.html', page, '<h1'), tagName: 'h1',
    })).toEqual({ ok: true, text: 'Ben & Jerry', file: '/index.html', instances: 1 });
  });

  it('reports how many elements share the tag rather than refusing', async () => {
    const page = '<body>{{#each cards}}<p>Learn more</p>{{/each}}</body>';
    const projectId = await seed({ '/index.html': page });

    // The user is allowed to see what a shared partial says before deciding to change every copy.
    expect(await readSourceText(projectId, {
      srcAttr: src('/index.html', page, '<p'), tagName: 'p', instanceCount: 3,
    })).toEqual({ ok: true, text: 'Learn more', file: '/index.html', instances: 3 });
  });

  it('refuses a run that shares its range with markup', async () => {
    const page = '<body><p>Hello <strong>you</strong></p></body>';
    const projectId = await seed({ '/index.html': page });

    expect(await readSourceText(projectId, {
      srcAttr: src('/index.html', page, '<p'), tagName: 'p',
    })).toEqual({ ok: false, reason: 'has-children', file: '/index.html' });
  });

  it('refuses an element with no provenance', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    expect(await readSourceText(projectId, { tagName: 'h1' }))
      .toEqual({ ok: false, reason: 'unresolvable' });
  });
});

describe('applyText', () => {
  it('writes the new text at the provenance index and reports the file it wrote', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<h1'), tagName: 'h1' },
      'New words',
    );

    expect(result).toEqual({ ok: true, file: '/index.html', filesWritten: ['/index.html'] });
    expect(await read(projectId, '/index.html'))
      .toBe('<html><head></head><body><h1 class="hero">New words</h1></body></html>');
  });

  it('tells the recorder what the page held before and after, for undo', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const writes: unknown[] = [];
    await applyText(projectId, { srcAttr: src('/index.html', PAGE, '<h1'), tagName: 'h1' }, 'New words', {
      record: (write) => writes.push(write),
    });
    expect(writes).toEqual([{
      path: '/index.html',
      before: PAGE,
      after: '<html><head></head><body><h1 class="hero">New words</h1></body></html>',
      silent: false,
    }]);
  });

  it('writes the one index it was given, not the first identical run in the file', async () => {
    // The design, end to end. Three identical paragraphs are three provenance indices, and the user
    // selected the third — an implementation that searched for the string would rewrite the first.
    const page = '<div><p>Learn more</p><p>Learn more</p><p>Learn more</p></div>';
    const projectId = await seed({ '/index.html': page });

    await applyText(
      projectId,
      { srcAttr: `/index.html:${page.lastIndexOf('<p>')}`, tagName: 'p' },
      'Read on',
    );

    expect(await read(projectId, '/index.html'))
      .toBe('<div><p>Learn more</p><p>Learn more</p><p>Read on</p></div>');
  });

  it('writes into the partial the text came from, not the page that includes it', async () => {
    const partial = '<header><h2>Welcome</h2></header>';
    const projectId = await seed({
      '/index.html': '<html><head></head><body>{{> header}}</body></html>',
      '/templates/header.hbs': partial,
    });

    const result = await applyText(
      projectId,
      { srcAttr: src('/templates/header.hbs', partial, '<h2'), tagName: 'h2' },
      'Hello',
    );

    expect(result.filesWritten).toEqual(['/templates/header.hbs']);
    expect(await read(projectId, '/templates/header.hbs')).toBe('<header><h2>Hello</h2></header>');
    expect(await read(projectId, '/index.html')).not.toContain('Hello');
  });

  it('holds a multi-instance write until it is confirmed, then performs it', async () => {
    const page = '<body>{{#each cards}}<p>Learn more</p>{{/each}}</body>';
    const projectId = await seed({ '/index.html': page });
    const selection = {
      srcAttr: src('/index.html', page, '<p'),
      tagName: 'p',
      instanceCount: 3,
    };

    const held = await applyText(projectId, selection, 'Read on');

    // One source tag rendering three paragraphs: retyping "this one" retypes all three, so the
    // refusal is the point. Nothing may reach the file before the user has been told the number.
    expect(held).toEqual({
      ok: false,
      reason: 'needs-confirmation',
      file: '/index.html',
      instances: 3,
      filesWritten: [],
    });
    expect(await read(projectId, '/index.html')).toBe(page);

    const confirmed = await applyText(projectId, selection, 'Read on', {
      confirmedMultiInstance: true,
    });

    expect(confirmed.ok).toBe(true);
    expect(await read(projectId, '/index.html'))
      .toBe('<body>{{#each cards}}<p>Read on</p>{{/each}}</body>');
  });

  it('refuses while the agent is generating, before reading anything', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<h1'), tagName: 'h1' },
      'New words',
      { isGenerating: () => true },
    );

    expect(result).toEqual({ ok: false, reason: 'generating', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('refuses an element with no provenance', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    expect(await applyText(projectId, { tagName: 'h1' }, 'New words'))
      .toEqual({ ok: false, reason: 'unresolvable', filesWritten: [] });
  });

  it('refuses when the file is gone', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    expect(await applyText(projectId, { srcAttr: '/deleted.html:42', tagName: 'h1' }, 'x'))
      .toEqual({ ok: false, reason: 'missing-file', file: '/deleted.html', filesWritten: [] });
  });

  it('refuses an index that no longer names the same element', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    // A stale index usually still lands on *some* open tag — here, the `<body>` before the heading.
    // Without the tag-name check this rewrites the whole body's content.
    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<body'), tagName: 'h1' },
      'New words',
    );

    expect(result).toEqual({ ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('refuses a run the template computes, and leaves the expression intact', async () => {
    const page = '<body><h1>{{page.title}}</h1></body>';
    const projectId = await seed({ '/index.html': page });

    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', page, '<h1'), tagName: 'h1' },
      'New words',
    );

    expect(result).toEqual({ ok: false, reason: 'has-expression', file: '/index.html', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(page);
  });

  it('refuses a run that shares its range with markup, and leaves the markup intact', async () => {
    const page = '<body><p>Hello <strong>you</strong></p></body>';
    const projectId = await seed({ '/index.html': page });

    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', page, '<p'), tagName: 'p' },
      'Hello everyone',
    );

    expect(result).toEqual({ ok: false, reason: 'has-children', file: '/index.html', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(page);
  });

  it('refuses a void element', async () => {
    // The kind decision is made in the frame against the live element, so a `text` press is only
    // evidence of what the bar showed. This path must answer for an `<img>` rather than assume it
    // cannot arrive.
    const page = '<body><img src="/a.png"></body>';
    const projectId = await seed({ '/index.html': page });

    expect(await applyText(projectId, { srcAttr: src('/index.html', page, '<img'), tagName: 'img' }, 'x'))
      .toEqual({ ok: false, reason: 'void-element', file: '/index.html', filesWritten: [] });
  });

  it('does not write when the text is the one already there', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyText(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<h1'), tagName: 'h1' },
      'Old words',
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

    await applyText(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<h1'), tagName: 'h1' },
      'A considerably longer heading than the one that was there',
    );

    expect(updateFile).toHaveBeenCalledTimes(1);
    const options = updateFile.mock.calls[0][3];
    expect(options?.silent).not.toBe(true);
  });
});
