// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// VirtualServer makes a blob URL per asset; jsdom has no implementation.
URL.createObjectURL = (() => 'blob:http://localhost/x') as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

// The page is rendered to check a change is in force; jsdom lays nothing out, so each test says what
// the render answers. By default there is none, as on a server with no tab connected.
const renderPage = vi.hoisted(() => vi.fn());
vi.mock('@/lib/canvas/render-job', () => ({ renderPage }));

import { vfs } from '@/lib/vfs';
import { styleCommand, parseDeclarations } from '../commands/style';
import type { RenderJob, RenderResult, InspectStyle } from '@/lib/canvas/render-types';
import { OVERRIDES_PATH, OVERRIDES_WRITTEN_EVENT } from '@/lib/direct-edit/apply-style';
import { setEditHistory } from '@/lib/direct-edit/edit-history';
import { cheerioMatcher } from '@/lib/server-generate/match-elements';
import { domMatcher } from '@/lib/direct-edit/targets';
import { parseBashCommand } from '@/lib/llm/bash-command';

/**
 * The agent's `style` command: it finds the element the way the focus block and `inspect` name it,
 * and writes through the Styles tab's own path (`applyStyleOverride`), so the result is checked as
 * files — the marker in source, the rule in `/overrides.css` at the right width — not as output.
 */

globalThis.indexedDB = new IDBFactory();
let seq = 0;

async function seed(files: Record<string, string>, runtime: 'static' | 'handlebars' = 'static'): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Style', 'fixture', `p-style-${++seq}`);
  await vfs.updateProject({ ...project, settings: { ...project.settings, runtime } });
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}

/** The render answers with these rows for the element, whatever was asked. */
function rendersWith(styles: (job: RenderJob) => InspectStyle[]): void {
  renderPage.mockImplementation(async (job: RenderJob): Promise<RenderResult> => ({
    ok: true,
    kind: 'inspect',
    report: {
      page: job.page, width: job.width, height: 900, pageHeight: 2000, matches: 1,
      node: { tag: 'h1', classes: [], src: '/index.html:1', marker: job.target?.slice(1) ?? null, box: { x: 0, y: 0, w: 10, h: 10 } },
      styles: styles(job),
    },
  }));
}

const read = async (projectId: string, path: string) => String((await vfs.readFile(projectId, path)).content);
const run = (projectId: string, ...args: string[]) => styleCommand({ vfs, projectId, args });

const PAGE = [
  '<html><head><title>t</title><link rel="stylesheet" href="/styles.css"></head><body>',
  '  <section class="hero">',
  '    <h1>Fresh bread</h1>',
  '    <p class="lead">Every day</p>',
  '  </section>',
  '  <ul><li class="card">a</li><li class="card">b</li></ul>',
  '</body></html>',
].join('\n');
const CSS = '.hero { padding: 48px; }\n@media (max-width: 767px) { .hero { padding: 24px; } }\n';

beforeEach(() => {
  renderPage.mockReset();
  renderPage.mockResolvedValue({ ok: false, error: 'no renderer' });
});

afterEach(() => {
  vi.restoreAllMocks();
  setEditHistory(null);
});

describe('style, by selector on a page', () => {
  it('stamps the element, writes its rule for every width, and names it', async () => {
    const id = await seed({ '/index.html': PAGE, '/styles.css': CSS });
    const out = await run(id, '/index.html', '.hero h1', 'font-size=36px', 'letter-spacing=-0.02em');
    expect(out.exitCode, out.stderr).toBe(0);
    const html = await read(id, '/index.html');
    const marker = html.match(/<h1 data-osw-id="([a-z0-9]+)"/)?.[1];
    expect(marker).toBeTruthy();
    const css = await read(id, OVERRIDES_PATH);
    expect(css).toContain(`[data-osw-id="${marker}"][data-osw-id] {\n  font-size: 36px;\n  letter-spacing: -0.02em;\n}`);
    // Line 3, column 5: where the tag starts, as rg -n and the selected-element block give it.
    expect(out.stdout).toContain(`Styled <h1> /index.html:3:5 (marker @${marker}).`);
    expect(html).toContain('<link rel="stylesheet" href="/overrides.css">');
  });

  it('puts a change at a width in the block of the breakpoint that width falls under', async () => {
    const id = await seed({ '/index.html': PAGE, '/styles.css': CSS });
    const out = await run(id, '/index.html', '.hero', 'padding-block=28px 24px', '--width', '375');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, OVERRIDES_PATH)).toMatch(/@media \(max-width: 767px\) \{\n  \[data-osw-id="[a-z0-9]+"\]\[data-osw-id\] \{\n    padding-block: 28px 24px;/);
    expect(out.stdout).toContain('at widths up to 767 px');
  });

  it('says so when the width is wider than every breakpoint', async () => {
    const id = await seed({ '/index.html': PAGE, '/styles.css': CSS });
    const out = await run(id, '/index.html', '.hero', 'gap=20px', '--width=1440');
    expect(out.stdout).toContain('1440 px is wider than every breakpoint of the project, so this applies at every width.');
    expect(await read(id, OVERRIDES_PATH)).not.toMatch(/@media \(max-width: \d+px\)/);
  });

  it('says so when the project has no breakpoints to put a width under', async () => {
    const id = await seed({ '/index.html': PAGE });
    const out = await run(id, '/index.html', '.hero', 'gap=20px', '--width', '375');
    expect(out.stdout).toContain('The project has no breakpoints, so this applies at every width.');
  });

  it('refuses a selector that matches several source tags, and lists them', async () => {
    const id = await seed({ '/index.html': PAGE });
    const out = await run(id, '/index.html', '.card', 'color=red');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('matches 2 elements on /index.html, written in 2 places');
    expect(out.stderr).toContain('<li>  /index.html:6:7');
    expect(out.stderr).toContain('<li>  /index.html:6:30');
    expect(out.stderr).toContain('edit the rule for ".card" in the project\'s stylesheet');
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });

  it('refuses a selector that matches nothing, and one the parser rejects', async () => {
    const id = await seed({ '/index.html': PAGE });
    expect((await run(id, '/index.html', '.nope', 'color=red')).stderr).toContain('nothing on /index.html matches ".nope"');
    expect((await run(id, '/index.html', '.hero >>', 'color=red')).stderr).toContain('is not a selector the parser accepts');
  });

  it('takes a selector with a pseudo-class, and still asks for a selector when a declaration comes first', async () => {
    const id = await seed({ '/index.html': PAGE });
    const first = await run(id, '/index.html', 'li:first-child', 'color=red');
    expect(first.exitCode, first.stderr).toBe(0);
    expect(await read(id, '/index.html')).toMatch(/<ul><li data-osw-id="[a-z0-9]+" class="card">a<\/li><li class="card">b/);
    const nth = await run(id, '/index.html', 'section p:nth-of-type(1)', 'margin=0');
    expect(nth.exitCode, nth.stderr).toBe(0);
    expect(await read(id, '/index.html')).toMatch(/<p data-osw-id="[a-z0-9]+" class="lead">/);
    for (const words of [['color=red'], ['margin: 0 auto'], ['color:', 'red']]) {
      const missing = await run(id, '/index.html', ...words);
      expect(missing.exitCode, words.join(' ')).toBe(1);
      expect(missing.stderr, words.join(' ')).toContain('say which element of /index.html');
    }
  });

  it('styles an element in a partial, and says it applies wherever the partial is used', async () => {
    const page = '<html><head></head><body>{{> nav}}<main>hi</main></body></html>';
    const nav = '<nav class="site">\n  <a href="/">Home</a>\n</nav>';
    const id = await seed({ '/index.html': page, '/templates/nav.hbs': nav }, 'handlebars');
    const out = await run(id, '/', 'nav.site', 'gap=12px');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, '/templates/nav.hbs')).toMatch(/^<nav data-osw-id="[a-z0-9]+" class="site">/);
    expect(out.stdout).toContain('It is in the partial /templates/nav.hbs, so this applies on every page that includes it.');
  });
});

describe('style, by marker and by position', () => {
  it('writes only /overrides.css for an element that already has its marker', async () => {
    const linked = PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">').replace('</head>', '<link rel="stylesheet" href="/overrides.css"></head>');
    const id = await seed({ '/index.html': linked });
    const update = vi.spyOn(vfs, 'updateFile');
    const out = await run(id, '@h1abc123', 'color: #222; font-weight: 700');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(update.mock.calls.map(call => call[1])).not.toContain('/index.html');
    expect(await read(id, OVERRIDES_PATH)).toContain('[data-osw-id="h1abc123"][data-osw-id] {\n  color: #222;\n  font-weight: 700;\n}');
  });

  it('takes a line, as rg -n prints it, for the one element that starts there', async () => {
    const id = await seed({ '/index.html': PAGE });
    const out = await run(id, '/index.html:4', 'margin-top=0');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, '/index.html')).toMatch(/<p data-osw-id="[a-z0-9]+" class="lead">/);
  });

  it('takes a line and column, as the selected-element block and inspect print it', async () => {
    const id = await seed({ '/index.html': PAGE });
    const out = await run(id, '/index.html:6:30', 'color=red');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, '/index.html')).toMatch(/<li class="card">a<\/li><li data-osw-id="[a-z0-9]+" class="card">b/);
  });

  it('takes a position in a file whose name has a space, quoted as the selected-element hint quotes it', async () => {
    const id = await seed({ '/blog posts/first post.html': PAGE });
    const args = parseBashCommand(`style '/blog posts/first post.html:3:5' color=red`).slice(1);
    const out = await run(id, ...args);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, '/blog posts/first post.html')).toMatch(/<h1 data-osw-id="[a-z0-9]+">Fresh bread/);
  });

  it('lists the elements of a line that has several, and the ones near a line that has none', async () => {
    const id = await seed({ '/index.html': PAGE });
    const several = await run(id, '/index.html:6', 'color=red');
    expect(several.exitCode).toBe(1);
    expect(several.stderr).toContain('3 elements start on line 6 of /index.html');
    expect(several.stderr).toContain('<ul>  /index.html:6:3');
    expect(several.stderr).toContain('<li>  /index.html:6:30');
    const none = await run(id, '/index.html:6:9', 'color=red');
    expect(none.stderr).toContain('no element starts at /index.html:6:9');
    const past = await run(id, '/index.html:40', 'color=red');
    expect(past.stderr).toContain('/index.html has 7 lines; there is no line 40');
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });

  it('refuses a marker no element carries', async () => {
    const id = await seed({ '/index.html': PAGE });
    expect((await run(id, '@zzzz9999', 'color=red')).stderr).toContain('no element carries the marker @zzzz9999');
  });

  it('refuses a marker two elements carry, names both, and writes nothing', async () => {
    const page = PAGE.replace('<h1>', '<h1 data-osw-id="dup00001">').replace('<p class="lead">', '<p data-osw-id="dup00001" class="lead">');
    const id = await seed({ '/index.html': page });
    const out = await run(id, '@dup00001', 'color=red');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('style: the marker @dup00001 is on 2 elements (<h1> /index.html:3:5, <p> /index.html:4:5), so they share its styles. Name one by its position, or give all but one a marker of their own by removing data-osw-id="dup00001" from them');
    expect(await read(id, '/index.html')).toBe(page);
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });
});

describe('removing', () => {
  it('takes a property off with prop=, and clears a width with --clear', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">'), '/styles.css': CSS });
    await run(id, '@h1abc123', 'color=red', 'gap=4px');
    await run(id, '@h1abc123', 'padding=0', '--width', '375');
    const removed = await run(id, '@h1abc123', 'color=');
    expect(removed.stdout).toContain('Removed at every width: color');
    expect(await read(id, OVERRIDES_PATH)).not.toContain('color: red');
    const cleared = await run(id, '@h1abc123', '--clear', '--width', '375');
    expect(cleared.exitCode, cleared.stderr).toBe(0);
    const css = await read(id, OVERRIDES_PATH);
    expect(css).not.toMatch(/@media \(max-width: \d+px\)/);
    expect(css).toContain('gap: 4px');
  });

  it('clears every width with --clear alone, in one undo step, and says what went where', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">'), '/styles.css': CSS });
    await run(id, '@h1abc123', 'color=red', 'gap=4px');
    await run(id, '@h1abc123', 'padding=0', '--width', '375');
    expect(await read(id, OVERRIDES_PATH)).toMatch(/@media \(max-width: 767px\)/);
    const record = vi.fn();
    setEditHistory({ projectId: id, record, undoAt: () => null, redoAt: () => null, undo: () => {}, redo: () => {} });
    const cleared = await run(id, '@h1abc123', '--clear');
    expect(cleared.exitCode, cleared.stderr).toBe(0);
    const css = await read(id, OVERRIDES_PATH);
    expect(css).not.toContain('h1abc123');
    expect(css).not.toMatch(/@media \(max-width: \d+px\)/);
    expect(cleared.stdout).toContain('Removed at every width: color, gap');
    expect(cleared.stdout).toContain('Removed at widths up to 767 px (@media (max-width: 767px)): padding');
    expect(record).toHaveBeenCalled();
    expect(new Set(record.mock.calls.map(call => call[0])).size).toBe(1);
    expect((await run(id, '@h1abc123', '--clear')).stdout).toBe('<h1> /index.html:3:5 has no overrides.');
  });

  it('refuses --all, which says nothing a missing --width does not', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    const out = await run(id, '@h1abc123', 'color=red', '--all');
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('unknown option --all');
  });
});

describe('what it refuses to write', () => {
  it('refuses a non-declaration, and nothing to change', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    expect((await run(id, '@h1abc123', 'red')).stderr).toContain('"red" is not a declaration');
    expect((await run(id, '@h1abc123')).stderr).toContain('nothing to change on <h1>');
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });

  // `!important` is the check's to add, where a rule of the project would win. Given by the caller
  // it is taken off and the change written, where it used to be refused and cost a turn.
  it('takes !important off a value instead of refusing it', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    expect((await run(id, '@h1abc123', 'color=red !important')).exitCode).toBe(0);
    // As a shell hands it over: the flag a word of its own.
    expect((await run(id, '@h1abc123', 'gap=4px', '!important', 'margin: 0 !important;')).exitCode).toBe(0);
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  color: red;\n  gap: 4px;\n  margin: 0;\n}');
  });

  it('takes a custom property written --name=value or "--name: value" as a declaration, not an option', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    const out = await run(id, '@h1abc123', '--accent=#f00', '--gap: 4px', '--edge:', '2px');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  --accent: #f00;\n  --gap: 4px;\n  --edge: 2px;\n}');
  });
});

describe('--sweep', () => {
  it('removes the rules of markers no file has, and keeps the rest', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="live1234">') });
    await run(id, '@live1234', 'color=red');
    const css = await read(id, OVERRIDES_PATH);
    await vfs.updateFile(id, OVERRIDES_PATH, `${css}[data-osw-id="gone5678"][data-osw-id] {\n  color: blue;\n}\n`, { silent: true });
    const out = await run(id, '--sweep');
    expect(out.stdout).toContain('Removed the rules of 1 element no file has any more: @gone5678.');
    const after = await read(id, OVERRIDES_PATH);
    expect(after).toContain('live1234');
    expect(after).not.toContain('gone5678');
  });
});

describe('in the tab that has the project open', () => {
  it('records the write in the Inspector\'s undo history, and sends the rules to the frames', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    const record = vi.fn();
    setEditHistory({ projectId: id, record, undoAt: () => null, redoAt: () => null, undo: () => {}, redo: () => {} });
    const sent: { projectId: string; css: string }[] = [];
    const listen = (event: Event) => sent.push((event as CustomEvent).detail);
    window.addEventListener(OVERRIDES_WRITTEN_EVENT, listen);
    await run(id, '@h1abc123', 'color=red');
    window.removeEventListener(OVERRIDES_WRITTEN_EVENT, listen);
    expect(record).toHaveBeenCalledWith(expect.stringMatching(/^agent-style:/), 'style', expect.objectContaining({ path: OVERRIDES_PATH, before: null }));
    expect(sent).toEqual([{ projectId: id, css: await read(id, OVERRIDES_PATH) }]);
  });

  it('leaves another project\'s history alone', async () => {
    const id = await seed({ '/index.html': PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">') });
    const record = vi.fn();
    setEditHistory({ projectId: 'someone-else', record, undoAt: () => null, redoAt: () => null, undo: () => {}, redo: () => {} });
    await run(id, '@h1abc123', 'color=red');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('parseDeclarations', () => {
  it('reads prop=value and "prop: value; …" alike, and an empty value as a removal', () => {
    expect(parseDeclarations(['Font-Size=36px', 'background: url(https://x.test/a.png); --Brand: #f00', 'gap='])).toEqual([
      { property: 'font-size', value: '36px' },
      { property: 'background', value: 'url(https://x.test/a.png)' },
      { property: '--Brand', value: '#f00' },
      { property: 'gap', value: null },
    ]);
  });

  it('puts back together a value the shell split on its spaces, and spells camelCase as CSS does', () => {
    expect(parseDeclarations(['margin=0', 'auto', 'font-size:', '36px', 'fontWeight=700', 'gap=4px'])).toEqual([
      { property: 'margin', value: '0 auto' },
      { property: 'font-size', value: '36px' },
      { property: 'font-weight', value: '700' },
      { property: 'gap', value: '4px' },
    ]);
  });
});

describe('checking that the change is in force', () => {
  const linked = PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123">').replace('</head>', '<link rel="stylesheet" href="/overrides.css"></head>');
  const ours = { value: 'x', selector: '[data-osw-id="h1abc123"][data-osw-id]', origin: '/overrides.css', ours: true };

  it('renders the page at the width written for and says the change is in force', async () => {
    const id = await seed({ '/index.html': linked, '/styles.css': CSS });
    rendersWith(job => (job.props ?? []).map(property => ({ property, computed: '10px', declared: ours })));
    const out = await run(id, '@h1abc123', 'padding=10px', '--width', '375');
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'inspect', page: '/index.html', width: 375, target: '@h1abc123',
      props: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    }));
    expect(out.stdout).toContain('Checked on /index.html at 375 px: in force.');
  });

  /**
   * A render that answers from the file as it stands, as a browser does: `property` goes to `winner`
   * unless the override declares it `!important`, or always when the winner is `!important` itself.
   */
  function rendersFromFile(id: string, property: string, winner: { selector: string; origin: string; important?: boolean }, computed = 'theirs'): void {
    renderPage.mockImplementation(async (job: RenderJob): Promise<RenderResult> => {
      const css = (await vfs.fileExists(id, OVERRIDES_PATH)) ? await read(id, OVERRIDES_PATH) : '';
      const strong = new RegExp(`${property}: [^;]* !important;`).test(css);
      const styles = (job.props ?? []).map((name): InspectStyle => name === property && (winner.important || !strong)
        ? { property: name, computed, declared: { value: computed, selector: winner.selector, origin: winner.origin } }
        : { property: name, computed: 'ours', declared: ours });
      return {
        ok: true, kind: 'inspect',
        report: { page: job.page, width: job.width, height: 900, pageHeight: 2000, matches: 1, node: { tag: 'h1', classes: [], src: '/index.html:1', marker: 'h1abc123', box: { x: 0, y: 0, w: 10, h: 10 } }, styles },
      };
    });
  }

  it('marks a change !important when a stronger rule of the project wins, and reads the page again', async () => {
    const id = await seed({ '/index.html': linked });
    rendersFromFile(id, 'text-align', { selector: '#services h1', origin: '/styles.css' });
    const out = await run(id, '@h1abc123', 'color=black', 'text-align=left');
    expect(out.exitCode).toBe(0);
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(out.stdout).toContain('Checked on /index.html at 1440 px: in force.');
    expect(out.stdout).toContain('text-align was losing to the rule "#services h1" in /styles.css, so it is marked !important in /overrides.css.');
    expect(out.stdout).not.toContain('NOT APPLIED');
    // Only the declaration that was losing: the other stays an ordinary one.
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  color: black;\n  text-align: left !important;\n}');
  });

  it('reads the page once when nothing loses', async () => {
    const id = await seed({ '/index.html': linked });
    rendersWith(job => (job.props ?? []).map(property => ({ property, computed: 'x', declared: ours })));
    await run(id, '@h1abc123', 'color=black');
    expect(renderPage).toHaveBeenCalledTimes(1);
    // The block, not the file: the file's header speaks of the mark.
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  color: black;\n}');
  });

  it('takes back a change that still loses to an !important rule, and keeps the ones in force', async () => {
    const id = await seed({ '/index.html': linked });
    rendersFromFile(id, 'text-align', { selector: '#services h1', origin: '/styles.css', important: true }, 'center');
    const out = await run(id, '@h1abc123', 'color=black', 'text-align=left');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('Checked on /index.html at 1440 px: color in force.');
    expect(out.stdout).toContain('NOT APPLIED: text-align (text-align is still center): the rule "#services h1" in /styles.css sets it with !important and a stronger selector. Change that rule instead. The override for text-align was taken out again.');
    expect(out.stdout).not.toContain('was losing');
    const css = await read(id, OVERRIDES_PATH);
    expect(css).toContain('color: black;');
    expect(css).not.toContain('text-align');
  });

  it('wins over the element\'s own style attribute the same way', async () => {
    const inline = linked.replace('<h1 data-osw-id="h1abc123">', '<h1 data-osw-id="h1abc123" style="color: red; margin-top: 4px">');
    const id = await seed({ '/index.html': inline });
    rendersFromFile(id, 'color', { selector: '', origin: 'inline style' });
    const out = await run(id, '@h1abc123', 'color=green');
    expect(out.stdout).toContain('color was losing to the element\'s own style attribute, so it is marked !important in /overrides.css.');
    expect(await read(id, OVERRIDES_PATH)).toContain('color: green !important;');
    // The page's own markup is not touched to get there.
    expect(await read(id, '/index.html')).toBe(inline);
  });

  it('says a declaration the browser dropped was not applied, without marking it', async () => {
    const id = await seed({ '/index.html': linked });
    rendersWith(() => [{ property: 'color', computed: 'rgb(0, 0, 0)' }]);
    const out = await run(id, '@h1abc123', 'color=blak');
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(out.stdout).toContain('NOT APPLIED: color (color is still rgb(0, 0, 0)): the browser did not take the declaration');
    expect(out.stdout).not.toContain('Checked on');
    expect(await read(id, OVERRIDES_PATH)).not.toContain('blak');
  });

  it('with no page to read, marks what the style attribute would beat and says it was not checked', async () => {
    const inline = linked.replace('<h1 data-osw-id="h1abc123">', '<h1 data-osw-id="h1abc123" style="color: red; margin-top: 4px; gap: 2px !important">');
    const id = await seed({ '/index.html': inline });
    // Shorthand against longhand included.
    const out = await run(id, '@h1abc123', 'margin=0', 'padding=4px');
    expect(out.stdout).toContain('margin: the element\'s own style attribute sets it too, so it is marked !important in /overrides.css.');
    expect(out.stdout).toContain('Not checked on a rendered page: no open browser tab could render it.');
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  margin: 0 !important;\n  padding: 4px;\n}');

    // A style attribute that is !important itself cannot be beaten from a stylesheet.
    const stuck = await run(id, '@h1abc123', 'gap=8px');
    expect(stuck.stdout).toContain('NOT APPLIED: gap: the element\'s own style attribute sets it with !important, which no stylesheet can beat.');
    expect(await read(id, OVERRIDES_PATH)).not.toContain('gap');
  });

  it('with no page to read, finds the style attribute where the element is once the write has linked /overrides.css', async () => {
    // Not linked yet: the write puts the <link> in the head, ahead of the element.
    const inline = PAGE.replace('<h1>', '<h1 data-osw-id="h1abc123" style="color: red">');
    const id = await seed({ '/index.html': inline });
    const out = await run(id, '@h1abc123', 'color=green');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(await read(id, '/index.html')).toContain('<link rel="stylesheet" href="/overrides.css">');
    expect(out.stdout).toContain('color: the element\'s own style attribute sets it too, so it is marked !important in /overrides.css.');
    expect(await read(id, OVERRIDES_PATH)).toContain('{\n  color: green !important;\n}');
  });

  /** A hand edit that leaves the element's selector in a comment, where the writer will not edit the file. */
  const mentionInComment = async (id: string) =>
    vfs.updateFile(id, OVERRIDES_PATH, `${await read(id, OVERRIDES_PATH)}/* [data-osw-id="h1abc123"] */\n`, { silent: true });

  it('says a mark or a taking-back that /overrides.css refused was not made', async () => {
    const id = await seed({ '/index.html': linked });
    rendersFromFile(id, 'text-align', { selector: '#services h1', origin: '/styles.css' });
    const answer = renderPage.getMockImplementation()!;
    renderPage.mockImplementation(async (job: RenderJob) => {
      const result = await answer(job);
      await mentionInComment(id);
      return result;
    });
    const out = await run(id, '@h1abc123', 'color=black', 'text-align=left');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('NOT APPLIED: text-align (text-align is still theirs): the rule "#services h1" in /styles.css wins over it, and marking it !important was refused: Refusing to edit /overrides.css:');
    expect(out.stdout).toContain('The override for text-align is still in /overrides.css, as taking it out was refused too.');
    expect(out.stdout).not.toContain('marked !important in');
    expect(out.stdout).not.toContain('taken out again');
    expect(await read(id, OVERRIDES_PATH)).toContain('text-align: left;');
  });

  it('with no page to read, says a mark or a taking-back that /overrides.css refused was not made', async () => {
    const inline = linked.replace('<h1 data-osw-id="h1abc123">', '<h1 data-osw-id="h1abc123" style="color: red; gap: 2px !important">');
    const id = await seed({ '/index.html': inline });
    renderPage.mockImplementation(async () => {
      await mentionInComment(id);
      return { ok: false, error: 'no renderer' };
    });
    const out = await run(id, '@h1abc123', 'color=green', 'gap=8px');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('NOT APPLIED: color: the element\'s own style attribute sets it too, and marking it !important in /overrides.css was refused: Refusing to edit /overrides.css:');
    expect(out.stdout).toContain('The override is still in /overrides.css, as taking it out was refused:');
    expect(out.stdout).not.toContain('marked !important in');
    expect(out.stdout).not.toContain('taken out again');
    expect(await read(id, OVERRIDES_PATH)).toContain('gap: 8px;');
  });

  it('says so when an element in a partial was styled with no page named', async () => {
    const id = await seed({ '/index.html': '<html><head></head><body>{{> card}}</body></html>', '/templates/card.hbs': '<div data-osw-id="card0001" class="card">x</div>' }, 'handlebars');
    const out = await run(id, '@card0001', 'color=red');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain('Not checked on a rendered page: /templates/card.hbs is a partial, and no page was named.');
  });

  it('puts the write, the mark and a taking-back in one undo step', async () => {
    const id = await seed({ '/index.html': linked });
    const record = vi.fn();
    setEditHistory({ projectId: id, record, undoAt: () => null, redoAt: () => null, undo: () => {}, redo: () => {} });
    // An !important winner: the change is written, marked, still loses, and is taken back out.
    rendersFromFile(id, 'text-align', { selector: '#services h1', origin: '/styles.css', important: true }, 'center');
    const out = await run(id, '@h1abc123', 'text-align=left');
    expect(out.stdout).toContain('The override for text-align was taken out again.');
    expect(record.mock.calls.map(call => call[2].path)).toEqual([OVERRIDES_PATH, OVERRIDES_PATH, OVERRIDES_PATH]);
    expect(record.mock.calls[1][2].after).toContain('text-align: left !important;');
    expect(record.mock.calls[2][2].after).not.toContain('text-align');
    expect(new Set(record.mock.calls.map(call => call[0])).size).toBe(1);
  });

  it('refuses CSS the browser would drop, where there is a browser to ask', async () => {
    const id = await seed({ '/index.html': linked });
    vi.stubGlobal('CSS', { supports: (property: string) => property !== 'colour' });
    const out = await run(id, '@h1abc123', 'colour=red', 'gap=4px');
    vi.unstubAllGlobals();
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('not valid CSS, so nothing was written: colour: red');
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });
});

describe('the server\'s matcher', () => {
  it('matches as the DOM does, implied elements included', () => {
    const html = '<table><tr data-osw-src="/t.html:7"><td data-osw-src="/t.html:11">x</td></tr></table><p data-osw-src="/t.html:40">y</p>';
    for (const selector of ['table > tbody > tr', 'td', 'p, td', 'tr:first-child td']) {
      expect(cheerioMatcher(html, selector), selector).toEqual(domMatcher(html, selector));
    }
    expect(() => cheerioMatcher(html, 'p >>')).toThrow();
  });
});

describe('a project whose pages are not HTML source', () => {
  it('refuses, and says where the styles live instead', async () => {
    const id = await seed({ '/index.html': PAGE }, 'react' as 'static');
    const out = await run(id, '@h1abc123', 'color=red');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('this is a react project');
    expect(await vfs.fileExists(id, OVERRIDES_PATH)).toBe(false);
  });
});
