import { describe, it, expect } from 'vitest';
import { lineAt, parseSrc, resolveSelection, lineRange, positionAt, sourceRef } from '../resolution';

const payload = (over: Record<string, unknown> = {}) => ({
  domPath: 'html > body > p', tagName: 'p', attributes: {}, outerHTML: '<p>x</p>', ...over,
});

describe('resolveSelection', () => {
  it('resolves a single-instance element to its file and index', () => {
    expect(resolveSelection(payload({ srcAttr: '/index.html:42', instanceCount: 1 })))
      .toEqual({ kind: 'resolved', file: '/index.html', tagStart: 42 });
  });

  it('reports one-to-many when several elements share the source tag', () => {
    expect(resolveSelection(payload({ srcAttr: '/templates/nav.hbs:7', instanceCount: 6 })))
      .toEqual({ kind: 'one-to-many', file: '/templates/nav.hbs', tagStart: 7, instances: 6 });
  });

  it('treats a missing srcAttr as generated, not as an error', () => {
    expect(resolveSelection(payload())).toEqual({ kind: 'unresolvable', reason: 'generated' });
  });

  it('splits on the LAST colon, because a path may contain one', () => {
    expect(resolveSelection(payload({ srcAttr: '/a:b/c.html:99', instanceCount: 1 })))
      .toEqual({ kind: 'resolved', file: '/a:b/c.html', tagStart: 99 });
  });

  it('rejects a malformed srcAttr rather than producing a NaN index', () => {
    for (const bad of ['/index.html', '/index.html:', '/index.html:abc', ':5', '', '/i.html:-1']) {
      expect(resolveSelection(payload({ srcAttr: bad, instanceCount: 1 })).kind,
        `should reject ${JSON.stringify(bad)}`).toBe('unresolvable');
    }
  });

  it('treats an absent instanceCount as one instance', () => {
    expect(resolveSelection(payload({ srcAttr: '/i.html:0' })).kind).toBe('resolved');
  });
});

describe('parseSrc', () => {
  it('splits on the last colon, so a path may hold one', () => {
    expect(parseSrc('/notes:2024.html:15')).toEqual(['/notes:2024.html', 15]);
  });

  it('refuses an empty path, a missing colon and a non-numeric offset', () => {
    for (const bad of [':5', '/index.html', '/index.html:', '/index.html:1e3', '/index.html:-1']) {
      expect(parseSrc(bad), bad).toBeNull();
    }
  });
});

describe('lineAt', () => {
  const text = 'one\ntwo\n  <p>three</p>\n';

  it('counts the newlines before the offset', () => {
    expect(lineAt(text, 0)).toBe(1);
    expect(lineAt(text, text.indexOf('two'))).toBe(2);
    expect(lineAt(text, text.indexOf('<p>'))).toBe(3);
  });

  it('stops at the end of the text', () => {
    expect(lineAt(text, 999)).toBe(4);
  });
});

describe('positions as the agent reads and writes them', () => {
  const text = '<main>\n  <h1>Hi</h1>\r\n  <p>é<b>x</b></p>\n</main>';

  it('gives a 1-based line and column for an offset, in code units', () => {
    expect(positionAt(text, 0)).toEqual({ line: 1, col: 1 });
    expect(positionAt(text, text.indexOf('<h1>'))).toEqual({ line: 2, col: 3 });
    // After a CRLF line, and past a non-ASCII character.
    expect(positionAt(text, text.indexOf('<b>'))).toEqual({ line: 3, col: 7 });
    expect(sourceRef('/index.html', text, text.indexOf('<p>'))).toBe('/index.html:3:3');
  });

  it('finds where a line starts and ends, and nothing past the last', () => {
    const second = lineRange(text, 2)!;
    expect(text.slice(second.start, second.end)).toBe('  <h1>Hi</h1>\r');
    expect(lineRange(text, 4)).toEqual({ start: text.lastIndexOf('</main>'), end: text.length });
    expect(lineRange(text, 5)).toBeNull();
    expect(lineRange(text, 0)).toBeNull();
  });

  it('round-trips: the column of a line start plus its range is the offset', () => {
    for (const needle of ['<main>', '<h1>', '<p>', '<b>']) {
      const offset = text.indexOf(needle);
      const { line, col } = positionAt(text, offset);
      expect(lineRange(text, line)!.start + col - 1, needle).toBe(offset);
    }
  });
});
