// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { beginWriteGuard } from '../write-guard';
import { OVERRIDES_PATH } from '../apply-style';
import { declaredByScope, markerIdsIn } from '../overrides-css';
import { toolRegistry } from '@/lib/llm/tool-registry';
import type { ToolCall } from '@/lib/llm/types';

/**
 * The write guard, checked as files and as the note under a command's reply: what an agent's write
 * did to the markers, placeholders and locked elements a user left on the page.
 */

globalThis.indexedDB = new IDBFactory();
let seq = 0;

async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Guard', 'fixture', `p-guard-${++seq}`);
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}

const read = async (projectId: string, path: string) => String((await vfs.readFile(projectId, path)).content);

const rule = (id: string, body: string) => `[data-osw-id="${id}"][data-osw-id] {\n  ${body}\n}\n`;

const PAGE = [
  '<!doctype html>',
  '<html><head><link rel="stylesheet" href="/overrides.css"></head>',
  '<body>',
  '  <h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>',
  '  <p class="lead">First paragraph.</p>',
  '  <p class="lead" data-osw-id="p3k9d2aa">Second paragraph.</p>',
  '</body></html>',
].join('\n');

const CSS = rule('h7x2m4qp', 'color: red;') + rule('p3k9d2aa', 'margin-top: 8px;');

/** Runs `write` between the guard's two readings and returns its note. */
async function guarded(projectId: string, write: () => Promise<unknown>, expected?: string[]): Promise<string> {
  const guard = await beginWriteGuard(vfs, projectId, { expectedPlaceholders: new Set(expected ?? []) });
  await write();
  return guard ? guard.finish() : '(no guard)';
}

describe('a project with nothing set by hand', () => {
  it('has no guard, so a write costs it nothing afterwards', async () => {
    const projectId = await seed({ '/index.html': '<h1>Plain</h1>' });
    expect(await beginWriteGuard(vfs, projectId)).toBeNull();
  });

  it('is not guarded for a file in a hidden folder that mentions the attribute', async () => {
    const projectId = await seed({ '/index.html': '<h1>Plain</h1>', '/.drafts/old.html': '<p data-osw-id="aaaa1111">x</p>' });
    expect(await vfs.listFilePaths(projectId)).toContain('/.drafts/old.html');
    expect(await beginWriteGuard(vfs, projectId)).toBeNull();
  });
});

describe('a marker that has rules', () => {
  it('is put back on the element a rewrite left it off, and the note says where', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const rewritten = PAGE.replace(' data-osw-id="h7x2m4qp"', '').replace('<body>', '<body>\n  <nav>Menu</nav>');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));

    expect(await read(projectId, '/index.html')).toContain('<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>');
    expect(note).toContain('Note: this command changed things the user set by hand');
    expect(note).toContain('<h1> at /index.html:5:3');
    expect(note).toContain('data-osw-id="h7x2m4qp"');
    expect(note).toContain('put back');
  });

  it('says nothing when the rewrite kept it', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', PAGE.replace('Welcome', 'Hello')));
    expect(note).toBe('');
  });

  it('says nothing about a marker that has no rules', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: rule('p3k9d2aa', 'margin-top: 8px;') });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', PAGE.replace(' data-osw-id="h7x2m4qp"', '')));
    expect(note).toBe('');
    expect(await read(projectId, '/index.html')).not.toContain('h7x2m4qp');
  });

  it('is not put on an element it cannot tell from another, and the note says how to keep the styles', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    // Both paragraphs come back with the same class and new text: neither is certainly the second one.
    const rewritten = PAGE
      .replace('<p class="lead">First paragraph.</p>', '<p class="lead">Rewritten.</p>')
      .replace('<p class="lead" data-osw-id="p3k9d2aa">Second paragraph.</p>', '<p class="lead">Rewritten too.</p>');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));

    expect(await read(projectId, '/index.html')).toBe(rewritten);
    expect(note).toContain('<p> (it was at /index.html:6:3)');
    expect(note).toContain('add data-osw-id="p3k9d2aa" to that element\'s open tag');
    expect(note).not.toContain('put back');
  });

  it('is not put on either of two elements that both match it after the write', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    // The heading comes back twice without its marker: same tag, class and text.
    const rewritten = PAGE.replace(
      '<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>',
      '<h1 class="title">Welcome</h1>\n  <h1 class="title">Welcome</h1>',
    );
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));

    expect(await read(projectId, '/index.html')).toBe(rewritten);
    expect(note).toContain('it is gone with its data-osw-id="h7x2m4qp"');
    expect(note).not.toContain('put back');
  });

  it('is not given to the sibling that survived when the styled element was removed', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const rewritten = PAGE.replace('  <p class="lead" data-osw-id="p3k9d2aa">Second paragraph.</p>\n', '');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    expect(await read(projectId, '/index.html')).toBe(rewritten);
    expect(note).toContain('it is gone with its data-osw-id="p3k9d2aa"');
  });

  it('is not put on an element that carries another marker', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const rewritten = PAGE.replace('data-osw-id="h7x2m4qp"', 'data-osw-id="zz99zz99"');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    expect(await read(projectId, '/index.html')).toBe(rewritten);
    expect(note).not.toContain('put back');
    expect(note).toContain('data-osw-id="h7x2m4qp"');
  });

  it('counts what is past the sixth line instead of listing it', async () => {
    const ids = ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004', 'aaaa0005', 'aaaa0006', 'aaaa0007', 'aaaa0008'];
    const page = `<body>\n${ids.map(id => `<p data-osw-id="${id}">Same</p>`).join('\n')}\n</body>`;
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: ids.map(id => rule(id, 'color: red;')).join('') });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', '<body>\n<p>Same</p>\n<p>Same</p>\n</body>'));
    const lines = note.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[7]).toBe('- …and 2 more of the same kind.');
  });

  it('follows an element whose text changed by its class, when that class names one element', async () => {
    const page = '<body>\n<div class="card" data-osw-id="c4rd0001">Old words</div>\n<div class="note">Other</div>\n</body>';
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: rule('c4rd0001', 'padding: 8px;') });
    const rewritten = '<body>\n<div class="card">New words</div>\n<div class="note">Other</div>\n</body>';
    await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    expect(await read(projectId, '/index.html')).toContain('<div data-osw-id="c4rd0001" class="card">New words</div>');
  });

  it('follows an element by its class through a complete change of text while it stays where it was', async () => {
    const page = '<body>\n<section class="intro">\n<div class="card" data-osw-id="c4rd0001">Old words</div>\n</section>\n</body>';
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: rule('c4rd0001', 'padding: 8px;') });
    await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', page.replace(' data-osw-id="c4rd0001">Old words', '>Fresh copy')));
    expect(await read(projectId, '/index.html')).toContain('<div data-osw-id="c4rd0001" class="card">Fresh copy</div>');
  });

  it('is not put on a new element that shares only its tag and class, saying something else somewhere else', async () => {
    const page = '<a class="btn" data-osw-id="aaaa1111" href="/buy">Buy now</a>\n<p>x</p>';
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: rule('aaaa1111', 'color: red;') });
    const rewritten = '<p>x</p>\n<footer><a class="btn" href="/contact">Contact us</a></footer>';
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    expect(await read(projectId, '/index.html')).toBe(rewritten);
    expect(note).toContain('it is gone with its data-osw-id="aaaa1111"');
    expect(note).not.toContain('put back');
  });

  it('gives one element one marker when two styled elements were merged into it', async () => {
    const page = '<body>\n<p id="a" data-osw-id="mmmm0001">One</p>\n<p data-osw-id="mmmm0002">Two</p>\n</body>';
    const projectId = await seed({ '/index.html': page, [OVERRIDES_PATH]: rule('mmmm0001', 'color: red;') + rule('mmmm0002', 'color: blue;') });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', '<body>\n<p id="a">Two</p>\n</body>'));
    expect(await read(projectId, '/index.html')).toContain('<p data-osw-id="mmmm0001" id="a">Two</p>');
    expect(note.match(/put back/g)).toHaveLength(1);
    expect(note).toContain('it is gone with its data-osw-id="mmmm0002"');
  });

  it('follows the page\'s one <h1> through a change of class and text', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const rewritten = PAGE.replace('<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>', '<h1 class="hero-title">Different</h1>');
    await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    expect(await read(projectId, '/index.html')).toContain('<h1 data-osw-id="h7x2m4qp" class="hero-title">Different</h1>');
  });

  it('puts two markers back in one file, each on its own element', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const rewritten = PAGE.replace(' data-osw-id="h7x2m4qp"', '').replace(' data-osw-id="p3k9d2aa"', '');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', rewritten));
    const html = await read(projectId, '/index.html');
    expect(html).toContain('<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>');
    expect(html).toContain('<p data-osw-id="p3k9d2aa" class="lead">Second paragraph.</p>');
    expect(html).toContain('<p class="lead">First paragraph.</p>');
    expect(note.match(/put back/g)).toHaveLength(2);
  });

  it('is left alone when the element moved to another file with it', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const note = await guarded(projectId, async () => {
      await vfs.updateFile(projectId, '/index.html', PAGE.replace('  <h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n', ''));
      await vfs.createFile(projectId, '/templates/hero.hbs', '<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>');
    });
    expect(note).toBe('');
  });

  it('is not reported for a page that was deleted, and the rest of the command still is', async () => {
    const home = '<body>\n<h1>Home</h1>\n<div data-osw-block="hero-k3j9x2m1">Hero</div>\n</body>';
    // The deleted page holds a styled element, a placeholder and a locked element.
    const about = PAGE.replace('</body>', '  <div data-osw-block="faq-k3j9x2m2">FAQ</div>\n  <nav data-osw-lock><a href="/">Home</a></nav>\n</body>');
    const projectId = await seed({ '/index.html': home, '/about.html': about, [OVERRIDES_PATH]: CSS });
    expect(await guarded(projectId, () => vfs.deleteFile(projectId, '/about.html'))).toBe('');

    const second = await seed({ '/index.html': home, '/about.html': about, [OVERRIDES_PATH]: CSS });
    const note = await guarded(second, async () => {
      await vfs.deleteFile(second, '/about.html');
      await vfs.updateFile(second, '/index.html', '<body>\n<h1>Home</h1>\n</body>');
    });
    expect(note).toContain('The placeholder "Hero"');
    expect(note).not.toContain('/about.html');
  });
});

describe('a guard whose own write fails', () => {
  it('logs the failure and leaves the command its reply', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const guard = await beginWriteGuard(vfs, projectId);
    await vfs.updateFile(projectId, '/index.html', PAGE.replace(' data-osw-id="h7x2m4qp"', ''));
    const update = vfs.updateFile.bind(vfs);
    const failing = vi.spyOn(vfs, 'updateFile').mockImplementation(async (id, path, content, options) => {
      if (path === '/index.html') throw new Error('disk full');
      return update(id, path, content, options);
    });
    vi.mocked(logger.warn).mockClear();
    try {
      expect(await guard?.finish()).toBe('');
    } finally {
      failing.mockRestore();
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[WriteGuard]'), expect.any(Error));
  });
});

describe('a marker copied onto a second element', () => {
  it('gives the copy a marker of its own with the same rules', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const copied = PAGE.replace('</body>', '  <h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n</body>');
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', copied));

    const html = await read(projectId, '/index.html');
    const ids = [...html.matchAll(/<h1 data-osw-id="([a-z0-9]+)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('h7x2m4qp');
    expect(ids[1]).not.toBe('h7x2m4qp');
    const css = await read(projectId, OVERRIDES_PATH);
    expect(declaredByScope(css, ids[1]).get('all')).toEqual({ color: 'red' });
    expect(declaredByScope(css, 'h7x2m4qp').get('all')).toEqual({ color: 'red' });
    expect(note).toContain('The copy now has a data-osw-id of its own, with the same styles.');
  });

  it('gives the copy the !important its original needed to show', async () => {
    const css = rule('h7x2m4qp', 'color: red !important;\n  margin: 0;');
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: css });
    await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', PAGE.replace('</body>', '  <h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n</body>')));
    const fresh = [...(await read(projectId, '/index.html')).matchAll(/<h1 data-osw-id="([a-z0-9]+)"/g)].map(m => m[1])[1];
    expect(await read(projectId, OVERRIDES_PATH)).toContain(rule(fresh, 'color: red !important;\n  margin: 0;'));
  });

  it('does the same for a copied page, in one line', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const note = await guarded(projectId, () => vfs.createFile(projectId, '/about.html', PAGE));

    expect(await read(projectId, '/index.html')).toBe(PAGE);
    const about = await read(projectId, '/about.html');
    expect(about).not.toContain('h7x2m4qp');
    expect(about).not.toContain('p3k9d2aa');
    expect(markerIdsIn(await read(projectId, OVERRIDES_PATH))).toHaveLength(4);
    expect(note).toContain('/about.html: 2 elements were copied together with their data-osw-id attributes');
    expect(note.split('\n')).toHaveLength(2);
  });
});

describe('a placeholder', () => {
  const WITH = PAGE.replace('</body>', '  <div data-osw-block="hero-k3j9x2m1">Hero</div>\n</body>');

  it('is reported when a write drops it unasked', async () => {
    const projectId = await seed({ '/index.html': WITH });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', PAGE));
    expect(note).toContain('The placeholder "Hero" (data-osw-block="hero-k3j9x2m1", it was at /index.html:7:3) is gone.');
  });

  it('is not reported when the agent was asked to build it', async () => {
    const projectId = await seed({ '/index.html': WITH });
    const built = WITH.replace('<div data-osw-block="hero-k3j9x2m1">Hero</div>', '<section class="hero"><h2>Hi</h2></section>');
    expect(await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', built), ['hero-k3j9x2m1'])).toBe('');
  });
});

describe('a locked element', () => {
  const LOCKED = PAGE.replace('<body>', '<body>\n  <nav data-osw-lock><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>');

  it('may have its text and classes changed', async () => {
    const projectId = await seed({ '/index.html': LOCKED });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', LOCKED.replace('>About<', ' class="on">Us<')));
    expect(note).toBe('');
  });

  it('is reported when something is added inside it', async () => {
    const projectId = await seed({ '/index.html': LOCKED });
    const note = await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', LOCKED.replace('</ul>', '<li><a href="/x">X</a></li></ul>')));
    expect(note).toContain('<nav> (it was at /index.html:4:3) is locked by the user (data-osw-lock)');
  });

  it('is reported when it is removed or unlocked', async () => {
    const projectId = await seed({ '/index.html': LOCKED });
    expect(await guarded(projectId, () => vfs.updateFile(projectId, '/index.html', PAGE))).toContain('is locked by the user');
    const second = await seed({ '/index.html': LOCKED });
    expect(await guarded(second, () => vfs.updateFile(second, '/index.html', LOCKED.replace(' data-osw-lock', '')))).toContain('is locked by the user');
  });

  it('is reported in the file it was changed in when another page has an identical one', async () => {
    const changed = LOCKED.replace('</ul>', '<li><a href="/x">X</a></li></ul>');
    for (const [page, other] of [['/index.html', '/about.html'], ['/about.html', '/index.html']]) {
      const projectId = await seed({ '/about.html': LOCKED, '/index.html': LOCKED });
      const note = await guarded(projectId, () => vfs.updateFile(projectId, page, changed));
      expect(note).toContain(`<nav> (it was at ${page}:4:3) is locked by the user`);
      expect(note).not.toContain(other);
    }
  });
});

describe('through the bash tool', () => {
  const bash = (command: string): ToolCall => ({ id: 't', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });
  const context = { agentType: 'orchestrator' as const, isReadOnly: false, permissionMode: 'auto' as const };

  it('a whole-file rewrite gets the note under its reply and the marker back in the file', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const body = PAGE.replace(' data-osw-id="h7x2m4qp"', '');
    const reply = await toolRegistry.execute(bash(`cat > /index.html << 'EOF'\n${body}\nEOF`), projectId, context);

    expect(reply).toContain('Note: this command changed things the user set by hand');
    expect(reply).toContain('<h1> at /index.html:4:3');
    expect(await read(projectId, '/index.html')).toContain('<h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>');
  });

  it('an ss edit that keeps the marker gets no note', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const reply = await toolRegistry.execute(bash(`ss /index.html << 'EOF'\nWelcome\n=======\nHello\nEOF`), projectId, context);
    expect(reply).not.toContain('Note:');
    expect(await read(projectId, '/index.html')).toContain('>Hello</h1>');
  });

  it('a read is not guarded', async () => {
    const projectId = await seed({ '/index.html': PAGE, [OVERRIDES_PATH]: CSS });
    const spy = vi.spyOn(vfs, 'listFilePaths');
    await toolRegistry.execute(bash('cat /index.html'), projectId, context);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a placeholder the context says was asked for goes without a note', async () => {
    const page = PAGE.replace('</body>', '  <div data-osw-block="hero-k3j9x2m1">Hero</div>\n</body>');
    const projectId = await seed({ '/index.html': page });
    const command = `ss /index.html << 'EOF'\n<div data-osw-block="hero-k3j9x2m1">Hero</div>\n=======\n<section class="hero">Hi</section>\nEOF`;
    const asked = await toolRegistry.execute(bash(command), projectId, { ...context, expectedPlaceholders: new Set(['hero-k3j9x2m1']) });
    expect(asked).not.toContain('Note:');

    const other = await seed({ '/index.html': page });
    expect(await toolRegistry.execute(bash(command), other, context)).toContain('The placeholder "Hero"');
  });
});
