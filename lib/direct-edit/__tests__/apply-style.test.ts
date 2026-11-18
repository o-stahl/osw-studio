// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import {
  applyStyleOverride,
  readMarkerOverrides,
  OVERRIDES_PATH,
} from '../apply-style';
import { MARKER_ATTR } from '../marker';

// One IDBFactory for the file, one project per test — the same arrangement as
// `lib/preview/__tests__/provenance-integration.test.ts`, and for the same reason: `vfs` is a
// module singleton that caches its open database handle, so swapping the factory between tests
// under a statically imported `vfs` leaves it talking to the discarded one.
globalThis.indexedDB = new IDBFactory();

let projectSeq = 0;

/** `createProject(name, description?, id?)` — the id is the third positional argument. */
async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Direct edit', 'fixture', `p-direct-${++projectSeq}`);
  for (const [path, content] of Object.entries(files)) {
    await vfs.createFile(project.id, path, content, { silent: true });
  }
  return project.id;
}

const read = async (projectId: string, path: string): Promise<string> =>
  String((await vfs.readFile(projectId, path)).content);

const src = (path: string, content: string, needle: string) =>
  `${path}:${content.indexOf(needle)}`;

const RED = { property: 'color', value: 'red' };

/** What the element declares for every width, as the panel reads it back. */
const allProps = async (projectId: string, markerId: string) =>
  Object.keys((await readMarkerOverrides(projectId, markerId)).byScope.get('all') ?? {});

afterEach(() => { vi.restoreAllMocks(); });

const PAGE = '<html><head><title>t</title></head><body><p class="a">hi</p></body></html>';
const OTHER = '<html><head></head><body><p>other</p></body></html>';

describe('applyStyleOverride — first edit', () => {
  it('stamps the marker, writes the rule, and links every page', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': OTHER });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [{ property: 'padding-block', value: '3rem' }],
    );

    expect(result.ok).toBe(true);
    expect(result.markerId).toMatch(/^[a-z0-9]{8}$/);

    const source = await read(projectId, '/index.html');
    // Both the marker AND the link in one file. Two writes would have clobbered one of them,
    // because the second write's content was read before the first landed.
    expect(source).toContain(`<p ${MARKER_ATTR}="${result.markerId}" class="a">hi</p>`);
    expect(source).toContain('href="/overrides.css"');
    expect(source.indexOf('/overrides.css')).toBeLessThan(source.indexOf('</head>'));

    const css = await read(projectId, OVERRIDES_PATH);
    expect(css).toContain(`[${MARKER_ATTR}="${result.markerId}"][${MARKER_ATTR}]`);
    expect(css).toContain('padding-block: 3rem;');

    expect(await read(projectId, '/about.html')).toContain('href="/overrides.css"');

    expect([...(result.filesWritten ?? [])].sort())
      .toEqual(['/about.html', '/index.html', OVERRIDES_PATH]);
    expect(result.skippedPages).toEqual([]);
  });

  it('writes the marker into the partial, not the page that includes it', async () => {
    const partial = '<nav><a href="/">Home</a></nav>';
    const projectId = await seed({
      '/index.html': '<html><head></head><body>{{> nav}}</body></html>',
      '/templates/nav.hbs': partial,
    });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/templates/nav.hbs', partial, '<nav'), tagName: 'nav', attributes: {} },
      [RED],
    );

    expect(result.ok).toBe(true);
    expect(await read(projectId, '/templates/nav.hbs'))
      .toBe(`<nav ${MARKER_ATTR}="${result.markerId}"><a href="/">Home</a></nav>`);
    // A partial must not grow a stylesheet link: it is included into a page's body. Nor may it be
    // reported as a page that could not be linked — every partial in the project would qualify, and
    // a warning that always fires is one the user learns to ignore.
    expect(await read(projectId, '/templates/nav.hbs')).not.toContain('overrides.css');
    expect(result.skippedPages).toEqual([]);
    // The including page still gets one, from the sweep.
    expect(await read(projectId, '/index.html')).toContain('href="/overrides.css"');
    expect(await read(projectId, '/index.html')).not.toContain(MARKER_ATTR);
  });
});

describe('applyStyleOverride — the second edit on the same element', () => {
  it('writes only /overrides.css, touching no source file', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': OTHER });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    const sourceAfterFirst = await read(projectId, '/index.html');
    const aboutAfterFirst = await read(projectId, '/about.html');

    // No srcAttr at all: the marker on the payload is the only thing that can locate this edit.
    const second = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: first.markerId! }, tagName: 'p' },
      [{ property: 'color', value: 'blue' }],
    );

    expect(second.ok).toBe(true);
    expect(second.markerId).toBe(first.markerId);
    expect(second.filesWritten).toEqual([OVERRIDES_PATH]);
    expect(await read(projectId, '/index.html')).toBe(sourceAfterFirst);
    expect(await read(projectId, '/about.html')).toBe(aboutAfterFirst);

    const css = await read(projectId, OVERRIDES_PATH);
    expect(css).toContain('color: blue;');
    expect(css).not.toContain('color: red;');
  });

  // What the Styles tab and `style` send after a render showed a change losing: the mark, in the
  // file, with no value of its own and no source write.
  it('marks the named properties !important, with the changes or alone', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED, { property: 'margin', value: '0' }],
    );
    const source = await read(projectId, '/index.html');
    const record = vi.fn();

    // By the remembered marker, as the tab has it before the frame recompiles.
    const marked = await applyStyleOverride(projectId, { tagName: 'p', attributes: {} }, [], {
      markerId: first.markerId!, strengthen: ['color'], confirmedMultiInstance: true, record,
    });
    expect(marked.ok).toBe(true);
    expect(marked.filesWritten).toEqual([OVERRIDES_PATH]);
    expect(marked.css).toContain('{\n  color: red !important;\n  margin: 0;\n}');
    expect(await read(projectId, OVERRIDES_PATH)).toBe(marked.css);
    expect(await read(projectId, '/index.html')).toBe(source);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ path: OVERRIDES_PATH, silent: true }));

    // Asked again, nothing is left to write.
    const again = await applyStyleOverride(projectId, { tagName: 'p', attributes: {} }, [], { markerId: first.markerId!, strengthen: ['color'], confirmedMultiInstance: true });
    expect(again.filesWritten).toEqual([]);

    // Together with a change: the new value carries the mark it was given in the same write.
    const both = await applyStyleOverride(projectId, { tagName: 'p', attributes: { [MARKER_ATTR]: first.markerId! } }, [{ property: 'gap', value: '4px' }], { strengthen: ['gap'] });
    expect(both.css).toContain('gap: 4px !important;');
  });

  it('reuses the marker already in source when the payload did not carry it', async () => {
    // `gatherAttributes` caps its output, so an attribute-heavy element can arrive without its
    // marker. The slow path must read the existing id back out of source rather than mint a second
    // one — a fresh id would key the rule to a marker that exists nowhere in the project.
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    const stamped = await read(projectId, '/index.html');

    const second = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', stamped, '<p'), tagName: 'p', attributes: {} },
      [{ property: 'color', value: 'blue' }],
    );

    expect(second.markerId).toBe(first.markerId);
    expect(second.filesWritten).toEqual([OVERRIDES_PATH]);
    expect(await read(projectId, '/index.html')).toBe(stamped);
  });
});

describe('applyStyleOverride — which write is silent', () => {
  it('writes source non-silently and /overrides.css silently', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': OTHER });
    const createSpy = vi.spyOn(vfs, 'createFile');
    const updateSpy = vi.spyOn(vfs, 'updateFile');

    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );

    const optionsFor = (spy: typeof updateSpy, path: string) =>
      spy.mock.calls.filter((call) => call[1] === path).map((call) => call[3]);

    // Source writes shift every data-osw-src index after the insertion point, and those indices are
    // already in the live document with nothing to correct them — so they must recompile.
    expect(optionsFor(updateSpy, '/index.html')).toHaveLength(1);
    expect(optionsFor(updateSpy, '/index.html')[0]?.silent).toBeFalsy();
    expect(optionsFor(updateSpy, '/about.html')[0]?.silent).toBeFalsy();
    // /overrides.css carries no provenance indices, so a silent write invalidates nothing.
    expect(optionsFor(createSpy, OVERRIDES_PATH)).toEqual([{ silent: true }]);

    updateSpy.mockClear();
    await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: first.markerId! }, tagName: 'p' },
      [{ property: 'color', value: 'blue' }],
    );
    // …and so does the update that follows the create.
    expect(optionsFor(updateSpy, OVERRIDES_PATH)).toEqual([{ silent: true }]);
  });
});

describe('applyStyleOverride — removals', () => {
  /** One element with two overrides on it, and the marker they are keyed to. */
  async function seedTwoOverrides(): Promise<{ projectId: string; markerId: string }> {
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: first.markerId! }, tagName: 'p' },
      [{ property: 'padding-block', value: '1rem' }],
    );
    return { projectId, markerId: first.markerId! };
  }

  it('removes just that declaration, leaving the block and the source alone', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    const source = await read(projectId, '/index.html');

    const result = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId },
    );

    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual([OVERRIDES_PATH]);
    const css = await read(projectId, OVERRIDES_PATH);
    expect(css).not.toContain('color: red;');
    expect(css).toContain('padding-block: 1rem;');
    // The marker and the <link> stay: both are inert on their own, and taking the marker out would
    // shift every data-osw-src index after it for a gesture the user thinks of as undoing a colour.
    expect(await read(projectId, '/index.html')).toBe(source);
  });

  it('takes the whole block out when the last declaration goes', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    const selection = { attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' };

    await applyStyleOverride(
      projectId,
      selection,
      [{ property: 'color', value: null }],
      { markerId },
    );
    await applyStyleOverride(
      projectId,
      selection,
      [{ property: 'padding-block', value: null }],
      { markerId },
    );

    const css = await read(projectId, OVERRIDES_PATH);
    expect(css).not.toContain(markerId);
    expect(css).not.toMatch(/\{\s*\}/);
  });

  it('writes /overrides.css silently, and writes no source file at all', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    const updateSpy = vi.spyOn(vfs, 'updateFile');

    await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId },
    );

    const paths = updateSpy.mock.calls.map(call => call[1]);
    expect(paths).toEqual([OVERRIDES_PATH]);
    expect(updateSpy.mock.calls[0][3]).toEqual({ silent: true });
  });

  it('links no page, even one without the link, when the selection resolves in source', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    await vfs.createFile(projectId, '/about.html', OTHER, { silent: true });
    const stamped = await read(projectId, '/index.html');
    const updateSpy = vi.spyOn(vfs, 'updateFile');

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', stamped, '<p'), attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId },
    );

    expect(result.filesWritten).toEqual([OVERRIDES_PATH]);
    expect(updateSpy.mock.calls.map(call => call[1])).toEqual([OVERRIDES_PATH]);
    expect(await read(projectId, '/about.html')).toBe(OTHER);
  });

  it('refuses a one-to-many removal without confirmation, and writes nothing', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    const before = await read(projectId, OVERRIDES_PATH);

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: '/templates/nav.hbs:0', instanceCount: 6, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('needs-confirmation');
    expect(result.instances).toBe(6);
    expect(result.filesWritten).toEqual([]);
    expect(await read(projectId, OVERRIDES_PATH)).toBe(before);
  });

  it('goes ahead on the same element once the user has confirmed', async () => {
    const { projectId, markerId } = await seedTwoOverrides();

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: '/templates/nav.hbs:0', instanceCount: 6, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId, confirmedMultiInstance: true },
    );

    expect(result.ok).toBe(true);
    expect(await read(projectId, OVERRIDES_PATH)).not.toContain('color: red;');
  });

  it('refuses while the agent is generating, and writes nothing', async () => {
    const { projectId, markerId } = await seedTwoOverrides();
    const before = await read(projectId, OVERRIDES_PATH);

    const result = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId, isGenerating: () => true },
    );

    expect(result.reason).toBe('generating');
    expect(result.filesWritten).toEqual([]);
    expect(await read(projectId, OVERRIDES_PATH)).toBe(before);
  });

  it('reports a stylesheet it cannot prove is ours rather than throwing', async () => {
    const projectId = await seed({
      '/index.html': PAGE,
      // The marker's selector inside a comment: the writer refuses this, and so must the remover.
      [OVERRIDES_PATH]: '/* [data-osw-id="aaaaaaaa"][data-osw-id] */\n.victim { color: hotpink; }\n',
    });
    const before = await read(projectId, OVERRIDES_PATH);

    const result = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: 'aaaaaaaa' }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId: 'aaaaaaaa' },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous-stylesheet');
    expect(result.filesWritten).toEqual([]);
    expect(await read(projectId, OVERRIDES_PATH)).toBe(before);
  });

  it('succeeds without writing when there is no override file at all', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: 'aaaaaaaa' }, tagName: 'p' },
      [{ property: 'color', value: null }],
      { markerId: 'aaaaaaaa' },
    );
    expect(result.ok).toBe(true);
    expect(result.filesWritten).toEqual([]);
  });
});

describe('applyStyleOverride — refusals write nothing', () => {
  it('refuses a one-to-many edit without confirmation', async () => {
    const partial = '<nav><a href="/">Home</a></nav>';
    const projectId = await seed({
      '/index.html': '<html><head></head><body>{{> nav}}</body></html>',
      '/templates/nav.hbs': partial,
    });

    const result = await applyStyleOverride(
      projectId,
      {
        srcAttr: src('/templates/nav.hbs', partial, '<nav'),
        tagName: 'nav',
        instanceCount: 6,
        attributes: {},
      },
      [RED],
    );

    expect(result).toEqual({
      ok: false,
      reason: 'needs-confirmation',
      file: '/templates/nav.hbs',
      instances: 6,
      filesWritten: [],
    });
    expect(await read(projectId, '/templates/nav.hbs')).toBe(partial);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('writes the one-to-many edit once it is confirmed', async () => {
    const partial = '<nav><a href="/">Home</a></nav>';
    const projectId = await seed({
      '/index.html': '<html><head></head><body>{{> nav}}</body></html>',
      '/templates/nav.hbs': partial,
    });

    const result = await applyStyleOverride(
      projectId,
      {
        srcAttr: src('/templates/nav.hbs', partial, '<nav'),
        tagName: 'nav',
        instanceCount: 6,
        attributes: {},
      },
      [RED],
      { confirmedMultiInstance: true },
    );

    expect(result.ok).toBe(true);
    expect(await read(projectId, '/templates/nav.hbs')).toContain(MARKER_ATTR);
    expect(await read(projectId, OVERRIDES_PATH)).toContain('color: red;');
  });

  it('refuses an unresolvable selection', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyStyleOverride(projectId, { tagName: 'p', attributes: {} }, [RED]);

    expect(result).toEqual({ ok: false, reason: 'unresolvable', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('refuses an index whose tag name no longer matches', async () => {
    // The stale index lands on a *different valid open tag* — which is the realistic failure, and
    // which a `<`-plus-letter check would wave through, stamping the marker onto the wrong element.
    const page = '<html><head></head><body><div id="wrap"><p>hi</p></div></body></html>';
    const projectId = await seed({ '/index.html': page });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', page, '<div'), tagName: 'p', attributes: {} },
      [RED],
    );

    expect(result).toEqual({
      ok: false, reason: 'stale-index', file: '/index.html', filesWritten: [],
    });
    expect(await read(projectId, '/index.html')).toBe(page);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('reports a deleted source file rather than throwing', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: '/gone.html:0', tagName: 'p', attributes: {} },
      [RED],
    );

    expect(result).toEqual({
      ok: false, reason: 'missing-file', file: '/gone.html', filesWritten: [],
    });
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('refuses while the agent is generating', async () => {
    const projectId = await seed({ '/index.html': PAGE });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
      { isGenerating: () => true },
    );

    expect(result).toEqual({ ok: false, reason: 'generating', filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('surfaces an ambiguous /overrides.css instead of rejecting', async () => {
    const hand = `/* [${MARKER_ATTR}="aaaaaaaa"][${MARKER_ATTR}] is mentioned here */\n` +
      '.victim { color: hotpink; }\n';
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: hand });

    const result = await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: 'aaaaaaaa' }, tagName: 'p' },
      [RED],
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ambiguous-stylesheet');
    expect(result.message).toMatch(/comment/i);
    expect(await read(projectId, OVERRIDES_PATH)).toBe(hand);
  });

  it('leaves a block holding a nested rule byte for byte, for a change and for a mark alone', async () => {
    const hand = `[${MARKER_ATTR}="aaaaaaaa"][${MARKER_ATTR}] {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n` +
      '.later { margin: 0; }\n';
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: hand });
    const selection = { attributes: { [MARKER_ATTR]: 'aaaaaaaa' }, tagName: 'p' };

    const changed = await applyStyleOverride(projectId, selection, [{ property: 'padding', value: '4px' }]);
    // What the Styles tab sends by itself after a render showed the colour losing.
    const marked = await applyStyleOverride(projectId, selection, [], { markerId: 'aaaaaaaa', strengthen: ['color'], confirmedMultiInstance: true });

    for (const result of [changed, marked]) {
      expect(result).toMatchObject({ ok: false, reason: 'ambiguous-stylesheet', filesWritten: [] });
      expect(result.message).toMatch(/nested/);
    }
    expect(await read(projectId, OVERRIDES_PATH)).toBe(hand);
    expect(await read(projectId, '/index.html')).toBe(PAGE);
  });
});

describe('applyStyleOverride — pages with no head', () => {
  it('still writes the rule and reports the page it could not link', async () => {
    const fragment = '<div class="frag"><p>hi</p></div>';
    const projectId = await seed({ '/index.html': PAGE, '/fragment.html': fragment });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );

    expect(result.ok).toBe(true);
    expect(result.skippedPages).toEqual(['/fragment.html']);
    expect(await read(projectId, '/fragment.html')).toBe(fragment);
    expect(await read(projectId, OVERRIDES_PATH)).toContain('color: red;');
  });

  it('reports the source page itself when it has no head', async () => {
    const fragment = '<div class="frag"><p>hi</p></div>';
    const projectId = await seed({ '/fragment.html': fragment });

    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/fragment.html', fragment, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );

    expect(result.ok).toBe(true);
    expect(result.skippedPages).toEqual(['/fragment.html']);
    expect(await read(projectId, '/fragment.html')).toContain(MARKER_ATTR);
    expect(await read(projectId, '/fragment.html')).not.toContain('overrides.css');
    expect(await read(projectId, OVERRIDES_PATH)).toContain('color: red;');
  });
});

describe('/overrides.css survives the export filters', () => {
  // Root and undotted placement is what makes it ship, and nothing else pins that. Both filters are
  // asserted against known-excluded paths first, so a broken harness fails loudly rather than
  // passing vacuously.
  it('is not excluded by lib/vfs/index.ts', () => {
    expect(vfs.shouldExcludeFromExportPublic('/data.json')).toBe(true);
    expect(vfs.shouldExcludeFromExportPublic('/templates/nav.hbs')).toBe(true);
    expect(vfs.shouldExcludeFromExportPublic('/.PROMPT.md')).toBe(true);
    expect(vfs.shouldExcludeFromExportPublic(OVERRIDES_PATH)).toBe(false);
  });

  it('is not excluded by lib/compiler/static-builder.ts', () => {
    // The predicate there is module-private and the module imports `fs` and the server adapters,
    // so it is lifted out of source rather than imported. If it ever stops being plain JS the
    // Function construction throws, and the vacuity guards below fail if it stops being the
    // predicate at all.
    const source = readFileSync(resolve(process.cwd(), 'lib/compiler/static-builder.ts'), 'utf8');
    const start = source.indexOf('function shouldExcludeFromExport(');
    expect(start, 'shouldExcludeFromExport not found in static-builder.ts').toBeGreaterThan(-1);

    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    let i = bodyStart;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) break;
    }
    const shouldExclude = new Function('filePath', source.slice(bodyStart + 1, i)) as
      (filePath: string) => boolean;

    expect(shouldExclude('/data.json')).toBe(true);
    expect(shouldExclude('/templates/nav.hbs')).toBe(true);
    expect(shouldExclude('/.PROMPT.md')).toBe(true);
    expect(shouldExclude('/src/app.css')).toBe(true);
    expect(shouldExclude(OVERRIDES_PATH)).toBe(false);
  });
});

describe('applyStyleOverride — the marker it stamps', () => {
  it('stamps the id the caller chose for an element that has none', async () => {
    // The panel picks it before the write so the frames can show the change on the element at once.
    const projectId = await seed({ '/index.html': PAGE });
    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
      { newMarkerId: 'chosen01' },
    );
    expect(result.markerId).toBe('chosen01');
    expect(await read(projectId, '/index.html')).toContain(`${MARKER_ATTR}="chosen01"`);
  });

  it('keeps the marker already in source over the chosen one', async () => {
    const page = `<html><head></head><body><p ${MARKER_ATTR}="existing">a</p></body></html>`;
    const projectId = await seed({ '/index.html': page });
    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', page, '<p'), tagName: 'p', attributes: {} },
      [RED],
      { newMarkerId: 'chosen01' },
    );
    expect(result.markerId).toBe('existing');
  });

  it('generates an id when the chosen one could not survive the attribute', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
      { newMarkerId: 'bad" id' },
    );
    expect(result.markerId).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe('applyStyleOverride — what a write reads', () => {
  it('sweeps the pages for the link without loading every file in the project', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': OTHER, '/img/big.svg': '<svg></svg>' });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    const listing = vi.spyOn(vfs, 'listDirectory');
    // `listFiles` hands back every file with its content, the image's included, without a `readFile` to count.
    const loadsAll = vi.spyOn(vfs, 'listFiles');
    const reads = vi.spyOn(vfs, 'readFile');

    await applyStyleOverride(projectId, { attributes: { [MARKER_ATTR]: first.markerId! }, tagName: 'p' }, [{ property: 'color', value: 'blue' }]);

    expect(listing).not.toHaveBeenCalled();
    expect(loadsAll).not.toHaveBeenCalled();
    // The stylesheet and the pages; never the image.
    expect(reads.mock.calls.map(call => call[1]).sort()).toEqual(['/about.html', '/index.html', OVERRIDES_PATH]);
    expect(await read(projectId, '/about.html')).toContain('/overrides.css');
  });

  it('leaves a page in a hidden folder unlinked', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/.drafts/old.html': OTHER });
    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    expect(result.filesWritten).toEqual(['/index.html', OVERRIDES_PATH]);
    expect(await read(projectId, '/.drafts/old.html')).toBe(OTHER);
  });
});

describe('readMarkerOverrides', () => {
  it('names what the element already overrides, so Reset survives a reload', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    await applyStyleOverride(
      projectId,
      { attributes: { [MARKER_ATTR]: first.markerId! }, tagName: 'p' },
      [{ property: 'padding-block', value: '1rem' }],
    );

    expect(await allProps(projectId, first.markerId!))
      .toEqual(['color', 'padding-block']);
    // Another element's marker owns none of it.
    expect(await allProps(projectId, 'bbbbbbbb')).toEqual([]);
  });

  it('answers [] when there is no override file at all', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
    expect(await allProps(projectId, 'aaaaaaaa')).toEqual([]);
  });

  it('answers [] rather than throwing on a file the writers would refuse', async () => {
    // The same nesting `removeDeclaration` refuses to edit. A read that threw here would take the
    // panel down over a hand-edited stylesheet.
    const projectId = await seed({
      '/index.html': PAGE,
      [OVERRIDES_PATH]:
        '@media (min-width: 40em) {\n  [data-osw-id="aaaaaaaa"][data-osw-id] { color: red; }\n}\n',
    });
    expect(await allProps(projectId, 'aaaaaaaa')).toEqual([]);
  });

  it('answers [] rather than reading a nested rule as a declaration', async () => {
    const projectId = await seed({
      '/index.html': PAGE,
      [OVERRIDES_PATH]: '[data-osw-id="aaaaaaaa"][data-osw-id] {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n',
    });
    expect(await allProps(projectId, 'aaaaaaaa')).toEqual([]);
  });
});

describe('applyStyleOverride — widths, batches and the journal', () => {
  const marked = (markerId: string) => ({ attributes: { [MARKER_ATTR]: markerId }, tagName: 'p' });

  it('writes into the width block it is given, and reads it back by width', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
    );
    const narrow = await applyStyleOverride(projectId, marked(first.markerId!), [{ property: 'color', value: 'blue' }], { scope: 640 });

    expect(narrow.ok).toBe(true);
    const read640 = await readMarkerOverrides(projectId, first.markerId!);
    expect(read640.byScope.get('all')).toEqual({ color: 'red' });
    expect(read640.byScope.get(640)).toEqual({ color: 'blue' });
    expect(read640.widths).toEqual([640]);
    expect(read640.text).toContain('@media (max-width: 640px)');
  });

  it('sets and removes in one write, and hands back the file as written', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const first = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [{ property: 'width', value: '320px' }],
    );
    const updateSpy = vi.spyOn(vfs, 'updateFile');

    const result = await applyStyleOverride(projectId, marked(first.markerId!), [
      { property: 'width', value: null },
      { property: 'flex', value: '1 1 0' },
    ]);

    expect(updateSpy.mock.calls.map((call) => call[1])).toEqual([OVERRIDES_PATH]);
    expect(result.css).toBe(await read(projectId, OVERRIDES_PATH));
    expect(await allProps(projectId, first.markerId!)).toEqual(['flex']);
  });

  it('removes without stamping an element that has no marker, writing nothing', async () => {
    const projectId = await seed({ '/index.html': PAGE });
    const result = await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [{ property: 'color', value: null }],
    );
    expect(result).toMatchObject({ ok: true, filesWritten: [] });
    expect(await read(projectId, '/index.html')).toBe(PAGE);
    expect(await vfs.fileExists(projectId, OVERRIDES_PATH)).toBe(false);
  });

  it('tells the recorder every file it wrote, with what was there before', async () => {
    const projectId = await seed({ '/index.html': PAGE, '/about.html': OTHER });
    const writes: { path: string; before: string | null; silent: boolean }[] = [];
    await applyStyleOverride(
      projectId,
      { srcAttr: src('/index.html', PAGE, '<p'), tagName: 'p', attributes: {} },
      [RED],
      { record: ({ path, before, silent }) => writes.push({ path, before, silent }) },
    );
    expect(writes).toEqual([
      { path: '/index.html', before: PAGE, silent: false },
      // Created by this write: an undo deletes it rather than leaving an empty file.
      { path: OVERRIDES_PATH, before: null, silent: true },
      { path: '/about.html', before: OTHER, silent: false },
    ]);
  });
});
