// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { TOOLBAR_HOST_ATTR } from '@/lib/preview/toolbar-dom';
import { generateNavigationScript, generatePlacementScript } from '../multipage-preview';

/**
 * The toolbar is inside the user's document, so every consumer of that document can see it.
 *
 * That is the price of the in-frame architecture, and this file is where it is paid. Each test here
 * pins one consumer that would otherwise treat preview furniture as the user's own content: the
 * drop-target scan, the selector's hover, the selector's click, and the frame-wide click relay.
 *
 * **Both frame scripts are installed**, because that is how they run in production — the placement
 * script and the navigation script are two sibling `<script>` blocks in the same `srcdoc`, each a
 * self-contained IIFE, sharing nothing but the document. The toolbar is mounted by the navigation
 * script and read by the placement script, so a test of the exclusion with only one of them loaded
 * would be testing a document that never exists.
 *
 * One instance of each, for the whole file: every `new Function(...)` run installs another `message`
 * listener on the same jsdom window, and a second would double every reply.
 *
 * Three things jsdom does not do, measured here rather than assumed:
 *
 * - **no layout** — every `getBoundingClientRect()` is zeros, and the toolbar refuses a zero-size
 *   element, so without a stub nothing would ever mount and every test below would pass vacuously.
 * - **no `document.elementFromPoint`** — it is not merely null, it is *not a function*, so
 *   `findDropTarget` throws without a stub. Stubbed to null, which is what a real browser returns for
 *   a point over bare body — and the fallback that null selects is exactly the defect in row 1.
 * - **shadow events need `composed: true`** — an event dispatched inside a shadow root with the
 *   default `composed: false` does not cross the boundary at all, so a document listener never sees
 *   it. A real user's click is composed; the tests below say so explicitly.
 */

interface StubRect { top: number; left: number; width: number; height: number }

const RECT: StubRect = { top: 100, left: 40, width: 200, height: 50 };

/**
 * A rect per element, because one shared rect hides the defect it is there to expose.
 *
 * With every element measuring the same, an overlay moved onto the toolbar lands on the same pixel
 * as an overlay left on the user's element, and the hover test below passes against an
 * implementation with no exclusion at all. The toolbar host is therefore given a rect nothing else
 * has, and the assertions are against those numbers.
 */
const rects = new WeakMap<Element, StubRect>();
const TOOLBAR_RECT: StubRect = { top: 700, left: 700, width: 120, height: 32 };

/** Everything posted to the host since the last reset, oldest first. */
let posted: Array<{ type?: string; payload?: Record<string, unknown> }> = [];

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function messagesOfType(type: string): Array<{ type?: string; payload?: Record<string, unknown> }> {
  return posted.filter(m => m && m.type === type);
}

function host(): HTMLElement {
  return document.querySelector<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`)!;
}

function overlay(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-osw-overlay]')!;
}

/** Click as a user does: through the click selector, which is what mounts the toolbar. */
function select(selector: string): Element {
  const el = document.querySelector(selector)!;
  send({ type: 'selector-toggle', active: true });
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
}

/**
 * A click that starts on the toolbar's chrome, inside the shadow root.
 *
 * `composed: true` is not decoration — without it the event never leaves the shadow root and the
 * document-level listeners under test are never reached, so the test would pass against an
 * implementation with no exclusion at all. With it, the document sees the event *retargeted* to the
 * host, which is the single fact every exclusion in this sweep is built on.
 */
function clickToolbarChrome(): void {
  const bar = host().shadowRoot!.querySelector('.osw-toolbar')!;
  bar.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}

function moveOver(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
}

const MARKUP = '<main><section id="one">a</section><section id="two">b</section></main>';

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message); } },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const r = rects.get(this) ?? (this.hasAttribute(TOOLBAR_HOST_ATTR) ? TOOLBAR_RECT : RECT);
    return {
      ...r,
      right: r.left + r.width, bottom: r.top + r.height,
      x: r.left, y: r.top, toJSON: () => ({}),
    } as DOMRect;
  };
  // A point over bare body. The placement script's own fallback is what runs for this, and that
  // fallback is row 1 of the sweep.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });

  new Function(jsOf(generatePlacementScript()))();
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  send({ type: 'selection-clear' });
  send({ type: 'selector-toggle', active: false });
  send({ type: 'placement-cancel' });
  // Not `innerHTML = MARKUP`: that would detach the selector's overlay, which the frame holds in a
  // closure and never re-appends, so it would stop being observable from here after the first test.
  // The overlay is preview furniture the document is *meant* to keep — it is hidden, not removed.
  for (const child of Array.from(document.body.children)) {
    if (!child.hasAttribute('data-osw-overlay')) child.remove();
  }
  document.body.insertAdjacentHTML('beforeend', MARKUP);
  posted = [];
});

describe('the block-placement drop target', () => {
  it('does not offer the toolbar as a drop target, or put it in the agent htmlContext', () => {
    select('#one');
    // The fallback walks document.body.children *backwards*, so the most recently appended element
    // is the one it hands back — and the toolbar, mounted on selection, is exactly that.
    expect(document.body.lastElementChild).toBe(host());

    send({ type: 'placement-start', block: { id: 'b1', name: 'Hero', wireframeHtml: '<div>hero</div>' } });
    send({ type: 'placement-hover', x: 10, y: 10 });
    send({ type: 'placement-drop' });

    const complete = messagesOfType('placement-complete')[0];
    expect(complete).toBeDefined();
    // The agent is told where to write the block. Untreated it is told to write it into a div that
    // exists only in the preview and vanishes on the next recompile.
    expect(complete.payload!.domPath).toBe('body > main');
    expect(String(complete.payload!.domPath)).not.toContain('div');
    // The same request carries the surrounding markup. The chrome is in a shadow root and never
    // serialises, but the host element is an ordinary empty div in document.body and does.
    //
    // This assertion is held up by the drop-target fix above, not by the clone's own strip: the
    // clone root is the target or its parent, and the toolbar host is only ever a direct child of
    // document.body, so it reaches the clone only by *being* the target. Mutating the strip alone
    // leaves this test green — checked — which is why it is asserted here as the consequence rather
    // than given a test of its own that would pin nothing.
    expect(String(complete.payload!.htmlContext)).not.toContain(TOOLBAR_HOST_ATTR);
    expect(String(complete.payload!.htmlContext)).toContain('<main>');
  });
});

describe('the click selector', () => {
  it('does not highlight the toolbar on hover', () => {
    select('#one');
    send({ type: 'selector-toggle', active: true });
    moveOver(document.querySelector('#two')!);
    expect(overlay().style.top).toBe(`${RECT.top}px`);
    expect(overlay().style.opacity).toBe('1');

    moveOver(host().shadowRoot!.querySelector('.osw-toolbar')!);

    // The highlight stays where it was — 700px is the toolbar's own rect, and is what an
    // unexcluded hover paints. Moving onto the toolbar is a move *towards* the element it is
    // anchored to, so the wrong behaviour here is not merely cosmetic: it is the highlight jumping
    // onto preview furniture as the user reaches for the button.
    expect(overlay().style.top).toBe(`${RECT.top}px`);
    expect(overlay().style.top).not.toBe(`${TOOLBAR_RECT.top}px`);
    expect(overlay().style.opacity).toBe('1');
  });

  it('does not select the toolbar, and stays armed when one of its buttons is pressed', () => {
    select('#one');
    posted = [];
    send({ type: 'selector-toggle', active: true });

    clickToolbarChrome();

    expect(messagesOfType('selector-selection')).toHaveLength(0);
    // Still armed: the toolbar click was ignored outright rather than consumed as a selection, so
    // the tool the user armed is still waiting for the element they meant.
    document.querySelector('#two')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(messagesOfType('selector-selection')).toHaveLength(1);
    expect(messagesOfType('selector-selection')[0].payload!.attributes).toMatchObject({ id: 'two' });
  });
});

describe('the frame-wide click relay', () => {
  it('does not report a toolbar press as a click in the page', () => {
    select('#one');
    posted = [];

    clickToolbarChrome();

    // The host closes the block palette and fires onPlacementToggle on this message, so a toolbar
    // press would toggle unrelated UI.
    expect(messagesOfType('iframe-click')).toHaveLength(0);

    // A click in the user's own content still reports, so the exclusion is a carve-out and not a
    // relay that has been switched off.
    document.querySelector('#two')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(messagesOfType('iframe-click')).toHaveLength(1);
  });
});
