// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STYLE_PREVIEW_JS, STYLE_LOCATOR_JS, OVERRIDES_STYLE_ATTR } from '../style-preview';
import type { OverrideRuleLocation } from '../style-preview';

/**
 * The two lookups, run out of the *emitted* text against a live document.
 *
 * They are two, and they answer different questions. `__oswLocateOverrideRule` finds **our** rule,
 * so the probe can tell that one is in the document at all; `__oswRankDeclaration` ranks every
 * declaration of a property that reaches the element — ours included — and hands back the one the
 * cascade picks, flagged `ours` when it is the override's own. Neither is a step of the other.
 *
 * `ours` is the load-bearing field. "Did the override apply" is that flag and nothing else: a
 * comparison of rendered values before and against after cannot tell an override in force from one
 * that happens to agree with what the element already had.
 *
 * ## What jsdom can and cannot stand in for — measured, not assumed
 *
 * - **jsdom never loads `<link>`.** `document.styleSheets` is empty with one present, so the
 *   "some other stylesheet" branch below is staged as a second `<style>`. That makes it a **proxy**
 *   for the real thing: what it proves is that the scan reaches past the transient element and
 *   hands back the right element and rule, not that a blob `<link>` behaves the same way. The
 *   `<link>` case is Chrome-only and belongs to the e2e spec.
 * - **`window.matchMedia` answers `false` for everything in jsdom** — measured — so the `@media`
 *   arm of the ranking cannot be exercised here at all. It is asserted in e2e.
 * - **`sheet.ownerNode` and `sheet.href` are `undefined` in jsdom**, correct in Chrome. The first is
 *   why the locator is element-first at all — a `document.styleSheets` walk could not hand back an
 *   element here. The second is why the sheet-to-origin *wiring* is not tested in this file: no
 *   jsdom sheet can carry a blob href, and faking one would be a test of the fake. The pure mapping
 *   is tested directly instead, and the wiring is covered only in e2e.
 * - **Every page stylesheet in this environment resolves to the same origin string** (`a
 *   stylesheet`, since none has an href), so which of two competing *sheets* won is not observable
 *   here. The ranking is exercised through the cases whose origins do differ — inline against a
 *   normal rule, and inline against an `!important` one — and through the comparator directly.
 */
interface RankedDeclaration {
  important: boolean;
  specificity: number;
  order: number;
  origin: string;
  /** The declaration as written. */
  value: string;
  /** The winner is the override's own declaration — the definition of "the change applied". */
  ours: boolean;
}

const frame = new Function(
  `${STYLE_PREVIEW_JS}${STYLE_LOCATOR_JS}\nreturn {
     apply: __oswApplyOverrides,
     locate: __oswLocateOverrideRule,
     rank: __oswRankDeclaration,
     specified: __oswSpecifiedValues,
     resolveOrigin: __oswResolveSheetOrigin,
     specificity: __oswSpecificity,
     beats: __oswBeats,
     declared: __oswDeclared
   };`,
)() as {
  /** Swaps in a whole /overrides.css. */
  apply: (css: string) => Element | null;
  specified: (el: Element | null, properties: unknown) => Record<string, { value: string; origin: string; ours: boolean } | null>;
  /** Typed against the declared contract, so a locator that stopped returning an element is a
   *  type error here as well as a failing assertion. */
  locate: (markerId: string) => OverrideRuleLocation | null;
  rank: (el: Element | null, property: string, ourSelector: string | null) => RankedDeclaration | null;
  resolveOrigin: (href: unknown, blobMap: unknown) => string | null;
  specificity: (selector: string) => number;
  beats: (candidate: unknown, best: unknown) => boolean;
  declared: (style: { getPropertyValue: (name: string) => string }, property: string) => { value: string; name: string } | null;
};

const SELECTOR = '[data-osw-id="m1"][data-osw-id]';

/** The winner's origin, or `null` when nothing reachable declares the property. */
function winnerOf(el: Element | null, property: string): string | null {
  return frame.rank(el, property, SELECTOR)?.origin ?? null;
}

function marked(): Element {
  return document.querySelector('[data-osw-id="m1"]')!;
}

/** A page stylesheet, staged as a `<style>` for the reason given at the top of this file. */
function pageSheet(css: string): HTMLStyleElement {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div class="card" id="hero" data-osw-id="m1">marked</div>';
});

describe('locating our own rule', () => {
  it('finds it in the swapped-in /overrides.css, and names that file', () => {
    frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);

    const found = frame.locate('m1')!;

    expect(found).not.toBeNull();
    expect(found.element).toBe(document.querySelector(`style[${OVERRIDES_STYLE_ATTR}]`));
    expect(found.rule.selectorText).toBe(SELECTOR);
    expect(found.rule.style.getPropertyValue('color')).toBe('rgb(1, 2, 3)');
    expect(found.origin).toBe('/overrides.css');
  });

  it('finds it inside a width block', () => {
    // The probe's gate is "our rule is in the document", and a width block's rule is ours too.
    frame.apply(`@media (max-width: 640px) {\n  ${SELECTOR} { color: rgb(4, 4, 4); }\n}`);

    const found = frame.locate('m1')!;

    expect(found).not.toBeNull();
    expect(found.rule.style.getPropertyValue('color')).toBe('rgb(4, 4, 4)');
  });

  it('finds it in another stylesheet when the transient is absent', () => {
    const sheetEl = pageSheet(`.other { color: red; }\n${SELECTOR} { color: rgb(7, 7, 7); }`);

    const found = frame.locate('m1')!;

    expect(found).not.toBeNull();
    expect(found.element).toBe(sheetEl);
    expect(found.rule.style.getPropertyValue('color')).toBe('rgb(7, 7, 7)');
    // No href on a <style>, and a blob id would name nothing anyway — see the file header.
    expect(found.origin).toBe('a stylesheet');
  });

  it('hands back the owning ELEMENT, not just the sheet', () => {
    // The probe's gate is "our rule is in the document", and only the element answers that — a
    // `CSSStyleSheet` handle outlives its node. `sheet.ownerNode` is undefined in jsdom, so a
    // locator that returned only a sheet could not be turned back into one here, and the caller
    // could not tell, because the sheet handle itself looks fine.
    pageSheet(`${SELECTOR} { color: rgb(7, 7, 7); }`);
    const found = frame.locate('m1')!;
    expect(window.getComputedStyle(marked()).color).toBe('rgb(7, 7, 7)');

    found.element.remove();

    expect(window.getComputedStyle(marked()).color).not.toBe('rgb(7, 7, 7)');
  });

  it('takes the last of several blocks for one marker, as the CSS writer does', () => {
    // Duplicates have equal specificity, so the later one is what the user is looking at and the
    // only one whose removal changes anything. Both spellings of "later" are checked: a second
    // block inside one sheet, and a second sheet — an implementation can get one right and the
    // other wrong, and each is reachable by hand-editing /overrides.css.
    const sheetEl = pageSheet(
      `${SELECTOR} { color: rgb(7, 7, 7); }\n${SELECTOR} { color: rgb(8, 8, 8); }`,
    );

    expect(frame.locate('m1')!.rule.style.getPropertyValue('color')).toBe('rgb(8, 8, 8)');
    expect(window.getComputedStyle(marked()).color).toBe('rgb(8, 8, 8)');

    const later = pageSheet(`${SELECTOR} { color: rgb(9, 9, 9); }`);

    const found = frame.locate('m1')!;
    expect(found.element).toBe(later);
    expect(found.element).not.toBe(sheetEl);
    expect(window.getComputedStyle(marked()).color).toBe('rgb(9, 9, 9)');
  });

  it('returns null when nothing carries it', () => {
    pageSheet('.card { color: red; }');

    expect(frame.locate('m1')).toBeNull();
    expect(frame.locate('m2')).toBeNull();
    // An id that could not have been written into the file cannot own a block either.
    expect(frame.locate('m1" ] {')).toBeNull();
  });

  it('is not fooled by a descendant selector that differs only in a space', () => {
    // `[…="m1"] [data-osw-id]` selects something else entirely. Collapsing whitespace instead of
    // stripping it is what keeps the two apart — and removing a hand-written rule that is not ours
    // would be a silent edit to the user's page.
    pageSheet('[data-osw-id="m1"] [data-osw-id] { color: rgb(7, 7, 7); }');

    expect(frame.locate('m1')).toBeNull();
  });
});

describe('resolving a sheet to something a person recognises', () => {
  // Tested as a pure function, with the map passed in. Every preview stylesheet is rewritten to a
  // blob URL, and `window.__oswVfsBlobUrls` — injected in `components/preview/multipage-preview.tsx`
  // beside the per-load marker — is the only thing that maps one back to a path. No jsdom sheet can
  // carry a blob href, so the alternative would be a test of a stubbed `document.styleSheets`,
  // which asserts on the stub. The sheet-to-origin wiring is covered in e2e.
  const blobMap = {
    '/styles.css': 'blob:http://localhost:3000/8c39ad3e-1111-2222-3333-444455556666',
    '/overrides.css': 'blob:http://localhost:3000/aaaaaaaa-1111-2222-3333-444455556666',
  };

  it('inverts the blob map to a VFS path', () => {
    expect(frame.resolveOrigin(blobMap['/overrides.css'], blobMap)).toBe('/overrides.css');
    expect(frame.resolveOrigin(blobMap['/styles.css'], blobMap)).toBe('/styles.css');
  });

  it('never hands back a blob id', () => {
    // 'blob:http://localhost:3000/8c39ad3e-…' in a message is the generic text people learn to
    // ignore. Unknown is better said as nothing.
    expect(frame.resolveOrigin('blob:http://localhost:3000/unmapped-0000', blobMap)).toBeNull();
    expect(frame.resolveOrigin('blob:http://localhost:3000/unmapped-0000', null)).toBeNull();
  });

  it('keeps a real URL, which does name something', () => {
    expect(frame.resolveOrigin('https://cdn.example.com/reset.css', blobMap))
      .toBe('https://cdn.example.com/reset.css');
  });

  it('answers null for a sheet with no href at all', () => {
    expect(frame.resolveOrigin(null, blobMap)).toBeNull();
    expect(frame.resolveOrigin(undefined, blobMap)).toBeNull();
    expect(frame.resolveOrigin('', blobMap)).toBeNull();
  });
});

describe('ranking who wins the cascade', () => {
  it('names the inline style attribute', () => {
    pageSheet('.card { color: rgb(7, 7, 7); }');
    (marked() as HTMLElement).style.color = 'rgb(3, 3, 3)';

    // The one loss jsdom gets right — and it outranks every normal rule whatever its specificity.
    expect(winnerOf(marked(), 'color')).toBe('inline style');
  });

  it('lets an !important rule outrank an inline declaration', () => {
    pageSheet('.card { color: rgb(7, 7, 7) !important; }');
    (marked() as HTMLElement).style.color = 'rgb(3, 3, 3)';

    expect(winnerOf(marked(), 'color')).toBe('a stylesheet');
  });

  it('names a plain rule when there is no inline declaration', () => {
    pageSheet('.card { color: rgb(7, 7, 7); }');

    expect(winnerOf(marked(), 'color')).toBe('a stylesheet');
  });

  it('flags our own rule as ours rather than pretending it is not there', () => {
    // The change from the toggle-based probe, and the whole fix. Our declaration is ranked like
    // any other; `ours` is what turns "who won" into "did the override apply". Excluding it —
    // which the old winner scan did — leaves nothing to compare the answer against.
    frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);

    const best = frame.rank(marked(), 'color', SELECTOR)!;

    expect(best).not.toBeNull();
    expect(best.ours).toBe(true);
    expect(best.origin).toBe('/overrides.css');
  });

  it('flags a rule that is not ours, whatever sheet it is in', () => {
    // The post-recompile shape: our rule sits in an ordinary sheet, and so does the competitor.
    // Nothing about the *sheet* says which is which — only the marker selector does.
    pageSheet(`${SELECTOR} { color: rgb(1, 2, 3); }`);
    (marked() as HTMLElement).style.color = 'rgb(3, 3, 3)';

    const best = frame.rank(marked(), 'color', SELECTOR)!;

    expect(best.ours).toBe(false);
    expect(best.origin).toBe('inline style');
  });

  it('recognises our rule in an ordinary sheet, not only in the swapped-in file', () => {
    pageSheet(`${SELECTOR} { color: rgb(1, 2, 3); }`);

    expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(true);
  });

  it('ignores a rule that does not match, and one that does not set the property', () => {
    pageSheet('.elsewhere { color: rgb(7, 7, 7); }');
    pageSheet('.card { font-weight: 700; }');

    expect(frame.rank(marked(), 'color', SELECTOR)).toBeNull();
  });

  it('answers null rather than throwing for a missing element or property', () => {
    expect(frame.rank(null, 'color', SELECTOR)).toBeNull();
    expect(frame.rank(marked(), '', SELECTOR)).toBeNull();
  });

  it('survives a selector the engine refuses', () => {
    // `el.matches` throws on an unsupported selector rather than returning false, and one bad rule
    // in a user's stylesheet must not take the whole scan down.
    pageSheet(':has(> .nope) { color: rgb(7, 7, 7); }');
    pageSheet('.card { color: rgb(5, 5, 5); }');

    expect(winnerOf(marked(), 'color')).toBe('a stylesheet');
  });

  it('leaves a rule inside a group it cannot vouch for out of the ranking', () => {
    // `@supports` and `@layer` are not walked: their conditions cannot be re-evaluated here
    // cheaply and honestly, and @layer would need __oswBeats to model layer order, which it does
    // not. Naming a rule that is not in force is worse than naming nothing.
    pageSheet('@supports (color: red) { .card { color: rgb(7, 7, 7); } }');

    expect(frame.rank(marked(), 'color', SELECTOR)).toBeNull();
  });

  it('ranks a grouped rule by the part of its list that reaches the element', () => {
    // `.nav a, .footer a` is two selectors of 101 each, and only one of them reaches a link in the
    // nav: the rule carries 101 against the override's 200, not the 202 of the two together.
    document.body.innerHTML = '<nav class="nav"><a class="card" id="hero" data-osw-id="m1" href="#">x</a></nav>';
    frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);
    pageSheet('.nav a, .footer a { color: rgb(7, 7, 7); }');

    expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(true);
  });

  it('takes the most specific of the parts that match, and none that do not', () => {
    frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);
    // The id names another element; `.card` (100) is what reaches this one.
    pageSheet('#elsewhere, .card { color: rgb(7, 7, 7); }');
    expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(true);

    pageSheet('.elsewhere, .card, #hero { color: rgb(9, 9, 9); }');
    expect(frame.rank(marked(), 'color', SELECTOR)).toMatchObject({ ours: false, value: 'rgb(9, 9, 9)' });
  });

  it('splits a list only at its own commas, not those inside a pseudo-class or a quoted value', () => {
    frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);
    // The first part carries an id and reaches the element; `:not()` and the attribute value each
    // hold a comma of their own, and a part cut at either would match nothing.
    pageSheet(':not(.x, .y)#hero[title="a,b"], .elsewhere { color: rgb(7, 7, 7); }');
    marked().setAttribute('title', 'a,b');

    expect(frame.rank(marked(), 'color', SELECTOR)).toMatchObject({ ours: false, value: 'rgb(7, 7, 7)' });
  });

  describe('a stylesheet that is not in force', () => {
    const real = (window as { matchMedia?: unknown }).matchMedia;
    afterEach(() => {
      (window as { matchMedia?: unknown }).matchMedia = real;
    });

    it('leaves out a sheet whose own media does not match the frame', () => {
      // jsdom has no matchMedia; this one answers as a screen at any width would.
      (window as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query === 'screen' });
      frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);
      pageSheet('.card { color: rgb(7, 7, 7) !important; }').setAttribute('media', 'print');
      expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(true);

      pageSheet('.card { color: rgb(9, 9, 9) !important; }').setAttribute('media', 'screen');
      expect(frame.rank(marked(), 'color', SELECTOR)).toMatchObject({ ours: false, value: 'rgb(9, 9, 9)' });
    });

    it('leaves out a disabled sheet', () => {
      frame.apply(`${SELECTOR} { color: rgb(1, 2, 3); }`);
      const sheet = pageSheet('.card { color: rgb(7, 7, 7) !important; }').sheet!;
      expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(false);

      sheet.disabled = true;
      expect(frame.rank(marked(), 'color', SELECTOR)!.ours).toBe(true);
    });
  });
});

describe('the ranking the winner scan uses', () => {
  // Two page stylesheets resolve to the same origin string here, so which of them won is not
  // observable through `__oswRankDeclaration` in jsdom. The comparator it ranks with is, and it is
  // the part that can be got wrong.
  const at = (important: boolean, specificity: number, order: number) =>
    ({ important, specificity, order, origin: 'x' });

  it('puts importance above specificity, and specificity above order', () => {
    expect(frame.beats(at(true, 100, 0), at(false, 10000, 9))).toBe(true);
    expect(frame.beats(at(false, 10000, 0), at(false, 100, 9))).toBe(true);
    expect(frame.beats(at(false, 100, 9), at(false, 100, 0))).toBe(true);
    expect(frame.beats(at(false, 100, 0), at(false, 100, 9))).toBe(false);
    expect(frame.beats(at(false, 100, 0), null)).toBe(true);
  });

  it('counts a selector the way the cascade does', () => {
    expect(frame.specificity(SELECTOR)).toBe(200);          // the doubled marker: two attributes
    expect(frame.specificity('#hero')).toBe(10000);
    expect(frame.specificity('div.card')).toBe(101);
    expect(frame.specificity('a:hover')).toBe(101);
    expect(frame.specificity('p::before')).toBe(2);
    expect(frame.specificity('*')).toBe(0);
    expect(frame.specificity('main > div.card span')).toBe(103);
    // A bracket inside a quoted attribute value does not end the attribute selector.
    expect(frame.specificity('[title="]"]')).toBe(100);
  });
});

describe('reading the winning declaration as written', () => {
  it('gives the value the stylesheet says, not the computed one, with where it came from', () => {
    pageSheet('.card { width: 100%; }');
    frame.apply(`${SELECTOR} { max-width: 40rem; }`);

    const out = frame.specified(marked(), ['width', 'max-width', 'height']);

    expect(out.width).toEqual({ value: '100%', origin: 'a stylesheet', ours: false });
    expect(out['max-width']).toEqual({ value: '40rem', origin: '/overrides.css', ours: true, under: null });
    expect(out.height).toBeNull();
  });

  it('answers an empty map for no element or no list', () => {
    expect(frame.specified(null, ['width'])).toEqual({});
    expect(frame.specified(marked(), 'width')).toEqual({});
  });

  it('reads a margin side from its physical twin, and takes whichever of the two wins', () => {
    // Longhands, because jsdom does not expand `margin: 0 auto` into them as Chrome does.
    pageSheet('.card { margin-left: auto; margin-right: auto; margin-top: 8px; }');
    expect(frame.specified(marked(), ['margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end'])).toEqual({
      'margin-inline-start': { value: 'auto', origin: 'a stylesheet', ours: false },
      'margin-inline-end': { value: 'auto', origin: 'a stylesheet', ours: false },
      'margin-block-start': { value: '8px', origin: 'a stylesheet', ours: false },
      'margin-block-end': null,
    });
    // The override's logical side outranks the page's physical one; a later physical one outranks it.
    frame.apply(`${SELECTOR} { margin-inline-start: 2rem; }`);
    expect(frame.specified(marked(), ['margin-inline-start'])['margin-inline-start']).toMatchObject({ value: '2rem', ours: true });
    pageSheet('#hero { margin-left: 3rem; }');
    expect(frame.specified(marked(), ['margin-inline-start'])['margin-inline-start']).toMatchObject({ value: '3rem', ours: false });
  });
});

describe('what applies without the override', () => {
  it('names the declaration ours beats, and nothing when ours stands alone', () => {
    pageSheet('.card { box-shadow: 0px 1px 2px red; }');
    frame.apply(`${SELECTOR} { box-shadow: 0px 8px 24px blue; color: rgb(1, 1, 1); }`);

    const out = frame.specified(marked(), ['box-shadow', 'color']) as Record<string, { ours: boolean; under?: { value: string; origin: string } | null }>;

    expect(out['box-shadow'].ours).toBe(true);
    expect(out['box-shadow'].under).toEqual({ value: '0px 1px 2px red', origin: 'a stylesheet' });
    expect(out.color.under).toBeNull();
  });
});

describe('what a rule declares for a longhand', () => {
  /**
   * A rule's style as Chrome answers it. A shorthand written with var() is kept whole, and each of
   * its longhands answers '' until the value is computed; jsdom's CSSOM does not model that, so the
   * style here is a stand-in with exactly those answers.
   */
  const style = (declarations: Record<string, string>) => ({ getPropertyValue: (name: string) => declarations[name] ?? '' });

  it('is the longhand itself when the rule has one', () => {
    expect(frame.declared(style({ 'margin-top': '8px', margin: '' }), 'margin-top')).toEqual({ value: '8px', name: 'margin-top' });
  });

  it('is the var() shorthand that sets it, where the longhand answers nothing', () => {
    // `.hero { margin: 0 var(--gutter) var(--section) }`: without this the rule was passed over
    // and `* { margin: 0 }` named as what sets the hero's margin.
    const hero = style({ margin: '0 var(--gutter) var(--section)', 'border-radius': 'var(--radius)' });
    expect(frame.declared(hero, 'margin-bottom')).toEqual({ value: '0 var(--gutter) var(--section)', name: 'margin' });
    expect(frame.declared(hero, 'border-top-left-radius')).toEqual({ value: 'var(--radius)', name: 'border-radius' });
    expect(frame.declared(style({ gap: 'var(--gap)' }), 'row-gap')).toMatchObject({ name: 'gap' });
    expect(frame.declared(style({ 'border-top': '1px solid var(--line)' }), 'border-top-width')).toMatchObject({ name: 'border-top' });
  });

  it('is nothing for a rule that does not set the property, a shorthand without var() included', () => {
    expect(frame.declared(style({ color: 'red' }), 'margin-top')).toBeNull();
    // A plain shorthand is expanded by the browser, so its longhands answer for themselves.
    expect(frame.declared(style({ padding: '4px' }), 'margin-top')).toBeNull();
    // Only a var() shorthand stands in for its longhands: a plain one that answers nothing for a
    // longhand does not set it.
    expect(frame.declared(style({ margin: '4px' }), 'margin-top')).toBeNull();
    expect(frame.declared(style({ padding: 'var(--pad)' }), 'margin-top')).toBeNull();
  });

  it('is a var() block or inline shorthand only for the sides on its own axis', () => {
    // Horizontal writing, as the panel's side names assume: block is top and bottom, inline is
    // left and right.
    const inline = style({ 'padding-inline': 'var(--space-4)' });
    expect(frame.declared(inline, 'padding-left')).toEqual({ value: 'var(--space-4)', name: 'padding-inline' });
    expect(frame.declared(inline, 'padding-inline-end')).toMatchObject({ name: 'padding-inline' });
    expect(frame.declared(inline, 'padding-top')).toBeNull();
    expect(frame.declared(inline, 'padding-block-start')).toBeNull();

    const block = style({ 'margin-block': 'var(--space-2)' });
    expect(frame.declared(block, 'margin-bottom')).toMatchObject({ name: 'margin-block' });
    expect(frame.declared(block, 'margin-block-start')).toMatchObject({ name: 'margin-block' });
    expect(frame.declared(block, 'margin-right')).toBeNull();
    expect(frame.declared(block, 'margin-inline-start')).toBeNull();
  });
});
