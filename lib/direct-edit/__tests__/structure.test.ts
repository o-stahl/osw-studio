import { describe, it, expect } from 'vitest';
import {
  scanElements,
  templateScope,
  moveElement,
  wrapElement,
  unwrapElement,
  duplicateElement,
  removeElement,
  insertElement,
  siblingsOf,
  mapOffset,
  indentUnit,
  isLockedAt,
  type StructureResult,
  type StructureEdit,
} from '../structure';

/** Where `needle` starts; it must be there exactly once. */
function at(content: string, needle: string): number {
  const i = content.indexOf(needle);
  expect(i, `${needle} in the fixture`).toBeGreaterThanOrEqual(0);
  expect(content.indexOf(needle, i + 1), `${needle} once in the fixture`).toBe(-1);
  return i;
}

function edited(result: StructureResult): StructureEdit {
  expect(result.ok, result.ok ? '' : `refused: ${(result as { reason: string }).reason}`).toBe(true);
  return (result as { ok: true; edit: StructureEdit }).edit;
}

function refusal(result: StructureResult): string {
  expect(result.ok).toBe(false);
  return (result as { ok: false; reason: string }).reason;
}

/** The pieces spell the new content: kept ranges are the old text, and the lengths add up. */
function expectPiecesSpell(old: string, edit: StructureEdit): void {
  let pos = 0;
  for (const piece of edit.pieces) {
    if (typeof piece === 'number') { pos += piece; continue; }
    expect(edit.content.slice(pos, pos + piece[1] - piece[0])).toBe(old.slice(piece[0], piece[1]));
    pos += piece[1] - piece[0];
  }
  expect(pos).toBe(edit.content.length);
}

const LIST = [
  '<main>',
  '  <ul class="list">',
  '    <li>One</li>',
  '    <li>Two</li>',
  '    <li>Three</li>',
  '  </ul>',
  '  <p class="after">After</p>',
  '</main>',
  '',
].join('\n');

describe('scanElements', () => {
  it('pairs each element with its own close tag, through nested elements of the same name', () => {
    const html = '<div class="a"><div class="b"><p>x</p></div><span>y</span></div>';
    const nodes = scanElements(html);
    const outer = nodes.find(node => node.start === 0)!;
    expect(html.slice(outer.start, outer.end)).toBe(html);
    const inner = nodes.find(node => node.start === at(html, '<div class="b">'))!;
    expect(html.slice(inner.start, inner.end)).toBe('<div class="b"><p>x</p></div>');
    expect(nodes[inner.parent]).toBe(outer);
  });

  it('gives void and self-closing elements their open tag as their range', () => {
    const html = '<p>a<br>b<img src="x"><circle r="1"/></p>';
    const nodes = scanElements(html);
    for (const tag of ['br', 'img', 'circle']) {
      const node = nodes.find(n => n.tag === tag)!;
      expect(node.end).toBe(node.openEnd);
      expect(node.implied).toBe(false);
    }
  });

  it('reads raw text as text and treats mustaches as opaque', () => {
    const html = '<script>if (a < b) document.write("<p>")</script>{{> card x="<p>"}}<p>z</p>';
    const tags = scanElements(html).map(node => node.tag);
    expect(tags).toEqual(['script', 'p']);
  });

  it('marks elements closed only by their parent as implied', () => {
    const html = '<ul><li>a<li>b</ul>';
    const lis = scanElements(html).filter(node => node.tag === 'li');
    expect(lis.every(li => li.implied)).toBe(true);
  });
});

describe('templateScope', () => {
  const tpl = '<div>{{#if a}}<p class="in">x</p>{{else}}<p class="else">y</p>{{/if}}<p class="out">z</p></div>';

  it('tells the branches of one block apart, and the outside from both', () => {
    const inside = templateScope(tpl, at(tpl, '<p class="in">'));
    const other = templateScope(tpl, at(tpl, '<p class="else">'));
    const outside = templateScope(tpl, at(tpl, '<p class="out">'));
    expect(new Set([inside, other, outside]).size).toBe(3);
    expect(outside).toBe(templateScope(tpl, 0));
  });

  it('reads whitespace control and the {{^}} shorthand for else', () => {
    const t = '{{~#each xs~}}<i class="a"></i>{{^}}<i class="b"></i>{{~/each~}}<i class="c"></i>';
    expect(templateScope(t, at(t, '<i class="a">'))).not.toBe(templateScope(t, at(t, '<i class="b">')));
    expect(templateScope(t, at(t, '<i class="c">'))).toBe('');
  });
});

describe('moveElement', () => {
  it('moves an element above its previous sibling, keeping both lines as they were written', () => {
    const edit = edited(moveElement(LIST, at(LIST, '<li>Two'), { before: at(LIST, '<li>One') }));
    expect(edit.content).toBe(LIST.replace('    <li>One</li>\n    <li>Two</li>', '    <li>Two</li>\n    <li>One</li>'));
    expect(edit.content.slice(edit.select!, edit.select! + 12)).toBe('<li>Two</li>');
    expectPiecesSpell(LIST, edit);
  });

  it('maps every other element to where it now starts', () => {
    const edit = edited(moveElement(LIST, at(LIST, '<li>Three'), { before: at(LIST, '<li>One') }));
    for (const tag of ['<li>One', '<li>Two', '<li>Three', '<p class="after">', '<ul class="list">']) {
      const moved = mapOffset(edit.pieces, at(LIST, tag));
      expect(edit.content.slice(moved!, moved! + tag.length)).toBe(tag);
    }
  });

  it('moves an element into another parent, re-indented to its new depth', () => {
    const edit = edited(moveElement(LIST, at(LIST, '<p class="after">'), { parent: at(LIST, '<ul class="list">'), at: 'end' }));
    expect(edit.content).toBe([
      '<main>',
      '  <ul class="list">',
      '    <li>One</li>',
      '    <li>Two</li>',
      '    <li>Three</li>',
      '    <p class="after">After</p>',
      '  </ul>',
      '</main>',
      '',
    ].join('\n'));
    expectPiecesSpell(LIST, edit);
  });

  it('moves out of a parent and outdents', () => {
    const edit = edited(moveElement(LIST, at(LIST, '<li>One'), { after: at(LIST, '<p class="after">') }));
    expect(edit.content.split('\n')).toEqual([
      '<main>', '  <ul class="list">', '    <li>Two</li>', '    <li>Three</li>', '  </ul>',
      '  <p class="after">After</p>', '  <li>One</li>', '</main>', '',
    ]);
  });

  it('moves elements that share a line without touching the line', () => {
    const html = '<p><b>a</b> <i>b</i></p>';
    const edit = edited(moveElement(html, at(html, '<i>'), { before: at(html, '<b>') }));
    expect(edit.content).toBe('<p><i>b</i><b>a</b> </p>');
  });

  it('refuses to move an element into itself', () => {
    const html = '<div class="a"><p>x</p></div>';
    expect(refusal(moveElement(html, 0, { parent: at(html, '<p>'), at: 'end' }))).toBe('into-itself');
    expect(refusal(moveElement(html, 0, { parent: 0, at: 'end' }))).toBe('into-itself');
  });

  it('refuses locked elements and locked destinations', () => {
    const html = '<div data-osw-lock><p class="a">a</p></div><section><p class="b">b</p></section>';
    expect(refusal(moveElement(html, at(html, '<p class="a">'), { before: at(html, '<p class="b">') }))).toBe('locked');
    expect(refusal(moveElement(html, at(html, '<p class="b">'), { parent: 0, at: 'end' }))).toBe('locked');
  });

  it('refuses a move into or out of a template block, and allows one past a whole block', () => {
    const tpl = '<div>\n  {{#if a}}\n  <p class="in">x</p>\n  {{/if}}\n  <p class="out">z</p>\n</div>\n';
    expect(refusal(moveElement(tpl, at(tpl, '<p class="out">'), { before: at(tpl, '<p class="in">') }))).toBe('crosses-template');
    expect(refusal(moveElement(tpl, at(tpl, '<p class="in">'), { after: at(tpl, '<p class="out">') }))).toBe('crosses-template');
    const each = '<ul>\n  <li class="a">a</li>\n  {{#each xs}}<li>{{this}}</li>{{/each}}\n  <li class="b">b</li>\n</ul>\n';
    const edit = edited(moveElement(each, at(each, '<li class="b">'), { before: at(each, '<li class="a">') }));
    expect(edit.content.indexOf('<li class="b">')).toBeLessThan(edit.content.indexOf('<li class="a">'));
  });

  it('says the index went stale when no element starts there', () => {
    expect(refusal(moveElement(LIST, at(LIST, '<li>One') + 1, { before: 0 }))).toBe('stale-index');
  });
});

describe('wrapElement', () => {
  const open = '<div data-osw-frame>';
  const close = '</div>';

  it('puts the frame on lines of its own and indents what it wraps', () => {
    const edit = edited(wrapElement(LIST, at(LIST, '<ul class="list">'), open, close));
    expect(edit.content).toBe([
      '<main>',
      '  <div data-osw-frame>',
      '    <ul class="list">',
      '      <li>One</li>',
      '      <li>Two</li>',
      '      <li>Three</li>',
      '    </ul>',
      '  </div>',
      '  <p class="after">After</p>',
      '</main>',
      '',
    ].join('\n'));
    expect(edit.created).toEqual([edit.select]);
    expect(edit.content.startsWith(open, edit.select!)).toBe(true);
    const ul = mapOffset(edit.pieces, at(LIST, '<ul class="list">'))!;
    expect(edit.content.startsWith('<ul class="list">', ul)).toBe(true);
    expectPiecesSpell(LIST, edit);
  });

  it('wraps in place when the element shares its line', () => {
    const html = '<p><b>a</b> b</p>';
    expect(edited(wrapElement(html, at(html, '<b>'), open, close)).content).toBe('<p><div data-osw-frame><b>a</b></div> b</p>');
  });
});

describe('unwrapElement', () => {
  it('lifts a frame\'s children out one level and selects the first', () => {
    const framed = edited(wrapElement(LIST, at(LIST, '<ul class="list">'), '<div data-osw-frame>', '</div>')).content;
    const edit = edited(unwrapElement(framed, at(framed, '<div data-osw-frame>')));
    expect(edit.content).toBe(LIST);
    expect(edit.content.startsWith('<ul class="list">', edit.select!)).toBe(true);
  });

  it('only unwraps a frame', () => {
    expect(refusal(unwrapElement(LIST, at(LIST, '<ul class="list">')))).toBe('not-a-frame');
  });
});

describe('duplicateElement', () => {
  it('puts the copy on the next line, and lists the elements it created', () => {
    const edit = edited(duplicateElement(LIST, at(LIST, '<ul class="list">')));
    expect(edit.content.split('<ul class="list">').length).toBe(3);
    expect(edit.created.map(i => edit.content.slice(i, i + 4))).toEqual(['<ul ', '<li>', '<li>', '<li>']);
    expect(edit.select).toBe(edit.created[0]);
    expect(mapOffset(edit.pieces, at(LIST, '<ul class="list">'))).toBe(at(LIST, '<ul class="list">'));
    expectPiecesSpell(LIST, edit);
  });

  it('runs the copy through the transform', () => {
    const html = '<div>\n  <p data-osw-id="aaaaaaaa">x</p>\n</div>';
    const edit = edited(duplicateElement(html, at(html, '<p'), markup => markup.replace('aaaaaaaa', 'bbbbbbbb')));
    expect(edit.content).toBe('<div>\n  <p data-osw-id="aaaaaaaa">x</p>\n  <p data-osw-id="bbbbbbbb">x</p>\n</div>');
  });
});

describe('removeElement', () => {
  it('takes the element\'s line with it', () => {
    const edit = edited(removeElement(LIST, at(LIST, '<li>Two')));
    expect(edit.content).toBe(LIST.replace('    <li>Two</li>\n', ''));
    expect(edit.select).toBeNull();
    expect(mapOffset(edit.pieces, at(LIST, '<li>Two'))).toBeNull();
  });

  it('takes only the element when it shares its line', () => {
    const html = '<p><b>a</b> b</p>';
    expect(edited(removeElement(html, at(html, '<b>'))).content).toBe('<p> b</p>');
  });

  it('refuses a range that is not balanced', () => {
    const tpl = '<div>{{#if a}}<p>x</div>{{/if}}';
    expect(refusal(removeElement(tpl, 0))).toBe('crosses-template');
  });
});

describe('insertElement', () => {
  it('inserts before a sibling on a line of its own, at its indentation', () => {
    const edit = edited(insertElement(LIST, { before: at(LIST, '<li>Two') }, '<li>New</li>'));
    expect(edit.content).toBe(LIST.replace('    <li>Two</li>', '    <li>New</li>\n    <li>Two</li>'));
    expect(edit.created).toEqual([edit.select]);
  });

  it('appends inside a parent, indented as its last child', () => {
    const edit = edited(insertElement(LIST, { parent: at(LIST, '<ul class="list">'), at: 'end' }, '<li>Four</li>'));
    expect(edit.content).toBe(LIST.replace('    <li>Three</li>\n', '    <li>Three</li>\n    <li>Four</li>\n'));
  });

  it('puts the first child of an empty multi-line parent one level in', () => {
    const html = '<section>\n</section>\n';
    const edit = edited(insertElement(html, { parent: 0, at: 'start' }, '<p>x</p>'));
    expect(edit.content).toBe('<section>\n  <p>x</p>\n</section>\n');
  });

  it('inserts inline into a parent written on one line', () => {
    const html = '<div class="x"></div>';
    expect(edited(insertElement(html, { parent: 0, at: 'end' }, '<hr>')).content).toBe('<div class="x"><hr></div>');
  });

  it('lists every element in the inserted markup the compile would tag', () => {
    const edit = edited(insertElement(LIST, { parent: at(LIST, '<main>'), at: 'end' }, '<div><span>a</span><script>x</script></div>'));
    expect(edit.created.map(i => edit.content.slice(i, i + 5))).toEqual(['<div>', '<span']);
  });

  it('refuses a place inside a loop, and a locked parent', () => {
    const tpl = '<ul>\n  {{#each xs}}\n  <li class="each">x</li>\n  {{/each}}\n</ul>\n';
    expect(refusal(insertElement(tpl, { before: at(tpl, '<li class="each">') }, '<li>x</li>'))).toBe('crosses-template');
    const locked = '<div data-osw-lock="">\n  <p>a</p>\n</div>\n';
    expect(refusal(insertElement(locked, { parent: 0, at: 'end' }, '<p>b</p>'))).toBe('locked');
  });

  it('refuses a void parent', () => {
    const html = '<img src="a">';
    expect(refusal(insertElement(html, { parent: 0, at: 'end' }, '<p>x</p>'))).toBe('no-place');
  });
});

describe('helpers', () => {
  it('maps an element that starts where text went in to after the text', () => {
    const html = '<p><b>a</b></p>';
    const edit = edited(insertElement(html, { before: at(html, '<b>') }, '<i>x</i>'));
    expect(edit.content).toBe('<p><i>x</i><b>a</b></p>');
    const b = mapOffset(edit.pieces, at(html, '<b>'))!;
    expect(edit.content.slice(b, b + 3)).toBe('<b>');
  });

  it('finds the previous and next elements the compile tags, skipping the rest', () => {
    const html = '<div><p class="a"></p><script></script><p class="b"></p></div>';
    expect(siblingsOf(html, at(html, '<p class="b">'))).toEqual({ previous: at(html, '<p class="a">'), next: null });
  });

  it('reads the indentation unit from the file', () => {
    expect(indentUnit(LIST)).toBe('  ');
    expect(indentUnit('<a>\n\t<b></b>\n</a>')).toBe('\t');
    expect(indentUnit('<a>\n    <b>\n        <c></c>\n    </b>\n</a>')).toBe('    ');
  });

  it('sees a lock on any ancestor, with or without a value', () => {
    const html = '<div data-osw-lock><section><p>x</p></section></div><p class="free">y</p>';
    expect(isLockedAt(html, at(html, '<p>x'))).toBe(true);
    expect(isLockedAt(html, at(html, '<p class="free">'))).toBe(false);
  });
});

describe('line endings', () => {
  it('keeps CRLF files CRLF', () => {
    const crlf = LIST.replace(/\n/g, '\r\n');
    const edit = edited(insertElement(crlf, { before: at(crlf, '<li>Two') }, '<li>New</li>'));
    expect(edit.content).toBe(crlf.replace('    <li>Two</li>', '    <li>New</li>\r\n    <li>Two</li>'));
  });
});
