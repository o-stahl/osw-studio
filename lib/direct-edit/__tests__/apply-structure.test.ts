// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { applyStructure, composePieces, insertMarkup, type StructureApplyResult } from '../apply-structure';
import { OVERRIDES_PATH } from '../apply-style';
import { declaredByScope, applyChanges, importantProperties, markerBlocksText, strengthenDeclarations } from '../overrides-css';
import { mapOffset } from '../structure';
import { MARKER_ATTR } from '../marker';
import type { RecordedWrite } from '../types';
import { placeholderAt } from '@/lib/semantic-blocks/placement';

// One IDBFactory for the file and one project per test, as in apply-style.test.ts: `vfs` caches its
// open database handle.
globalThis.indexedDB = new IDBFactory();

let projectSeq = 0;
async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Structure', 'fixture', `p-structure-${++projectSeq}`);
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}

const read = async (projectId: string, path: string) => String((await vfs.readFile(projectId, path)).content);
const src = (path: string, content: string, needle: string) => `${path}:${content.indexOf(needle)}`;

const PAGE = [
  '<html>',
  '<head>',
  '  <title>t</title>',
  '  <link rel="stylesheet" href="/overrides.css">',
  '</head>',
  '<body>',
  '  <main>',
  '    <h1 class="title">Hello</h1>',
  '    <p class="lead">Lead</p>',
  '  </main>',
  '</body>',
  '</html>',
  '',
].join('\n');

/** The selection a frame would send for the element at `needle` in `/index.html`. */
const pick = (needle: string, tagName: string) => ({ srcAttr: src('/index.html', PAGE, needle), tagName });

function ok(result: StructureApplyResult): StructureApplyResult {
  expect(result.ok, `refused: ${result.reason}`).toBe(true);
  return result;
}

/** The selected element, read out of the written file through the result's `select`. */
function selectedIn(content: string, result: StructureApplyResult, length: number): string {
  const offset = Number(result.select!.slice(result.select!.lastIndexOf(':') + 1));
  return content.slice(offset, offset + length);
}

describe('applyStructure', () => {
  it('moves an element and names where it now starts', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = ok(await applyStructure(projectId, pick('<p class="lead">', 'p'), {
      kind: 'move',
      place: { before: src('/index.html', PAGE, '<h1') },
    }));
    const written = await read(projectId, '/index.html');
    expect(written.indexOf('<p class="lead">')).toBeLessThan(written.indexOf('<h1'));
    expect(selectedIn(written, result, 16)).toBe('<p class="lead">');
    expect(result.filesWritten).toEqual(['/index.html']);
  });

  it('steps an element past its neighbour in the file, and refuses at the end', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = ok(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'step', dir: 1 }));
    const written = await read(projectId, '/index.html');
    expect(written.indexOf('<p class="lead">')).toBeLessThan(written.indexOf('<h1'));
    expect(result.patch!.op).toEqual({ kind: 'move', target: src('/index.html', PAGE, '<h1'), place: { after: src('/index.html', PAGE, '<p class="lead">') } });
    const again = await applyStructure(projectId, { srcAttr: result.select!, tagName: 'h1' }, { kind: 'step', dir: 1 });
    expect(again).toMatchObject({ ok: false, reason: 'no-place' });
  });

  it('records the page as one undoable write, before and after', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const writes: RecordedWrite[] = [];
    ok(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'delete' }, { record: w => writes.push(w) }));
    expect(writes).toEqual([{ path: '/index.html', before: PAGE, after: await read(projectId, '/index.html'), silent: false }]);
  });

  it('wraps in a frame with its starting styles in /overrides.css, and selects the frame', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = ok(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'wrap' }));
    const written = await read(projectId, '/index.html');
    const marker = /data-osw-frame data-osw-id="([a-z0-9]{8})"/.exec(written)![1];
    expect(selectedIn(written, result, 15)).toBe('<div data-osw-f');
    const css = await read(projectId, OVERRIDES_PATH);
    expect(declaredByScope(css, marker).get('all')).toMatchObject({ display: 'flex', 'flex-direction': 'column' });
    expect(result.css).toBe(css);
    expect(result.filesWritten).toEqual([OVERRIDES_PATH, '/index.html']);
  });

  it('gives a copy fresh markers with the original\'s override blocks', async () => {
    const page = PAGE.replace('<h1 class="title">', `<h1 ${MARKER_ATTR}="aaaaaaaa" class="title">`);
    const css = applyChanges(applyChanges('', 'aaaaaaaa', 'all', [{ property: 'color', value: 'red' }]), 'aaaaaaaa', 767, [{ property: 'font-size', value: '20px' }]);
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: css });
    const result = ok(await applyStructure(projectId, { srcAttr: src('/index.html', page, '<h1'), tagName: 'h1' }, { kind: 'duplicate' }));
    const written = await read(projectId, '/index.html');
    const ids = [...written.matchAll(/data-osw-id="([a-z0-9]{8})"/g)].map(m => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('aaaaaaaa');
    const fresh = ids[1];
    expect(fresh).not.toBe('aaaaaaaa');
    const blocks = declaredByScope(await read(projectId, OVERRIDES_PATH), fresh);
    expect(blocks.get('all')).toEqual({ color: 'red' });
    expect(blocks.get(767)).toEqual({ 'font-size': '20px' });
    expect(result.patch!.op).toEqual({ kind: 'duplicate', target: src('/index.html', page, '<h1'), ids: { aaaaaaaa: fresh } });
  });

  it('gives a copy fresh markers whatever the original\'s are called', async () => {
    for (const old of ['constructor', '__proto__']) {
      const page = PAGE.replace('<h1 class="title">', `<h1 ${MARKER_ATTR}="${old}" class="title">`);
      const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: applyChanges('', old, 'all', [{ property: 'color', value: 'red' }]) });
      const result = ok(await applyStructure(projectId, { srcAttr: src('/index.html', page, '<h1'), tagName: 'h1' }, { kind: 'duplicate' }));
      const ids = [...(await read(projectId, '/index.html')).matchAll(/data-osw-id="([^"]*)"/g)].map(m => m[1]);
      expect(ids[0]).toBe(old);
      expect(ids[1]).toMatch(/^[a-z0-9]{8}$/);
      expect(declaredByScope(await read(projectId, OVERRIDES_PATH), ids[1]).get('all')).toEqual({ color: 'red' });
      expect(result.patch!.op).toEqual({ kind: 'duplicate', target: src('/index.html', page, '<h1'), ids: { [old]: ids[1] } });
    }
  });

  it('gives a copy the !important its original needed to show', async () => {
    const page = PAGE.replace('<h1 class="title">', `<h1 ${MARKER_ATTR}="aaaaaaaa" class="title">`);
    const css = strengthenDeclarations(
      applyChanges(applyChanges('', 'aaaaaaaa', 'all', [{ property: 'color', value: 'red' }, { property: 'margin', value: '0' }]), 'aaaaaaaa', 767, [{ property: 'color', value: 'blue' }]),
      'aaaaaaaa', ['color'],
    );
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: css });
    ok(await applyStructure(projectId, { srcAttr: src('/index.html', page, '<h1'), tagName: 'h1' }, { kind: 'duplicate' }));
    const fresh = [...(await read(projectId, '/index.html')).matchAll(/data-osw-id="([a-z0-9]{8})"/g)].map(m => m[1])[1];
    const written = await read(projectId, OVERRIDES_PATH);
    expect(importantProperties(written, fresh)).toEqual(['color']);
    expect(markerBlocksText(written, fresh)).toContain('color: red !important;\n  margin: 0;');
    expect(markerBlocksText(written, fresh)).toContain('color: blue !important;');
  });

  it('refuses to duplicate, writing nothing, when the original\'s rules are where the writer will not edit them', async () => {
    const page = PAGE.replace('<h1 class="title">', `<h1 ${MARKER_ATTR}="aaaaaaaa" class="title">`);
    const commented = `/* old: [${MARKER_ATTR}="aaaaaaaa"] */\n[${MARKER_ATTR}="aaaaaaaa"][${MARKER_ATTR}] { color: red; }\n`;
    const nested = `@media (min-width: 40em) {\n  [${MARKER_ATTR}="aaaaaaaa"][${MARKER_ATTR}] { color: red; }\n}\n`;
    const holdsRule = `[${MARKER_ATTR}="aaaaaaaa"][${MARKER_ATTR}] {\n  color: red;\n  &:hover { color: blue; }\n}\n`;
    for (const css of [commented, nested, holdsRule]) {
      const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: css });
      const result = await applyStructure(projectId, { srcAttr: src('/index.html', page, '<h1'), tagName: 'h1' }, { kind: 'duplicate' });
      expect(result).toMatchObject({ ok: false, reason: 'ambiguous-stylesheet', file: OVERRIDES_PATH, filesWritten: [] });
      expect(result.message).toMatch(/Refusing to edit \/overrides\.css/);
      expect(await read(projectId, '/index.html')).toBe(page);
      expect(await read(projectId, OVERRIDES_PATH)).toBe(css);
    }
  });

  it('inserts a frame with its marker and starting styles, and maps the frame for the patch', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = ok(await applyStructure(projectId, null, {
      kind: 'insert',
      place: { parent: src('/index.html', PAGE, '<main>'), at: 'end' },
      element: 'frame',
    }));
    const written = await read(projectId, '/index.html');
    expect(written).toMatch(/ {4}<div data-osw-frame data-osw-id="[a-z0-9]{8}"><\/div>\n {2}<\/main>/);
    expect(result.patch!.created).toHaveLength(1);
    expect(written.slice(result.patch!.created[0], result.patch!.created[0] + 5)).toBe('<div ');
  });

  it('uses the project\'s own .btn, and styles a button only where there is none', async () => {
    const withBtn = await seed({ '/index.html': PAGE, '/style.css': '.btn { padding: 1rem; }' });
    const place = { kind: 'insert' as const, place: { after: src('/index.html', PAGE, '<p class="lead">') }, element: 'button' as const, text: 'Buy' };
    ok(await applyStructure(withBtn, null, place));
    expect(await read(withBtn, '/index.html')).toContain('<a class="btn" href="#">Buy</a>');
    expect(await vfs.fileExists(withBtn, OVERRIDES_PATH)).toBe(false);

    // A class that only starts with `btn` is not the project's `.btn`.
    const without = await seed({ '/index.html': PAGE, '/style.css': '.btn-primary { padding: 1rem; }' });
    ok(await applyStructure(without, null, place));
    expect(await read(without, '/index.html')).toMatch(/<a class="btn" data-osw-id="[a-z0-9]{8}" href="#">Buy<\/a>/);
    expect(await read(without, OVERRIDES_PATH)).toContain('inline-block');
  });

  it('links /overrides.css into a page that lacks it, and keeps the patch\'s offsets right', async () => {
    const bare = PAGE.replace('  <link rel="stylesheet" href="/overrides.css">\n', '');
    const projectId = await seed({ '/index.html': bare });
    const result = ok(await applyStructure(projectId, { srcAttr: src('/index.html', bare, '<h1'), tagName: 'h1' }, { kind: 'wrap' }));
    const written = await read(projectId, '/index.html');
    expect(written).toContain('/overrides.css');
    // The frame still holds the old offsets: every element it has must land on itself.
    for (const needle of ['<main>', '<h1', '<p class="lead">']) {
      const moved = mapOffset(result.patch!.pieces, bare.indexOf(needle))!;
      expect(written.slice(moved, moved + needle.length)).toBe(needle);
    }
    expect(selectedIn(written, result, 15)).toBe('<div data-osw-f');
    expect(result.patch!.created).toHaveLength(1);
    expect(written.slice(result.patch!.created[0], result.patch!.created[0] + 15)).toBe('<div data-osw-f');
  });

  it('links /overrides.css into the project\'s other pages when the edit adds styles', async () => {
    const other = '<html><head></head><body><p>other</p></body></html>';
    const projectId = await seed({ '/index.html': PAGE, '/about.html': other });
    const result = ok(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'wrap' }));
    expect(result.filesWritten).toEqual([OVERRIDES_PATH, '/index.html', '/about.html']);
    expect(await read(projectId, '/about.html')).toContain('<link rel="stylesheet" href="/overrides.css">');
  });

  it('asks before changing a partial, or a tag rendered several times, and sends no patch then', async () => {
    const partial = '<nav>\n  <a class="home">Home</a>\n</nav>\n';
    const projectId = await seed({ '/templates/nav.hbs': partial });
    const selection = { srcAttr: src('/templates/nav.hbs', partial, '<a'), tagName: 'a' };
    const asked = await applyStructure(projectId, selection, { kind: 'delete' });
    expect(asked).toMatchObject({ ok: false, reason: 'needs-confirmation', file: '/templates/nav.hbs' });
    expect(await read(projectId, '/templates/nav.hbs')).toBe(partial);

    const looped = await applyStructure(projectId, { ...selection, instanceCount: 3 }, { kind: 'delete' }, { confirmed: true });
    expect(looped.ok).toBe(true);
    expect(looped.patch).toBeUndefined();
    expect(await read(projectId, '/templates/nav.hbs')).toBe('<nav>\n</nav>\n');
  });

  it('sends a patch for a confirmed change to a partial the page renders once', async () => {
    const partial = '<nav>\n  <a class="home">Home</a>\n</nav>\n';
    const projectId = await seed({ '/templates/nav.hbs': partial });
    const selection = { srcAttr: src('/templates/nav.hbs', partial, '<a'), tagName: 'a' };
    const result = await applyStructure(projectId, selection, { kind: 'delete' }, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.patch).toMatchObject({ file: '/templates/nav.hbs', op: { kind: 'delete', target: selection.srcAttr } });
  });

  it('refuses a stale index, a move across files and a write while the agent runs', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': PAGE });
    expect(await applyStructure(projectId, { srcAttr: src('/index.html', PAGE, '<p class="lead">'), tagName: 'h1' }, { kind: 'delete' }))
      .toMatchObject({ ok: false, reason: 'stale-index' });
    expect(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'move', place: { before: src('/about.html', PAGE, '<p') } }))
      .toMatchObject({ ok: false, reason: 'cross-file' });
    expect(await applyStructure(projectId, pick('<h1', 'h1'), { kind: 'delete' }, { isGenerating: () => true }))
      .toMatchObject({ ok: false, reason: 'generating' });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });

  it('writes a Semantic block\'s placeholder at the place, by itself, and selects it', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const writes: RecordedWrite[] = [];
    const place = { after: src('/index.html', PAGE, '<h1') };
    const result = ok(await applyStructure(projectId, null, { kind: 'block', place, block: 'pricing', placementId: 'pricing-k3j9x2m1' }, {
      record: w => writes.push(w),
    }));
    const written = await read(projectId, '/index.html');
    // A line of its own between the heading and the lead, the block's name in it.
    expect(written).toContain('    <h1 class="title">Hello</h1>\n    <div data-osw-block="pricing-k3j9x2m1">Pricing</div>\n    <p class="lead">');
    const open = '<div data-osw-block="pricing-k3j9x2m1"';
    expect(selectedIn(written, result, open.length)).toBe(open);
    // It has no starting styles: /overrides.css is left alone, and the page is the one write to undo.
    expect(writes.map(w => w.path)).toEqual(['/index.html']);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
    // The frames show the same element at the same place before the recompile.
    expect(result.patch!.op).toEqual({ kind: 'insert', place, html: written.slice(result.patch!.created[0], written.indexOf('</div>') + 6) });
    expect(placeholderAt(written, 'pricing-k3j9x2m1')).toBe(result.patch!.created[0]);
  });

  it('refuses a block the registry lacks, or an id that would leave its attribute, and asks before a partial', async () => {
    const partial = '<nav>\n  <a class="home">Home</a>\n</nav>\n';
    const projectId = await seed({ '/index.html': PAGE, '/templates/nav.hbs': partial });
    const place = { after: src('/index.html', PAGE, '<h1') };
    expect(await applyStructure(projectId, null, { kind: 'block', place, block: 'no-such-block', placementId: 'no-such-block-k3j9x2m1' }))
      .toMatchObject({ ok: false, reason: 'unresolvable' });
    expect(await applyStructure(projectId, null, { kind: 'block', place, block: 'hero', placementId: 'hero-1" onclick="alert(1)' }))
      .toMatchObject({ ok: false, reason: 'unresolvable' });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
    expect(await applyStructure(projectId, null, { kind: 'block', place: { after: src('/templates/nav.hbs', partial, '<a') }, block: 'search-bar', placementId: 'search-bar-k3j9x2m1' }))
      .toMatchObject({ ok: false, reason: 'needs-confirmation', file: '/templates/nav.hbs' });
    expect(await read(projectId, '/templates/nav.hbs')).toBe(partial);
  });

  it('passes the structure refusals through', async () => {
    const locked = PAGE.replace('<main>', '<main data-osw-lock>');
    const projectId = await seed({ '/index.html': locked });
    expect(await applyStructure(projectId, { srcAttr: src('/index.html', locked, '<h1'), tagName: 'h1' }, { kind: 'delete' }))
      .toMatchObject({ ok: false, reason: 'locked' });
  });
});

describe('composePieces', () => {
  it('maps through both edits', () => {
    // "abcdef" -> remove "cd" -> "abef" -> insert "XY" at 1 -> "aXYbef"
    const first = [[0, 2], [4, 6]] as [number, number][];
    const second = [[0, 1], 2, [1, 4]] as ([number, number] | number)[];
    const both = composePieces(first, second);
    expect(mapOffset(both, 0)).toBe(0);
    expect(mapOffset(both, 1)).toBe(3);
    expect(mapOffset(both, 4)).toBe(4);
    expect(mapOffset(both, 2)).toBeNull();
  });
});

describe('insertMarkup', () => {
  it('gives every styled element a marker, and plain text none', () => {
    for (const kind of ['frame', 'image', 'divider'] as const) {
      const made = insertMarkup(kind, { markerId: 'mmmmmmmm' });
      expect(made.markup).toContain(`${MARKER_ATTR}="mmmmmmmm"`);
      expect(made.styles).not.toBeNull();
    }
    expect(insertMarkup('text', { text: 'a < b' })).toEqual({ markup: '<p>a &lt; b</p>', styles: null, marker: null });
  });
});
