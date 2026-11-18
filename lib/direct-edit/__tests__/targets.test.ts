import { describe, it, expect } from 'vitest';
import { findBySelector, pageFileFor, parseElementTarget } from '../targets';
import type { VirtualFileSystem } from '@/lib/vfs';

/**
 * How `style`, `inspect` and `screenshot` name an element, and how a selector becomes one source
 * element: elements with no source tag (built by a script, or added by the parser) are never it.
 */

const SOURCE = '<main>\n  <h1>Hi</h1>\n  <table><tr><td>x</td></tr></table>\n</main>';
const fs = { readFile: async () => ({ content: SOURCE }) } as unknown as VirtualFileSystem;
const H1 = `/index.html:${SOURCE.indexOf('<h1>')}`;
const TR = `/index.html:${SOURCE.indexOf('<tr>')}`;

describe('parseElementTarget', () => {
  it('reads a marker, a position by line or by line and column, or anything else as a selector', () => {
    expect(parseElementTarget('@h7x2m4qp')).toEqual({ kind: 'marker', id: 'h7x2m4qp' });
    expect(parseElementTarget('/index.html:42')).toEqual({ kind: 'position', file: '/index.html', line: 42, col: null });
    expect(parseElementTarget('/pages/about.html:42:7')).toEqual({ kind: 'position', file: '/pages/about.html', line: 42, col: 7 });
    expect(parseElementTarget('.hero h1')).toEqual({ kind: 'selector', selector: '.hero h1' });
    expect(parseElementTarget('/index.html')).toEqual({ kind: 'selector', selector: '/index.html' });
  });
});

describe('pageFileFor', () => {
  it('resolves a route as the preview does', () => {
    expect(['/', 'about', '/blog/', '/about.html', '/notes.v2'].map(pageFileFor)).toEqual(['/index.html', '/about.html', '/blog/index.html', '/about.html', '/notes.v2']);
  });
});

describe('findBySelector', () => {
  it('passes over elements no source tag made', async () => {
    const match = () => [{ src: null, tag: 'tbody' }, { src: TR, tag: 'tr' }];
    const found = await findBySelector(fs, 'p', '/index.html', '', 'tbody, tr', match);
    expect(found).toMatchObject({ ok: true, element: { src: TR, tag: 'tr', line: 3, instances: 1 } });
  });

  it('refuses a selector that matches only such elements', async () => {
    const found = await findBySelector(fs, 'p', '/index.html', '', 'tbody', () => [{ src: null, tag: 'tbody' }]);
    expect(found).toMatchObject({ ok: false });
    expect(!found.ok && found.error).toContain('"tbody" matches only elements of /index.html that are not written in the project\'s HTML');
  });

  it('lists a matched element whose source position it cannot read among the places, instead of throwing', async () => {
    const match = () => [{ src: H1, tag: 'h1' }, { src: 'hand-written', tag: 'x-card' }];
    const found = await findBySelector(fs, 'p', '/index.html', '', 'h1, x-card', match);
    expect(found).toMatchObject({ ok: false });
    expect(!found.ok && found.error).toContain('written in 2 places');
    expect(!found.ok && found.error).toContain('  an element with an unreadable source position');
  });

  it('counts the elements one source tag renders', async () => {
    const found = await findBySelector(fs, 'p', '/index.html', '', 'h1', () => [{ src: H1, tag: 'h1' }, { src: H1, tag: 'h1' }]);
    expect(found).toMatchObject({ ok: true, element: { src: H1, instances: 2 } });
  });
});
