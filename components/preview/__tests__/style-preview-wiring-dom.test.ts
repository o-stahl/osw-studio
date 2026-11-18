// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { STYLE_PREVIEW_JS, OVERRIDES_STYLE_ATTR } from '@/lib/preview/style-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The frame's `overrides-preview` handler, driven the way the host drives it.
 *
 * `lib/preview/__tests__/style-preview-inject-dom.test.ts` covers the swap itself; this covers that
 * the message reaches it and that the constant is in the emitted script exactly once — a
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

function swapped(): HTMLStyleElement | null {
  return document.querySelector(`style[${OVERRIDES_STYLE_ATTR}]`);
}

function marked(): Element {
  return document.querySelector('[data-osw-id="m1"]')!;
}

const RULE = '[data-osw-id="m1"][data-osw-id] { color: rgb(1, 2, 3); }';

const posted: { type?: string; payload?: FocusContextPayload }[] = [];

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  document.head.innerHTML = '<style>[data-osw-id="m1"] { color: rgb(50, 50, 50); }</style>';
  document.body.innerHTML = '<p data-osw-id="m1">marked</p>';
});

describe('the overrides-preview message', () => {
  it('puts the file as just written into the live document', () => {
    send({ type: 'overrides-preview', css: RULE });

    expect(swapped()).not.toBeNull();
    // A repeat edit writes /overrides.css silently, so this copy is the only thing that shows it.
    expect(window.getComputedStyle(marked()).color).toBe('rgb(1, 2, 3)');
  });

  it.each([
    ['no fields', {}],
    ['a css that is not a string', { css: 7 }],
  ])('ignores %s without throwing', (_name, junk) => {
    // `data` crosses postMessage, so a throw here would take every branch after it down too.
    // dispatchEvent swallows a listener's throw, so the evidence is the page: the copy already in
    // place stays as it was.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    try {
      send({ type: 'overrides-preview', css: RULE });
      send({ type: 'overrides-preview', ...junk });

      expect(window.getComputedStyle(marked()).color).toBe('rgb(1, 2, 3)');
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});

describe('marks for a first edit', () => {
  // Two renders of one source tag, and an element source already marked with an id of its own.
  const page = '<p data-osw-src="/index.html:40">a</p><p data-osw-src="/index.html:40">b</p>'
    + '<p data-osw-src="/index.html:90" data-osw-id="m7">c</p><p data-osw-src="/index.html:120">d</p>';
  const rule = (id: string) => `[data-osw-id="${id}"][data-osw-id] { color: rgb(1, 2, 3); }`;
  const ids = () => Array.from(document.body.children, el => el.getAttribute('data-osw-id'));

  it('marks every element the source tag rendered, and the file shows on them at once', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: rule('n1'), marks: [{ src: '/index.html:40', markerId: 'n1' }] });

    expect(ids()).toEqual(['n1', 'n1', 'm7', null]);
    expect(window.getComputedStyle(document.body.children[1]).color).toBe('rgb(1, 2, 3)');
  });

  it('leaves an element its source marked with its own id', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: '', marks: [{ src: '/index.html:90', markerId: 'n2' }] });

    expect(ids()).toEqual([null, null, 'm7', null]);
  });

  it('takes back a mark it put, and only where it put it', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: rule('n3'), marks: [{ src: '/index.html:40', markerId: 'n3' }] });
    // The same id from source, which a take-back must not touch.
    document.body.children[3].setAttribute('data-osw-id', 'n3');
    send({ type: 'overrides-preview', css: '', unmarks: ['n3'] });

    expect(ids()).toEqual([null, null, 'm7', 'n3']);
  });

  it('takes back before it marks, so a write that stamped another id moves the element to it', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: '', marks: [{ src: '/index.html:40', markerId: 'n4' }] });
    send({ type: 'overrides-preview', css: rule('n5'), marks: [{ src: '/index.html:40', markerId: 'n5' }], unmarks: ['n4'] });

    expect(ids()).toEqual(['n5', 'n5', 'm7', null]);
    expect(window.getComputedStyle(document.body.children[0]).color).toBe('rgb(1, 2, 3)');
  });

  it('keeps its own marks out of a selection, which a write would trust', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: '', marks: [{ src: '/index.html:40', markerId: 'n6' }] });
    const pick = (index: number) => {
      posted.length = 0;
      send({ type: 'selector-toggle', active: true });
      document.body.children[index].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return posted.find(message => message.type === 'selector-selection')!.payload!;
    };

    expect(pick(0).attributes?.['data-osw-id']).toBeUndefined();
    expect(pick(2).attributes?.['data-osw-id']).toBe('m7');
  });

  it('refuses an id that could close the selector it is matched by', () => {
    document.body.innerHTML = page;
    send({ type: 'overrides-preview', css: '', marks: [{ src: '/index.html:40', markerId: 'x"]' }] });

    expect(ids()).toEqual([null, null, 'm7', null]);
  });
});

describe('the swap is authored once', () => {
  it('is interpolated from the shared constant, not written into the script', () => {
    const emitted = generateNavigationScript('/index.html');
    const occurrences = (needle: string) => {
      let count = 0;
      for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) count++;
      return count;
    };

    expect(occurrences(STYLE_PREVIEW_JS)).toBe(1);
    expect(occurrences('function __oswApplyOverrides(')).toBe(1);
    // Also exactly once, because `STYLE_LOCATOR_JS` depends on it being in scope and emitting both
    // constants must not declare it twice.
    expect(occurrences('function __oswSelectorFor(')).toBe(1);
  });
});
