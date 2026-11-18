import { describe, it, expect } from 'vitest';
import {
  applyChanges,
  clearScope,
  declaredByScope,
  declaredProperties,
  managedWidths,
  markerBlocksText,
  upsertDeclaration,
  removeDeclaration,
  removeMarkerBlock,
  OVERRIDES_HEADER,
  importantProperties,
  strengthenDeclarations,
  withCurrentHeader,
} from '../overrides-css';

/** The header v1.96.0 to v1.110.0 wrote, as those versions spelled it: files in real projects open with it. */
const RELEASED_HEADER = `/* OSW Studio style overrides.
 *
 * Each block below is keyed to one element by the data-osw-id attribute stamped on it in source.
 * Direct edits in the preview rewrite these blocks; anything you write outside them is preserved
 * byte for byte. The selector is doubled so it has the specificity of two classes, which lets it
 * beat an ordinary compound selector on source order alone, without forcing priority.
 *
 * A block whose marker no longer exists anywhere in the project has no effect and is safe to
 * delete.
 */`;

const BLOCK = (id: string) => new RegExp(`\\[data-osw-id="${id}"\\]\\[data-osw-id\\]\\s*\\{`, 'g');

/** The selector `upsertDeclaration` writes, for the cases that hand-build a file rather than seed one. */
const SELECTOR = (id: string) => `[data-osw-id="${id}"][data-osw-id]`;

describe('the file header', () => {
  // Nothing in the system prompt explains the file, so the header has to, for an agent that opens it.
  it('says what a block is keyed to, to keep the attribute, and the command that changes a block', () => {
    // The comment's text as one run of words, wherever its lines wrap.
    const prose = OVERRIDES_HEADER.replace(/\s*\n \*\s*/g, ' ');
    expect(prose).toContain('data-osw-id attribute');
    expect(prose).toContain('Keep it there when the element\'s HTML is edited, and leave it off a copy of the element');
    expect(prose).toContain('style @<id> property=value');
  });

  it('spells no marker selector, which the scan would refuse to edit past', () => {
    expect(OVERRIDES_HEADER).not.toMatch(/\[data-osw-id=/);
    const out = applyChanges(`${OVERRIDES_HEADER}\n`, 'aaaaaaaa', 'all', [{ property: 'color', value: 'red' }]);
    expect(declaredByScope(out, 'aaaaaaaa').get('all')).toEqual({ color: 'red' });
  });

  it('replaces the header an earlier version wrote on the next write, keeping every block', () => {
    const old = `${RELEASED_HEADER}\n\n${SELECTOR('aaaaaaaa')} {\n  color: red;\n}\n`;
    const out = applyChanges(old, 'bbbbbbbb', 'all', [{ property: 'margin', value: '0' }]);
    expect(out.startsWith(`${OVERRIDES_HEADER}\n\n${SELECTOR('aaaaaaaa')} {\n  color: red;\n}\n`)).toBe(true);
    expect(out).not.toContain('keyed to one element');
    expect(declaredByScope(out, 'bbbbbbbb').get('all')).toEqual({ margin: '0' });
  });

  it('replaces it on a write that only marks a declaration !important too', () => {
    const old = `${RELEASED_HEADER}\n\n${SELECTOR('aaaaaaaa')} {\n  color: red;\n}\n`;
    expect(strengthenDeclarations(old, 'aaaaaaaa', ['color']))
      .toBe(`${OVERRIDES_HEADER}\n\n${SELECTOR('aaaaaaaa')} {\n  color: red !important;\n}\n`);
  });

  it('leaves a header someone edited, and a file with none', () => {
    const edited = RELEASED_HEADER.replace('safe to\n * delete.', 'safe to\n * delete. (ours)');
    expect(withCurrentHeader(`${edited}\n`)).toBe(`${edited}\n`);
    expect(withCurrentHeader('.a { color: red; }\n')).toBe('.a { color: red; }\n');
  });

  it('does not turn a call that changes nothing into a new file', () => {
    const old = `${RELEASED_HEADER}\n\n${SELECTOR('aaaaaaaa')} {\n  color: red;\n}\n`;
    expect(applyChanges(old, 'aaaaaaaa', 'all', [{ property: 'margin', value: null }])).toBe(old);
  });
});

describe('a declaration made to win', () => {
  // An override is (0,2,0) and loads last, which a selector with an id, or the element's own style
  // attribute, still beats. `!important` on the one declaration is what makes the user's value apply.
  const two = () => {
    let css = applyChanges('', 'aaaaaaaa', 'all', [{ property: 'color', value: 'red' }, { property: 'padding', value: '4px' }]);
    css = applyChanges(css, 'aaaaaaaa', 640, [{ property: 'color', value: 'blue' }]);
    return applyChanges(css, 'bbbbbbbb', 'all', [{ property: 'color', value: 'green' }]);
  };

  it('is marked at every width, for that element and that property only', () => {
    const out = strengthenDeclarations(two(), 'aaaaaaaa', ['color']);
    expect(markerBlocksText(out, 'aaaaaaaa')).toBe(
      `${SELECTOR('aaaaaaaa')} {\n  color: red !important;\n  padding: 4px;\n}\n\n`
      + `@media (max-width: 640px) {\n  ${SELECTOR('aaaaaaaa')} {\n    color: blue !important;\n  }\n}`,
    );
    expect(markerBlocksText(out, 'bbbbbbbb')).toBe(`${SELECTOR('bbbbbbbb')} {\n  color: green;\n}`);
    expect(importantProperties(out, 'aaaaaaaa')).toEqual(['color']);
    expect(importantProperties(out, 'bbbbbbbb')).toEqual([]);
  });

  it('is read back as the value alone, so nothing that reads values needs to know of the mark', () => {
    const out = strengthenDeclarations(two(), 'aaaaaaaa', ['color']);
    expect(declaredByScope(out, 'aaaaaaaa').get('all')).toEqual({ color: 'red', padding: '4px' });
    expect(declaredByScope(out, 'aaaaaaaa').get(640)).toEqual({ color: 'blue' });
  });

  it('keeps the mark when the value changes, here or at another width', () => {
    let out = strengthenDeclarations(two(), 'aaaaaaaa', ['color']);
    out = applyChanges(out, 'aaaaaaaa', 'all', [{ property: 'color', value: 'purple' }]);
    out = applyChanges(out, 'aaaaaaaa', 900, [{ property: 'color', value: 'teal' }, { property: 'margin', value: '0' }]);
    const text = markerBlocksText(out, 'aaaaaaaa');
    expect(text).toContain('color: purple !important;');
    expect(text).toContain('color: teal !important;');
    expect(text).toContain('margin: 0;');
    expect(text).not.toContain('!important !important');
  });

  it('is an ordinary declaration again once the property was taken off everywhere and set anew', () => {
    let out = strengthenDeclarations(two(), 'aaaaaaaa', ['color']);
    out = applyChanges(out, 'aaaaaaaa', 'all', [{ property: 'color', value: null }]);
    out = applyChanges(out, 'aaaaaaaa', 640, [{ property: 'color', value: null }]);
    out = applyChanges(out, 'aaaaaaaa', 'all', [{ property: 'color', value: 'red' }]);
    expect(markerBlocksText(out, 'aaaaaaaa')).toContain('color: red;');
    expect(importantProperties(out, 'aaaaaaaa')).toEqual([]);
  });

  it('changes nothing when asked twice, or for a property the element does not declare', () => {
    const once = strengthenDeclarations(two(), 'aaaaaaaa', ['color']);
    expect(strengthenDeclarations(once, 'aaaaaaaa', ['color'])).toBe(once);
    expect(strengthenDeclarations(two(), 'aaaaaaaa', ['margin'])).toBe(two());
    expect(strengthenDeclarations(two(), 'aaaaaaaa', [])).toBe(two());
  });

  it('takes the property in any case, and keeps a comment someone left in the block', () => {
    const css = `${SELECTOR('aaaaaaaa')} {\n  /* keep */\n  Color: red;\n}\n`;
    expect(strengthenDeclarations(css, 'aaaaaaaa', ['COLOR'])).toBe(`${SELECTOR('aaaaaaaa')} {\n  /* keep */\n  Color: red !important;\n}\n`);
  });
});

describe('upsertDeclaration', () => {
  it('creates the file body with a header when empty', () => {
    const out = upsertDeclaration('', 'h7x2m4qp', { property: 'padding-block', value: '3rem' });
    expect(out).toContain(OVERRIDES_HEADER);
    expect(out).toContain('padding-block: 3rem;');
  });

  it('uses the doubled attribute selector, which is what wins the cascade', () => {
    // A bare [data-osw-id] is (0,1,0) — one class — so `.hero .title` would beat it despite
    // loading later. Doubled is (0,2,0), which ties and wins on source order.
    const out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    expect(out).toMatch(/\[data-osw-id="aaaaaaaa"\]\[data-osw-id\]/);
    // The header speaks of the mark; a block gets it only once a render showed it losing.
    expect(markerBlocksText(out, 'aaaaaaaa')).toBe(`${SELECTOR('aaaaaaaa')} {\n  color: red;\n}`);
    expect(out).not.toContain('@layer');
  });

  it('adds a second property to the SAME block, not a second block', () => {
    let out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'padding', value: '1rem' });
    expect(out.match(BLOCK('aaaaaaaa'))).toHaveLength(1);   // <- one block
    expect(out).toContain('color: red;');
    expect(out).toContain('padding: 1rem;');
  });

  it('replaces the value when the same property is set again', () => {
    let out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'color', value: 'blue' });
    expect(out).toContain('color: blue;');
    expect(out).not.toContain('color: red;');
    expect(out.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
  });

  it('keeps blocks for other markers untouched', () => {
    let out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'bbbbbbbb', { property: 'color', value: 'blue' });
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'color', value: 'green' });
    expect(out).toContain('color: blue;');
    expect(out).toContain('color: green;');
    expect(out).not.toContain('color: red;');
  });

  it('preserves hand-written content before AND after an owned block, byte-exact', () => {
    const before = '/* mine */\n.thing { color: hotpink; }\n';
    const after  = '\n.other { margin: 0 }\n/* trailing */\n';
    let out = upsertDeclaration(before + after, 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'padding', value: '1rem' });
    expect(out).toContain(before.trim());
    expect(out).toContain('.other { margin: 0 }');
    expect(out).toContain('/* trailing */');
  });

  it('throws rather than editing a rule it does not own (selector inside a comment)', () => {
    const trap = '/* [data-osw-id="aaaaaaaa"][data-osw-id] is mentioned here */\n.victim { color: hotpink; }\n';
    expect(() => upsertDeclaration(trap, 'aaaaaaaa', { property: 'color', value: 'red' }))
      .toThrow();
  });

  it('is not confused by a brace inside a string', () => {
    const tricky = '.x { content: "}" }\n';
    const out = upsertDeclaration(tricky, 'aaaaaaaa', { property: 'color', value: 'red' });
    expect(out).toContain('.x { content: "}" }');
    expect(out.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
  });

  it('is not confused by a brace inside a string that PRECEDES the owned block', () => {
    // The case the tokenizer actually exists for. With the string state removed, the plan's own
    // `.x { content: "}" }` case still passes — the block is simply appended after it — so it
    // proves nothing on its own. Put the trap *before* an owned block and the depth desync bites:
    // `}` closes `.x` early and the owned selector is mis-sliced (duplicate block appended);
    // `{` opens a phantom level and the owned selector reads as nested (spurious throw).
    for (const ch of ['{', '}']) {
      const css = `.x { content: "${ch}" }\n[data-osw-id="aaaaaaaa"][data-osw-id] { color: red; }\n`;
      const out = upsertDeclaration(css, 'aaaaaaaa', { property: 'padding', value: '1rem' });
      expect(out.match(BLOCK('aaaaaaaa')), `for ${ch}`).toHaveLength(1);
      expect(out, `for ${ch}`).toContain('color: red;');
      expect(out, `for ${ch}`).toContain('padding: 1rem;');
      expect(out, `for ${ch}`).toContain(`.x { content: "${ch}" }`);
    }
  });

  it('does not split a hand-written declaration on a semicolon inside a string or parens', () => {
    const hand = '[data-osw-id="aaaaaaaa"][data-osw-id] {\n' +
      '  content: "a;b";\n  background: url(x;y);\n}\n';
    const out = upsertDeclaration(hand, 'aaaaaaaa', { property: 'color', value: 'red' });
    expect(out).toContain('content: "a;b";');
    expect(out).toContain('background: url(x;y);');
    expect(out).toContain('color: red;');
  });

  it('throws when the marker block is nested inside an at-rule', () => {
    const nested = '@media (min-width: 40em) {\n  [data-osw-id="aaaaaaaa"][data-osw-id] { color: red; }\n}\n';
    expect(() => upsertDeclaration(nested, 'aaaaaaaa', { property: 'color', value: 'blue' }))
      .toThrow();
  });

  it('rejects an injected value or property rather than corrupting the file', () => {
    expect(() => upsertDeclaration('', 'a', { property: 'color', value: 'red; } body {' })).toThrow();
    expect(() => upsertDeclaration('', 'a', { property: 'color; } body { color', value: 'red' })).toThrow();
  });

  // --- beyond the plan's block, pinning behaviour the implementation commits to ---

  it('rejects a value that opens or closes a comment, or is empty', () => {
    for (const value of ['red /* x', 'red */', '', '   ', 'red }', 'a{b']) {
      expect(() => upsertDeclaration('', 'a', { property: 'color', value }),
        `should reject value ${JSON.stringify(value)}`).toThrow();
    }
  });

  // An unclosed `(` or quote runs on past the `;` written after it: the browser drops every rule
  // after it, and the next write of this block reads the following declaration as part of the value.
  it('refuses a value whose parenthesis, bracket or quote is never closed', () => {
    for (const value of ['calc(100% - 10px', 'rgb(255 102 0', 'url("a.png"', '"abc', "'abc", '[full-start 1fr', 'calc(1px))', 'a(b]', 'red\\']) {
      expect(() => upsertDeclaration('', 'a', { property: 'width', value }),
        `should reject value ${JSON.stringify(value)}`).toThrow(/unsafe/);
    }
    const css = upsertDeclaration('', 'aaaaaaaa', { property: 'padding', value: '1rem' });
    expect(() => applyChanges(css, 'aaaaaaaa', 'all', [{ property: 'width', value: 'calc(100% - 10px' }])).toThrow(/unsafe/);
  });

  it('takes a value whose brackets and quotes close, nested or inside quotes', () => {
    for (const value of [
      'calc(100% - calc(2 * 10px))', 'url("a(b.png")', "url('x).png')", '"a)b"', '"say \\"hi\\""',
      '[full-start] minmax(0, 1fr) [full-end]', 'url(a\\(b.png)', 'rgb(255 102 0 / 50%)',
    ]) {
      const out = upsertDeclaration('', 'aaaaaaaa', { property: 'width', value });
      expect(out, value).toContain(`width: ${value};`);
    }
  });

  it('rejects a marker id that would not survive the selector', () => {
    for (const id of ['', 'a"b', 'a b', 'a]b']) {
      expect(() => upsertDeclaration('', id, { property: 'color', value: 'red' }),
        `should reject id ${JSON.stringify(id)}`).toThrow();
    }
  });

  it('splits a declaration on the FIRST colon, so a url() value survives', () => {
    const out = upsertDeclaration('', 'aaaaaaaa',
      { property: 'background-image', value: 'url(https://a/b.png)' });
    expect(out).toContain('background-image: url(https://a/b.png);');
    const again = upsertDeclaration(out, 'aaaaaaaa',
      { property: 'background-image', value: 'url(https://c/d.png)' });
    expect(again).toContain('background-image: url(https://c/d.png);');
    expect(again).not.toContain('b.png');
    expect(again.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
  });

  it('matches an owned block that was reformatted or minified', () => {
    const minified = '[data-osw-id="aaaaaaaa"][data-osw-id]{color:red}\n';
    const out = upsertDeclaration(minified, 'aaaaaaaa', { property: 'padding', value: '1rem' });
    expect(out.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
    expect(out).toContain('color: red;');
    expect(out).toContain('padding: 1rem;');
  });

  it('does not claim a descendant selector that merely mentions the marker', () => {
    // `[..="a"] [data-osw-id]` is a different rule from `[..="a"][data-osw-id]`.
    const hand = '[data-osw-id="aaaaaaaa"] [data-osw-id] { color: red; }\n';
    const out = upsertDeclaration(hand, 'aaaaaaaa', { property: 'color', value: 'blue' });
    expect(out).toContain('[data-osw-id="aaaaaaaa"] [data-osw-id] { color: red; }');
    expect(out.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
  });

  it('keeps a hand-written comment inside an owned block', () => {
    let out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    out = out.replace('  color: red;', '  /* why */\n  color: red;');
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'padding', value: '1rem' });
    expect(out).toContain('/* why */');
  });

  it('does not accumulate blank lines across repeated upserts', () => {
    let out = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    for (let i = 0; i < 5; i++) {
      out = upsertDeclaration(out, 'aaaaaaaa', { property: 'color', value: `c${i}` });
    }
    expect(out).not.toMatch(/\n\s*\n\s*\n/);
  });
});

describe('removeDeclaration', () => {
  /** Two properties on one marker, plus a hand-written rule that must survive everything. */
  const seeded = (): string => {
    const hand = '/* keep me */\n.thing { color: hotpink; }\n';
    let out = upsertDeclaration(hand, 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'aaaaaaaa', { property: 'padding-block', value: '1rem' });
    return upsertDeclaration(out, 'bbbbbbbb', { property: 'color', value: 'blue' });
  };

  it('removes only the named declaration and leaves the rest of the block alone', () => {
    const after = removeDeclaration(seeded(), 'aaaaaaaa', 'color');
    expect(after).not.toContain('color: red;');
    expect(after).toContain('padding-block: 1rem;');
    // The block is still there, still one of it, still keyed to the same marker.
    expect(after.match(BLOCK('aaaaaaaa'))).toHaveLength(1);
  });

  it('removes the whole block once its last declaration goes', () => {
    let after = removeDeclaration(seeded(), 'aaaaaaaa', 'color');
    after = removeDeclaration(after, 'aaaaaaaa', 'padding-block');
    // Not an empty rule: an empty rule reads as an override that failed rather than one never made.
    expect(after).not.toContain('aaaaaaaa');
    expect(after.match(BLOCK('aaaaaaaa'))).toBeNull();
    expect(after).not.toMatch(/\{\s*\}/);
  });

  it('takes the block with it when only a comment would be left behind', () => {
    // `parseBody` keeps hand-written comments as items so re-emitting a block does not delete them.
    // That is right while the block still declares something; once the last declaration goes, a
    // block holding nothing but a comment is an override that no longer exists, still occupying the
    // file and still claiming the marker.
    const seeded = SELECTOR('aaaaaaaa') + ' {\n  /* why this one is pinned */\n  color: red;\n}\n';
    const after = removeDeclaration(seeded, 'aaaaaaaa', 'color');

    expect(after).not.toContain('aaaaaaaa');
    expect(after).not.toContain('why this one is pinned');
    expect(after).not.toMatch(/\{[^}]*\}/);
  });

  it('leaves every other marker, and every hand-written rule, exactly as they were', () => {
    let after = removeDeclaration(seeded(), 'aaaaaaaa', 'color');
    after = removeDeclaration(after, 'aaaaaaaa', 'padding-block');
    expect(after).toContain('bbbbbbbb');
    expect(after).toContain('color: blue;');
    expect(after).toContain('/* keep me */');
    expect(after).toContain('.thing { color: hotpink; }');
  });

  it('is a no-op for a marker that owns nothing, and for a property it never set', () => {
    const hand = '/* keep me */\n.thing { color: hotpink; }\n';
    expect(removeDeclaration(hand, 'aaaaaaaa', 'color')).toBe(hand);
    const css = seeded();
    expect(removeDeclaration(css, 'aaaaaaaa', 'margin-block')).toBe(css);
  });

  it('matches the property however it is cased', () => {
    const css = upsertDeclaration('', 'aaaaaaaa', { property: 'Color', value: 'red' });
    expect(removeDeclaration(css, 'aaaaaaaa', 'color')).not.toContain('red');
  });

  it('clears the property out of EVERY block the marker owns, not just the last', () => {
    // Only reachable by hand-editing, and the case that matters: `upsertDeclaration` edits the last
    // block, so a removal that did the same would leave an earlier duplicate still overriding the
    // property — a Reset the user watches fail.
    const doubled = upsertDeclaration(
      upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' })
        + '\n[data-osw-id="aaaaaaaa"][data-osw-id] { color: green; padding: 0; }\n',
      'aaaaaaaa',
      { property: 'margin', value: '0' },
    );
    const after = removeDeclaration(doubled, 'aaaaaaaa', 'color');
    expect(after).not.toContain('color: red;');
    expect(after).not.toContain('color: green;');
    expect(after).toContain('padding: 0;');
  });

  it('refuses the same ambiguity the writer refuses', () => {
    const commented = '/* [data-osw-id="aaaaaaaa"][data-osw-id] mentioned */\n.victim { color: hotpink; }\n';
    expect(() => removeDeclaration(commented, 'aaaaaaaa', 'color')).toThrow();

    const nested = '@media (min-width: 40em) {\n  [data-osw-id="aaaaaaaa"][data-osw-id] { color: red; }\n}\n';
    expect(() => removeDeclaration(nested, 'aaaaaaaa', 'color')).toThrow();
  });

  it('refuses an unsafe property name and an unsafe marker id', () => {
    const css = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    expect(() => removeDeclaration(css, 'aaaaaaaa', 'color; } body { color')).toThrow();
    expect(() => removeDeclaration(css, 'a"a', 'color')).toThrow();
  });
});

describe('removeMarkerBlock', () => {
  it('removes only that block and leaves everything else byte-exact', () => {
    const hand = '/* keep me */\n.thing { color: hotpink; }\n';
    let out = upsertDeclaration(hand, 'aaaaaaaa', { property: 'color', value: 'red' });
    out = upsertDeclaration(out, 'bbbbbbbb', { property: 'color', value: 'blue' });
    const after = removeMarkerBlock(out, 'aaaaaaaa');
    expect(after).not.toContain('aaaaaaaa');
    expect(after).toContain('bbbbbbbb');
    expect(after).toContain('/* keep me */');            // guards a delete-from-start bug
    expect(after).toContain('.thing { color: hotpink; }');
  });

  it('removes every block the marker owns, not just one of them', () => {
    // `upsertDeclaration` keeps a marker to a single block, so two is a file that was hand-edited or
    // written by an older build — exactly the file this has to survive. The blocks are cut back to
    // front because the offsets were all measured against the original string: cutting the first one
    // first shifts every later offset and the second cut lands mid-rule, splicing the file into
    // something that no longer parses.
    const css = [
      '/* keep me */',
      '.thing { color: hotpink; }',
      SELECTOR('aaaaaaaa') + ' { color: red; }',
      '.between { margin: 0; }',
      SELECTOR('aaaaaaaa') + ' { padding-block: 1rem; }',
      '.after { display: block; }',
      '',
    ].join('\n');

    const after = removeMarkerBlock(css, 'aaaaaaaa');

    expect(after).not.toContain('aaaaaaaa');
    expect(after).not.toContain('color: red');
    expect(after).not.toContain('padding-block: 1rem');
    // Everything that was not the marker's survives, intact and in order — the assertion that a
    // front-to-back cut fails, because it leaves a fragment of the second block behind.
    expect(after).toContain('/* keep me */');
    expect(after).toContain('.thing { color: hotpink; }');
    expect(after).toContain('.between { margin: 0; }');
    expect(after).toContain('.after { display: block; }');
    expect(after.match(/\{/g) ?? []).toHaveLength(3);
  });

  it('is a no-op when the marker owns no block', () => {
    const hand = '/* keep me */\n.thing { color: hotpink; }\n';
    expect(removeMarkerBlock(hand, 'aaaaaaaa')).toBe(hand);
  });
});

describe('declaredProperties', () => {
  it('names what the marker actually overrides, in the order the block declares it', () => {
    let css = upsertDeclaration('', 'aaaaaaaa', { property: 'color', value: 'red' });
    css = upsertDeclaration(css, 'aaaaaaaa', { property: 'padding-block', value: '1rem' });
    css = upsertDeclaration(css, 'bbbbbbbb', { property: 'background-color', value: 'blue' });
    expect(declaredProperties(css, 'aaaaaaaa')).toEqual(['color', 'padding-block']);
    // And it is per marker: the other element's block is not this element's to reset.
    expect(declaredProperties(css, 'bbbbbbbb')).toEqual(['background-color']);
  });

  it('answers [] for a file with no block for this marker, and for an empty file', () => {
    const hand = '/* keep me */\n.thing { color: hotpink; }\n';
    expect(declaredProperties(hand, 'aaaaaaaa')).toEqual([]);
    expect(declaredProperties('', 'aaaaaaaa')).toEqual([]);
  });

  it('lowercases, and does not report a hand-written comment as a property', () => {
    const css = '[data-osw-id="aaaaaaaa"][data-osw-id] {\n  /* mine */\n  COLOR: red;\n}\n';
    expect(declaredProperties(css, 'aaaaaaaa')).toEqual(['color']);
  });

  it('refuses the same ambiguous files the writers refuse, rather than under-reporting', () => {
    // Nested in an at-rule: `removeDeclaration` will not edit there, so reporting the property as
    // resettable would offer a control that can only refuse.
    const nested = '@media (min-width: 40em) {\n  [data-osw-id="aaaaaaaa"][data-osw-id] { color: red; }\n}\n';
    expect(() => declaredProperties(nested, 'aaaaaaaa')).toThrow(/nested/);
    const commented = '/* [data-osw-id="aaaaaaaa"] was here */\n.thing { color: red; }\n';
    expect(() => declaredProperties(commented, 'aaaaaaaa')).toThrow(/comment/);
  });
});

describe('width blocks', () => {
  const A = 'aaaaaaaa';
  const B = 'bbbbbbbb';
  /** Managed width blocks, not the header's mention of them. */
  const MEDIA = /@media \(max-width: ?\d+px\)/g;
  /** Where each needle first appears, so order can be asserted without pinning the whole file. */
  const at = (css: string, ...needles: string[]) => needles.map((n) => css.indexOf(n));

  it('writes a width rule inside a managed @media block after the rules for every width', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'red' });
    css = upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640);
    expect(css).toContain(`@media (max-width: 640px) {\n  ${SELECTOR(A)} {\n    color: blue;\n  }\n}`);
    const [top, media] = at(css, `${SELECTOR(A)} {\n  color: red;`, '@media (max-width: 640px)');
    expect(top).toBeGreaterThan(-1);
    expect(media).toBeGreaterThan(top);
  });

  it('keeps width blocks widest first, whatever order they were written in', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, A, { property: 'color', value: 'green' }, 1024);
    css = upsertDeclaration(css, A, { property: 'color', value: 'grey' }, 860);
    const [w1024, w860, w640] = at(css, '(max-width: 1024px)', '(max-width: 860px)', '(max-width: 640px)');
    expect(w1024).toBeLessThan(w860);
    expect(w860).toBeLessThan(w640);
  });

  it('puts a new rule for every width before the width blocks, so they still win on order', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, B, { property: 'color', value: 'red' });
    const [top, media] = at(css, SELECTOR(B), '@media (max-width: 640px)');
    expect(top).toBeLessThan(media);
  });

  it('adds to the element\'s rule in that width, and gives another element its own rule in the same block', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, A, { property: 'padding', value: '1rem' }, 640);
    css = upsertDeclaration(css, B, { property: 'color', value: 'red' }, 640);
    expect(css.match(MEDIA)).toHaveLength(1);
    expect(css.match(BLOCK(A))).toHaveLength(1);
    expect(declaredByScope(css, A).get(640)).toEqual({ color: 'blue', padding: '1rem' });
    expect(declaredByScope(css, B).get(640)).toEqual({ color: 'red' });
  });

  it('reads each scope apart, and leaves the other scopes alone on removal', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'red' });
    css = upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640);
    expect(declaredProperties(css, A)).toEqual(['color']);
    expect(declaredProperties(css, A, 640)).toEqual(['color']);
    expect(declaredProperties(css, A, 1024)).toEqual([]);
    css = removeDeclaration(css, A, 'color', 640);
    expect(declaredByScope(css, A)).toEqual(new Map([['all', { color: 'red' }]]));
    // The width block held nothing else, so it went too.
    expect(css.match(MEDIA)).toBeNull();
  });

  it('keeps a width block that still holds someone else\'s rule, byte-exact', () => {
    const hand = '@media (max-width: 640px) {\n  .nav { display: none; }\n}\n';
    let css = upsertDeclaration(hand, A, { property: 'color', value: 'blue' }, 640);
    expect(css.match(MEDIA)).toHaveLength(1);
    css = removeDeclaration(css, A, 'color', 640);
    expect(css).toBe(hand);
  });

  it('does not double the indentation of the next rule when an earlier one is removed', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, B, { property: 'color', value: 'red' }, 640);
    css = removeDeclaration(css, A, 'color', 640);
    expect(css).toContain(`\n  ${SELECTOR(B)} {\n    color: red;\n  }\n}`);
    expect(css).not.toMatch(/\n {3,}\[data-osw-id="bbbbbbbb"\]/);
  });

  it('recognises a reformatted managed block as the same width', () => {
    const css = `@media (max-width:640px){${SELECTOR(A)}{color:blue}}\n`;
    const out = upsertDeclaration(css, A, { property: 'padding', value: '1rem' }, 640);
    expect(out.match(MEDIA)).toHaveLength(1);
    expect(declaredByScope(out, A).get(640)).toEqual({ color: 'blue', padding: '1rem' });
  });

  it('still refuses a marker rule in any other at-rule, or nested inside a width block', () => {
    const other = `@media (min-width: 40em) {\n  ${SELECTOR(A)} { color: red; }\n}\n`;
    const printed = `@media print {\n  ${SELECTOR(A)} { color: red; }\n}\n`;
    const deeper = `@media (max-width: 640px) {\n  @supports (display: grid) {\n    ${SELECTOR(A)} { color: red; }\n  }\n}\n`;
    for (const css of [other, printed, deeper]) {
      expect(() => upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640)).toThrow(/nested/);
      expect(() => upsertDeclaration(css, A, { property: 'color', value: 'blue' })).toThrow(/nested/);
    }
  });

  it('applies a batch of sets and removals as one result', () => {
    let css = upsertDeclaration('', A, { property: 'width', value: '320px' }, 640);
    css = applyChanges(css, A, 640, [
      { property: 'width', value: null },
      { property: 'flex', value: '1 1 0' },
    ]);
    expect(declaredByScope(css, A).get(640)).toEqual({ flex: '1 1 0' });
  });

  it('refuses the whole batch when one change is unsafe, leaving nothing applied', () => {
    const css = upsertDeclaration('', A, { property: 'width', value: '320px' });
    expect(() => applyChanges(css, A, 'all', [
      { property: 'width', value: null },
      { property: 'color', value: 'red; } body {' },
    ])).toThrow(/unsafe/);
    expect(() => applyChanges(css, A, 'all', [{ property: 'color; }', value: null }])).toThrow(/unsafe/);
  });

  it('shows the element\'s blocks as the file has them, cut down to its own rules', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'red' });
    css = upsertDeclaration(css, B, { property: 'color', value: 'green' }, 640);
    css = upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640);
    expect(markerBlocksText(css, A)).toBe(
      `${SELECTOR(A)} {\n  color: red;\n}\n\n@media (max-width: 640px) {\n  ${SELECTOR(A)} {\n    color: blue;\n  }\n}`,
    );
    expect(markerBlocksText(css, 'cccccccc')).toBe('');
  });

  it('clears one scope, and only that scope', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'red' });
    css = upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, B, { property: 'color', value: 'green' }, 640);
    const cleared = clearScope(css, A, 640);
    expect(declaredByScope(cleared, A)).toEqual(new Map([['all', { color: 'red' }]]));
    expect(declaredByScope(cleared, B).get(640)).toEqual({ color: 'green' });
    expect(clearScope(clearScope(cleared, B, 640), A, 'all')).toBe(`${OVERRIDES_HEADER}\n\n`);
  });

  it('removes a marker at every width with removeMarkerBlock', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'red' });
    css = upsertDeclaration(css, A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, A, { property: 'color', value: 'grey' }, 1024);
    expect(declaredByScope(removeMarkerBlock(css, A), A).size).toBe(0);
  });

  it('lists the widths the file has managed blocks for, widest first', () => {
    let css = upsertDeclaration('', A, { property: 'color', value: 'blue' }, 640);
    css = upsertDeclaration(css, A, { property: 'color', value: 'grey' }, 1024);
    css += '@media (min-width: 40em) { .x { color: red; } }\n';
    expect(managedWidths(css)).toEqual([1024, 640]);
    // Written by hand narrowest first.
    const hand = `@media (max-width: 640px) {\n  ${SELECTOR(A)} { color: red; }\n}\n@media (max-width: 1024px) {\n  ${SELECTOR(A)} { color: blue; }\n}\n`;
    expect(managedWidths(hand)).toEqual([1024, 640]);
  });
});

describe('a custom property', () => {
  // `--cardBg` and `--cardbg` are two properties: custom property names are case-sensitive, where
  // every other property name is not.
  const A = 'aaaaaaaa';
  const two = () => applyChanges('', A, 'all', [{ property: '--cardBg', value: 'red' }, { property: '--cardbg', value: 'blue' }]);

  it('is kept apart from one that differs only in case, and read back as it is spelled', () => {
    expect(declaredByScope(two(), A).get('all')).toEqual({ '--cardBg': 'red', '--cardbg': 'blue' });
    expect(declaredProperties(two(), A)).toEqual(['--cardBg', '--cardbg']);
  });

  it('is changed, taken off and made to win under its own spelling only', () => {
    expect(declaredByScope(applyChanges(two(), A, 'all', [{ property: '--cardbg', value: 'green' }]), A).get('all'))
      .toEqual({ '--cardBg': 'red', '--cardbg': 'green' });
    expect(declaredByScope(removeDeclaration(two(), A, '--cardBg'), A).get('all')).toEqual({ '--cardbg': 'blue' });
    const strong = strengthenDeclarations(two(), A, ['--cardBg']);
    expect(importantProperties(strong, A)).toEqual(['--cardBg']);
    expect(markerBlocksText(strong, A)).toContain('--cardBg: red !important;\n  --cardbg: blue;');
  });

  it('leaves an ordinary property matched in any case', () => {
    const css = applyChanges('', A, 'all', [{ property: 'Color', value: 'red' }, { property: 'COLOR', value: 'blue' }]);
    expect(declaredByScope(css, A).get('all')).toEqual({ color: 'blue' });
  });
});

describe('a block that holds a nested rule', () => {
  // CSS nesting written by hand into an element's block. Its body is not declarations alone, so
  // rewriting it as declarations would drop the nested rule's closing brace and leave the block open
  // over every rule after it.
  const A = 'aaaaaaaa';
  const NESTED = `${SELECTOR(A)} {\n  color: red;\n  &:hover {\n    color: blue;\n  }\n}\n.later { margin: 0; }\n`;
  const IN_WIDTH = `@media (max-width: 640px) {\n  ${SELECTOR(A)} {\n    color: red;\n    @media (hover: hover) { color: blue; }\n  }\n}\n`;

  it('is refused by every writer, at every width', () => {
    for (const [css, scope] of [[NESTED, 'all'], [IN_WIDTH, 640]] as const) {
      expect(() => applyChanges(css, A, scope, [{ property: 'padding', value: '4px' }])).toThrow(/nested/);
      expect(() => upsertDeclaration(css, A, { property: 'color', value: 'green' }, scope)).toThrow(/nested/);
      expect(() => removeDeclaration(css, A, 'color', scope)).toThrow(/nested/);
      expect(() => strengthenDeclarations(css, A, ['color'])).toThrow(/nested/);
    }
  });

  it('is refused by every reader, rather than read as declarations', () => {
    for (const css of [NESTED, IN_WIDTH]) {
      expect(() => declaredByScope(css, A)).toThrow(/nested/);
      expect(() => importantProperties(css, A)).toThrow(/nested/);
    }
    expect(() => declaredProperties(NESTED, A)).toThrow(/nested/);
    expect(() => declaredProperties(IN_WIDTH, A, 640)).toThrow(/nested/);
  });

  it('is not read into by a brace inside a string or parentheses', () => {
    const css = `${SELECTOR(A)} {\n  content: "{";\n  background: url(a{b}.png);\n}\n`;
    expect(declaredByScope(css, A).get('all')).toEqual({ content: '"{"', background: 'url(a{b}.png)' });
  });

  it('stays byte for byte when another element is edited around it', () => {
    const out = applyChanges(NESTED, 'bbbbbbbb', 'all', [{ property: 'color', value: 'green' }]);
    expect(out.startsWith(NESTED)).toBe(true);
    expect(declaredByScope(out, 'bbbbbbbb').get('all')).toEqual({ color: 'green' });
  });
});
