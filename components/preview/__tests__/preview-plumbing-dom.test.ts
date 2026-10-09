// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The selector script run for real, against a document stamped the way the Elements tree stamps it.
 *
 * `preview-plumbing.test.ts` asserts the shape of the emitted text; this asserts what that text
 * does. The stamping matters: `data-osw-node` does not exist anywhere in the codebase yet, so a
 * test that merely looked for its absence in a payload would pass against an implementation that
 * filters nothing at all. The document below carries the attribute already, on the clicked element
 * and on a descendant, so the assertions fail the moment the filtering is removed.
 *
 * One script instance for the whole file, in beforeAll: each `new Function(...)` run installs
 * another message listener and another overlay on the same jsdom window, and the overlay
 * assertions count elements.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  payload?: FocusContextPayload;
}

const posted: PostedMessage[] = [];

function enableSelector() {
  window.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'selector-toggle', active: true }, source: window.parent }));
}

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('[data-osw-overlay]');
}

beforeAll(() => {
  // A stamped document: provenance from the compiler, node ids from a tree expansion.
  document.body.innerHTML =
    '<main data-osw-src="/index.hbs:0" data-osw-node="3">' +
      '<article class="post" data-tone="warm" data-osw-src="/index.hbs:24" data-osw-node="7">' +
        '<h2 data-osw-src="/index.hbs:66" data-osw-node="9">t</h2>' +
      '</article>' +
    '</main>';

  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
  });

  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  posted.length = 0;
});

describe('the highlight overlay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is stamped so the document can tell it apart from a user div', () => {
    enableSelector();
    const article = document.querySelector('article') as HTMLElement;
    article.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(overlays()).toHaveLength(1);
    expect((overlays()[0] as HTMLElement).style.opacity).toBe('1');
  });

  it('is hidden rather than detached when the selector goes away', () => {
    enableSelector();
    const article = document.querySelector('article') as HTMLElement;
    article.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const shown = overlays()[0];

    // Fake timers because the implementation this replaces detached the node from a 120ms
    // setTimeout — without draining it, a synchronous assertion here passes against that too.
    vi.useFakeTimers();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(1000);

    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toBe(shown);
    expect(document.body.contains(shown)).toBe(true);
    expect((shown as HTMLElement).style.opacity).toBe('0');
  });

  it('reuses the same node across a second selection pass', () => {
    const before = overlays()[0];
    enableSelector();
    const heading = document.querySelector('h2') as HTMLElement;
    heading.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toBe(before);
  });
});

describe('the payload a click produces', () => {
  it('carries no preview-only attribute on any surface that reaches the agent', () => {
    enableSelector();
    const article = document.querySelector('article') as HTMLElement;
    article.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection, 'no selector-selection message was posted').toBeTruthy();
    const payload = selection?.payload as FocusContextPayload;

    // The element genuinely carries both attributes, so each of these fails against an
    // implementation that stopped filtering.
    expect(article.getAttribute('data-osw-node')).toBe('7');
    expect(article.getAttribute('data-osw-src')).toBe('/index.hbs:24');

    expect(Object.keys(payload.attributes)).toEqual(['class', 'data-tone']);
    // The descendant's stamps too — outerHTML is a whole subtree, and an expanded level stamps
    // every node in it.
    expect(payload.outerHTML).toBe('<article class="post" data-tone="warm"><h2>t</h2></article>');
    expect(JSON.stringify(payload)).not.toContain('data-osw-node');
    expect(JSON.stringify(payload)).not.toContain('data-osw-src');

    // srcAttr is the one sanctioned carrier of provenance: it is a named field the host reads,
    // not an attribute smuggled through markup, and describeFocusTarget does not print it.
    expect(payload.srcAttr).toBe('/index.hbs:24');
    expect(payload.instanceCount).toBe(1);
    expect(payload.tagName).toBe('article');
    expect(payload.domPath).toBe('html > body > main > article');
  });
});

describe('textBearing on the payload', () => {
  function payloadFor(el: Element): FocusContextPayload {
    enableSelector();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection, 'no selector-selection message was posted').toBeTruthy();
    return selection!.payload as FocusContextPayload;
  }

  it('is true for a leaf whose content is one run of text', () => {
    // The whole point of the field: the host learns "this element says something you could retype"
    // without parsing outerHTML, which by then has been through the provenance stripper.
    expect(payloadFor(document.querySelector('h2')!).textBearing).toBe(true);
  });

  it('is false when the text is wrapped in a child element', () => {
    // <article> contains 't', but only inside its <h2>. Replacing the article's content would
    // clobber the markup, so it is not a text element however much text it renders.
    expect(payloadFor(document.querySelector('article')!).textBearing).toBe(false);
  });

  it('is false, not absent, for an element with nothing in it', () => {
    const empty = document.createElement('p');
    empty.textContent = '   ';
    document.body.appendChild(empty);

    const payload = payloadFor(empty);

    // Stated rather than omitted: "no children and no text" is an answer, and a missing field would
    // be indistinguishable from a payload built by something that does not report this at all.
    expect(payload.textBearing).toBe(false);
    expect('textBearing' in payload).toBe(true);
    empty.remove();
  });
});
