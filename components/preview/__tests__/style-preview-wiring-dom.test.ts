// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { STYLE_PREVIEW_JS, TRANSIENT_STYLE_ATTR } from '@/lib/preview/style-preview';

/**
 * The frame's `style-preview` handler, driven the way the host drives it.
 *
 * `lib/preview/__tests__/style-preview-inject-dom.test.ts` covers the injector itself; this covers
 * that the message reaches it and that the constant is in the emitted script exactly once — a
 * hand-written second copy inside the template literal is the trap the constant exists to avoid.
 *
 * One script instance for the whole file, as in `style-query-dom.test.ts`: each `new Function(...)`
 * run installs another `message` listener on the same jsdom window.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function transient(): HTMLStyleElement | null {
  return document.querySelector(`style[${TRANSIENT_STYLE_ATTR}]`);
}

function marked(): Element {
  return document.querySelector('[data-osw-id="m1"]')!;
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: () => {} },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  document.head.innerHTML = '<style>[data-osw-id="m1"] { color: rgb(50, 50, 50); }</style>';
  document.body.innerHTML = '<p data-osw-id="m1">marked</p>';
});

describe('the style-preview message', () => {
  it('puts the uncommitted block into the live document', () => {
    send({ type: 'style-preview', markerId: 'm1', css: 'color: rgb(1, 2, 3);' });

    expect(transient()).not.toBeNull();
    // Beating the page's own rule for the same element is the point: a repeat edit writes
    // /overrides.css silently, so this element is the only thing that shows the change.
    expect(window.getComputedStyle(marked()).color).toBe('rgb(1, 2, 3)');
    expect(document.head.lastElementChild).toBe(transient());
  });

  it('clears on css: null', () => {
    send({ type: 'style-preview', markerId: 'm1', css: 'color: rgb(1, 2, 3);' });
    // Stated as a precondition, because without it this test passes against a handler that never
    // injects anything at all — the state it asserts is also the state it started in.
    expect(window.getComputedStyle(marked()).color).toBe('rgb(1, 2, 3)');

    send({ type: 'style-preview', markerId: 'm1', css: null });

    expect(transient()).toBeNull();
    expect(window.getComputedStyle(marked()).color).toBe('rgb(50, 50, 50)');
  });

  it('leaves the rest of the handler standing when the payload is junk', () => {
    // `data` crosses postMessage, so a throw here would take every branch after it down too.
    expect(() => send({ type: 'style-preview' })).not.toThrow();
    expect(() => send({ type: 'style-preview', markerId: 5, css: 7 })).not.toThrow();
    expect(transient()).toBeNull();
  });
});

describe('the injector is authored once', () => {
  it('is interpolated from the shared constant, not written into the script', () => {
    const emitted = generateNavigationScript('/index.html');
    const occurrences = (needle: string) => {
      let count = 0;
      for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) count++;
      return count;
    };

    expect(occurrences(STYLE_PREVIEW_JS)).toBe(1);
    expect(occurrences('function __oswApplyStylePreview(')).toBe(1);
    // Also exactly once, because `STYLE_LOCATOR_JS` depends on it being in scope and emitting both
    // constants must not declare it twice.
    expect(occurrences('function __oswSelectorFor(')).toBe(1);
  });
});
