// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { STYLE_PREVIEW_JS, OVERRIDES_STYLE_ATTR } from '../style-preview';
import { MARKER_SELECTOR_TEMPLATE, upsertDeclaration } from '@/lib/direct-edit/overrides-css';

/**
 * Swapping a new `/overrides.css` into the frame, run out of the *emitted* text against a live
 * document.
 *
 * `STYLE_PREVIEW_JS` only ever executes inside a preview or Canvas frame, interpolated into a
 * template literal by `generateNavigationScript`. Reading the source proves nothing about what the
 * frame parses, so the functions are extracted from the constant and called.
 *
 * jsdom cascades `<style>` elements it has in the document, so the colour assertions below are about
 * rules in force. It never loads a `<link>`, so the link stands for the file's place in `<head>`
 * and nothing more; and its `matchMedia` answers false, so width blocks are asserted in the browser.
 */
const frame = new Function(
  `${STYLE_PREVIEW_JS}\nreturn { apply: __oswApplyOverrides, selectorFor: __oswSelectorFor };`,
)() as {
  apply: (css: unknown) => Element | null;
  selectorFor: (markerId: string) => string | null;
};

const rule = (id: string, body: string) => `[data-osw-id="${id}"][data-osw-id] { ${body} }`;
const swapped = () => document.querySelector<HTMLStyleElement>(`style[${OVERRIDES_STYLE_ATTR}]`);
const colorOf = (id: string) => window.getComputedStyle(document.querySelector(`[data-osw-id="${id}"]`)!).color;

beforeEach(() => {
  delete (window as unknown as { __oswVfsBlobUrls?: unknown }).__oswVfsBlobUrls;
  document.head.innerHTML = '<title>t</title><style>p { color: rgb(50, 50, 50); }</style>'
    + '<link rel="stylesheet" href="blob:frame/overrides"><style id="after">.later {}</style>';
  document.body.innerHTML = '<p data-osw-id="m1">marked</p><p data-osw-id="m2">other</p>';
  (window as unknown as { __oswVfsBlobUrls: Record<string, string> }).__oswVfsBlobUrls = {
    '/overrides.css': 'blob:frame/overrides',
  };
});

describe('the selector has one authored source', () => {
  it('is built frame-side from the same pattern the CSS writer uses', () => {
    // The pattern crosses the boundary, not the function: the frame script is a string and the
    // marker id arrives at runtime, so `selectorFor` cannot be called here. What can be checked is
    // that both sides land on the same bytes — the (0,2,0) doubling is what the override's whole
    // cascade position depends on.
    expect(frame.selectorFor('m1')).toBe(MARKER_SELECTOR_TEMPLATE.replace('{id}', 'm1'));
    expect(upsertDeclaration('', 'm1', { property: 'color', value: 'red' }))
      .toContain(frame.selectorFor('m1')!);
  });

  it('refuses a marker id that could close the attribute selector', () => {
    // The id arrives over postMessage, so the frame is not the only writer. A quote in it would end
    // the attribute value and let the rest be read as CSS of its own.
    expect(frame.selectorFor('a" ] { color: red } body {')).toBeNull();
    expect(frame.selectorFor('')).toBeNull();
    expect(frame.selectorFor(42 as unknown as string)).toBeNull();
  });
});

describe('swapping in /overrides.css', () => {
  it('puts the file in a <style> where its link was, and takes the link out', () => {
    frame.apply(rule('m1', 'color: rgb(1, 2, 3);'));

    // Where the link was, ahead of what came after it: the file's place in the cascade is its order
    // in <head>, and appending at the end would let it beat a stylesheet that loads after it.
    expect(swapped()!.nextElementSibling).toBe(document.getElementById('after'));
    expect(document.querySelector('link')).toBeNull();
    expect(colorOf('m1')).toBe('rgb(1, 2, 3)');
  });

  it('finds a link the document builder marked, without the file map', () => {
    delete (window as unknown as { __oswVfsBlobUrls?: unknown }).__oswVfsBlobUrls;
    document.querySelector('link')!.setAttribute(OVERRIDES_STYLE_ATTR, '');
    frame.apply(rule('m1', 'color: rgb(1, 2, 3);'));
    expect(document.querySelector('link')).toBeNull();
    expect(swapped()!.nextElementSibling).toBe(document.getElementById('after'));
  });

  it('rewrites the same element on the next write, whole', () => {
    frame.apply(`${rule('m1', 'color: rgb(1, 2, 3);')}\n${rule('m2', 'color: rgb(4, 5, 6);')}`);
    frame.apply(rule('m2', 'color: rgb(7, 8, 9);'));

    expect(document.querySelectorAll(`style[${OVERRIDES_STYLE_ATTR}]`)).toHaveLength(1);
    // m1's rule is not in the new file, so it is gone from the page too: a removal shows without a
    // recompile, which one transient rule per element could not do.
    expect(colorOf('m1')).toBe('rgb(50, 50, 50)');
    expect(colorOf('m2')).toBe('rgb(7, 8, 9)');
  });

  it('puts the style at the end of the head of a page with no link to the file', () => {
    document.querySelector('link')!.remove();
    frame.apply(rule('m1', 'color: rgb(1, 2, 3);'));
    expect(document.head.lastElementChild).toBe(swapped());
    expect(colorOf('m1')).toBe('rgb(1, 2, 3)');
  });

  it('does nothing with anything but a string', () => {
    for (const bad of [null, undefined, 42, { css: 'x' }]) expect(frame.apply(bad)).toBeNull();
    expect(swapped()).toBeNull();
    expect(document.querySelector('link')).not.toBeNull();
  });
});

describe('the emitted source stays inside the escaping rules', () => {
  it('authors no backtick, which would terminate the literal it is emitted into', () => {
    expect(STYLE_PREVIEW_JS).not.toContain('`');
    // No regex literal either: one authored inside the emitting template literal loses a level of
    // escaping before it is ever parsed. The two backslashes this constant does carry are the ones
    // JSON.stringify put around the selector pattern's quotes, which is exactly correct.
    expect(STYLE_PREVIEW_JS).toContain(JSON.stringify(MARKER_SELECTOR_TEMPLATE));
  });
});
