// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript, ESCAPE_CSS_IDENT_JS } from '../multipage-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * `selection-resolve` — turning a domPath back into a usable handle after a recompile.
 *
 * What the recompile actually kills is `nodeId`. The workspace's `focusContext` survives it (nothing
 * clears it on frame-ready), but the id inside it is frame-scoped, and every node-keyed message —
 * `style-query`, `style-probe`, `tree-select` — is keyed on exactly that. `domPath` is the only
 * field that outlives the document, so this is the round trip that makes the selection askable again.
 *
 * The escape is tested through the *emitted* text and by running the emitted function. `CSS.escape`
 * does not exist in jsdom — measured — so an implementation that reached for it would throw
 * `ReferenceError` here at first call, which is precisely why it is hand-written.
 *
 * One script instance for the whole file: each `new Function(...)` run installs another `message`
 * listener on the same jsdom window and would double every reply.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  payload?: FocusContextPayload | null;
}

const posted: PostedMessage[] = [];

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function only(type: string): PostedMessage {
  const matches = posted.filter(m => m.type === type);
  expect(matches, `expected exactly one ${type}, got ${posted.map(m => m.type).join(', ') || 'nothing'}`)
    .toHaveLength(1);
  return matches[0];
}

function clickSelect(selector: string): FocusContextPayload {
  posted.length = 0;
  send({ type: 'selector-toggle', active: true });
  document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return only('selector-selection').payload as FocusContextPayload;
}

function resolve(domPath: unknown): PostedMessage {
  posted.length = 0;
  send({ type: 'selection-resolve', domPath });
  return only('selection-resolved');
}

const MARKUP = '<main><section><p class="lead">a</p><p>b</p></section></main>';

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  document.body.innerHTML = MARKUP;
  posted.length = 0;
});

describe('selection-resolve', () => {
  it('returns a payload for a surviving element, with a nodeId that resolves in this document', () => {
    const before = clickSelect('.lead');

    const payload = resolve(before.domPath).payload as FocusContextPayload;

    expect(payload).not.toBeNull();
    expect(payload.tagName).toBe('p');
    expect(payload.domPath).toBe(before.domPath);
    // The point of the whole round trip: an id this document will answer to. Same element, so the
    // stamp already on it is reused — a *fresh* one would be minted only after a real recompile.
    expect(payload.nodeId).toMatch(/^\d+$/);
    expect(document.querySelector(`[data-osw-node="${payload.nodeId}"]`)).toBe(document.querySelector('.lead'));
  });

  it('builds the payload with the same builder a click uses', () => {
    const clicked = clickSelect('.lead');

    const resolved = resolve(clicked.domPath).payload as FocusContextPayload;

    // Field-by-field, so a second, subtly different kind of selection cannot appear here.
    expect(resolved).toEqual(clicked);
  });

  it('returns null for a path that no longer resolves, so the host can clear', () => {
    const before = clickSelect('.lead');
    // The whole branch, not just the one <p>: `domPath` is positional, so deleting the first of two
    // siblings leaves the second answering to `p:nth-of-type(1)`. That is a known property of a
    // positional path and not something this message can fix — it is why `nodeId` exists at all.
    document.querySelector('section')!.remove();

    expect(resolve(before.domPath).payload).toBeNull();
  });

  it('returns null instead of throwing for a path the engine refuses', () => {
    // A selector can arrive from a selection made before the escaping below existed, and a
    // SyntaxError out of querySelector would abort every branch after this one in the shared handler.
    expect(() => resolve('html > body > p:::nope')).not.toThrow();
    expect(resolve('html > body > p:::nope').payload).toBeNull();
    expect(resolve('').payload).toBeNull();
    expect(resolve(undefined).payload).toBeNull();
  });
});

describe('an id that needs escaping', () => {
  it('round-trips an id starting with a digit', () => {
    // '#1abc' is not a valid selector. Unescaped it throws; escaped with a bare backslash it reads
    // as codepoint U+1ABC and quietly selects nothing.
    document.body.innerHTML = '<main><p id="1abc">a</p></main>';

    const payload = clickSelect('#\\31 abc');

    // The path stops at the first element with an id, so this is the whole of it.
    expect(payload.domPath).toBe('p#\\31 abc');
    expect((resolve(payload.domPath).payload as FocusContextPayload).tagName).toBe('p');
  });

  it('round-trips an id containing a dot, a colon and a slash', () => {
    // Real ids from framework output. Unescaped, 'a.b' reads as "element a with class b".
    document.body.innerHTML = '<main><p id="a.b:c/d">a</p><p class="decoy">b</p></main>';

    const payload = clickSelect('main > p');

    expect(() => resolve(payload.domPath)).not.toThrow();
    const resolved = resolve(payload.domPath).payload as FocusContextPayload;
    expect(resolved).not.toBeNull();
    // The decoy exists so "resolved to a p" is not satisfied by an unescaped path that happens to
    // match a different one.
    expect(resolved.domPath).toBe(payload.domPath);
    expect(document.querySelector(`[data-osw-node="${resolved.nodeId}"]`)).toBe(document.getElementById('a.b:c/d'));
  });

  it('leaves an ordinary id exactly as it was', () => {
    // The emitted domPath format is asserted verbatim elsewhere; escaping must not disturb it.
    document.body.innerHTML = '<main><p id="hero">a</p></main>';

    expect(clickSelect('#hero').domPath).toBe('p#hero');
  });
});

describe('the escape is a hand-written constant, not CSS.escape', () => {
  const escape = new Function(`${ESCAPE_CSS_IDENT_JS}\nreturn __oswEscapeIdent;`)() as (v: unknown) => string;

  it('is interpolated into the emitted script exactly once', () => {
    const emitted = generateNavigationScript('/index.html');
    let count = 0;
    const needle = 'function __oswEscapeIdent(';
    for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) count++;
    expect(count).toBe(1);
    // The platform function is absent in jsdom, so a call to it anywhere in this script throws at
    // first use and takes every branch down with it.
    expect(emitted).not.toContain('CSS.escape');
    expect((globalThis as { CSS?: unknown }).CSS).toBeUndefined();
  });

  it('emits the escapes the CSS grammar actually requires', () => {
    expect(escape('hero')).toBe('hero');
    expect(escape('a-b_c9')).toBe('a-b_c9');
    // Hex form with its terminating space. A bare backslash here is the silent failure.
    expect(escape('1abc')).toBe('\\31 abc');
    expect(escape('a1')).toBe('a1');
    expect(escape('a.b')).toBe('a\\.b');
    expect(escape('a:b/c')).toBe('a\\:b\\/c');
    expect(escape('')).toBe('');
    expect(escape(null)).toBe('');
  });

  it('produces something querySelector accepts for every id it escapes', () => {
    // The assertion that matters: the escaped form is not just "some string with backslashes", it
    // is a selector this engine resolves back to the one element.
    for (const id of ['1abc', 'a.b', 'a:b/c', 'x y', 'hero']) {
      document.body.innerHTML = '<p></p>';
      const el = document.querySelector('p')!;
      el.setAttribute('id', id);
      expect(document.querySelector(`#${escape(id)}`), id).toBe(el);
    }
  });
});
