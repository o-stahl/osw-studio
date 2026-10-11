// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  TOOLBAR_DOM_JS,
  TOOLBAR_SHADOW_CSS,
  TOOLBAR_HOST_ATTR,
  TOOLBAR_PLACEMENT_ATTR,
  TOOLBAR_HEIGHT,
  TOOLBAR_GAP,
  TOOLBAR_THEME_PREFIX,
  TOOLBAR_THEME_TOKENS,
  elementKind,
} from '../toolbar-dom';
import type { FocusContextPayload } from '../types';
import { generateNavigationScript } from '@/components/preview/multipage-preview';

/**
 * The selection toolbar, as it behaves inside the preview frame.
 *
 * Driven through the *emitted* script, not through the module: the toolbar source is interpolated
 * into a template literal in `components/preview/multipage-preview.tsx`, and the emitted text is the
 * only thing that ever runs. One script instance for the whole file — each `new Function(...)` run
 * installs another `message` listener on the same jsdom window, and a second one would double every
 * reply and mount a second toolbar.
 *
 * **jsdom has no layout.** Every `getBoundingClientRect()` returns zeros, `window.scrollTo` does not
 * move them and `window.innerHeight` is a constant, so "the toolbar sits above the element" reduces
 * to `0 === 0` and passes against any implementation at all. All three are therefore stubbed below,
 * and every assertion is against a real number.
 *
 * **jsdom has no `ResizeObserver`.** It is stubbed before the script is evaluated — the script
 * feature-tests for it at init, so installing it afterwards would be too late. The stub is driven by
 * hand: what the resize test proves is that the frame re-positions when its observer fires, not that
 * a real `ResizeObserver` fires. That distinction is the whole reason the stub is written out here
 * rather than hidden in a helper.
 *
 * **`requestAnimationFrame` is stubbed too**, for the same reason and with the same caveat: the
 * scroll listener coalesces through it, and driving it by hand is what makes "one check per frame, no
 * matter how many scroll events" an assertion rather than a wait.
 */

interface StubRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const DEFAULT_RECT: StubRect = { top: 100, left: 40, width: 200, height: 50 };

/**
 * The stubbed geometry, per element.
 *
 * A `Map` rather than a `WeakMap` because {@link scrollFrameTo} has to walk it: a scroll moves every
 * element's viewport rect, and a stub that moved only `window.scrollY` would let a wrong
 * implementation look right. Cleared per test, alongside the body it describes.
 */
const rects = new Map<Element, StubRect>();

function setRect(el: Element, rect: StubRect): void {
  rects.set(el, rect);
}

/**
 * How many times each element has been measured.
 *
 * The only observable difference between "the frame asked whether the placement still fits and left it
 * alone" and "the frame re-placed the bar to the coordinates it was already at". The bar's document
 * anchor does not depend on the scroll offset, so a redundant re-place produces byte-identical inline
 * style — and a test that asserted on the style alone would pass against a per-frame follow, which is
 * the one implementation this architecture exists to rule out.
 */
const scrollBehaviours: Array<string | null> = [];
const reads = new Map<Element, number>();

function setScroll(y: number, x = 0): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  Object.defineProperty(window, 'scrollX', { configurable: true, value: x });
}

/**
 * The frame's viewport height — the room the placement is measured against.
 *
 * Set explicitly in every test rather than left on jsdom's 768, so the arithmetic in the assertions
 * is readable and so a change to jsdom's default cannot move what these tests mean.
 */
function setViewport(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** The room a bar needs on one side of the element to fit there. */
const NEED = TOOLBAR_HEIGHT + TOOLBAR_GAP;

/**
 * A scroll, as the browser performs one: the offset moves, and every element's viewport rect moves
 * the same distance the other way.
 *
 * Both halves are the point. The bar is placed in *document* coordinates, so a stub that moved only
 * the offset would make a correct implementation look like it drifts, and a stub that moved only the
 * rects would hide the offset being dropped.
 */
function scrollFrameTo(y: number, x = 0): void {
  const dy = y - window.scrollY;
  const dx = x - window.scrollX;
  for (const [el, rect] of rects) {
    rects.set(el, { ...rect, top: rect.top - dy, left: rect.left - dx });
  }
  setScroll(y, x);
}

/** A scroll event, as the frame's own listener sees one. Coalesced until {@link flushFrame}. */
function scrollEvent(): void {
  window.dispatchEvent(new Event('scroll'));
}

/** Every callback the stubbed ResizeObserver was constructed with, in construction order. */
const resizeCallbacks: Array<() => void> = [];

/** Callbacks the scroll listener has queued for the next animation frame. */
const frameCallbacks: FrameRequestCallback[] = [];

/** Run whatever the listener queued, the way a real animation frame would. */
function flushFrame(): void {
  for (const callback of frameCallbacks.splice(0)) callback(0);
}

/** Everything the frame has sent the host, so a test can assert on the *absence* of traffic. */
let posted: Array<{ type?: string }> = [];

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function host(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`);
}

function hostTop(): number {
  return parseFloat(host()!.style.top);
}

/** Select through the click path — the same one a user's click in the preview takes. */
function select(selector: string): Element {
  const el = document.querySelector(selector)!;
  send({ type: 'selector-toggle', active: true });
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
}

const MARKUP = '<main><section id="one">a</section><section id="two">b</section></main>';

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message); } },
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => frameCallbacks.push(callback),
  });
  // What the frame calls to put a restored scroll back. jsdom's own implementation moves nothing, so
  // a real scroll is modelled instead — otherwise a restore that never happened is indistinguishable
  // from one that did.
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    // Both call shapes, because which one the frame uses is load-bearing: the two-argument form obeys
    // the document's own `scroll-behavior`, and three built-in templates set that to `smooth`. The
    // `behavior` actually asked for is recorded so a test can assert the restore does not animate.
    value: (a: number | ScrollToOptions, b?: number) => {
      if (typeof a === 'object' && a !== null) {
        scrollBehaviours.push(a.behavior ?? null);
        scrollFrameTo(a.top ?? 0, a.left ?? 0);
        return;
      }
      scrollBehaviours.push('two-arg');
      scrollFrameTo(b ?? 0, a as number);
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    reads.set(this, (reads.get(this) ?? 0) + 1);
    const r = rects.get(this) ?? DEFAULT_RECT;
    return {
      top: r.top, left: r.left, width: r.width, height: r.height,
      right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  send({ type: 'selection-clear' });
  // Drained rather than dropped. The script is installed once for the whole file, so its
  // "a check is already queued" flag is shared state — a test that queues a check and never runs it
  // would leave that flag set and silently swallow every later test's scroll.
  flushFrame();
  document.body.innerHTML = MARKUP;
  rects.clear();
  reads.clear();
  frameCallbacks.length = 0;
  posted = [];
  scrollBehaviours.length = 0;
  setScroll(0);
  setViewport(600);
});

describe('placement', () => {
  it('anchors in document coordinates, so scroll offset is added and not ignored', () => {
    setRect(document.querySelector('#one')!, { top: 100, left: 40, width: 200, height: 50 });
    setScroll(50);

    select('#one');

    // The element's position in the *document* is 100 + 50 = 150. The bar sits above it, by its own
    // height plus the gap. The number to be wrong about is 70 — rect.top with the scroll offset
    // dropped, which is what a host-rendered (viewport-relative) design would compute.
    expect(hostTop()).toBe(150 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
    expect(hostTop()).not.toBe(100 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
    expect(host()!.style.left).toBe('40px');
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
  });

  it('flips below an element near the top of the document instead of going negative', () => {
    const el = document.querySelector('#one')!;
    setRect(el, { top: 5, left: 12, width: 200, height: 50 });
    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    // Under the element: its document top, plus its height, plus the gap. Above would be -35.
    expect(hostTop()).toBe(5 + 50 + TOOLBAR_GAP);
    expect(hostTop()).toBeGreaterThan(0);
  });

  it('keeps the bar on screen for an element near the VIEWPORT top on a scrolled page', () => {
    // The measured case, in the numbers it was measured in: the frame scrolled to 500, a selected h2
    // 29px below the viewport top, and the bar at -9 — above the visible area entirely.
    //
    // The old rule asked whether the element was near the top of the *document*. At document position
    // 529 it plainly was not, so the rule said there was room above, and there was — 529px of it,
    // 500 of which the user had scrolled past.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 29, left: 40, width: 200, height: 40 });
    setScroll(500);

    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    // Still anchored in document coordinates — 529 is the element's document top, and the bar sits
    // under it. What changed is only which side was chosen.
    expect(hostTop()).toBe(529 + 40 + TOOLBAR_GAP);
    // The number to be wrong about, spelled out: 491 in the document is -9 in the viewport.
    expect(hostTop()).not.toBe(529 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
    expect(hostTop() - 500).toBe(79);
    expect(hostTop() - 500).toBeGreaterThanOrEqual(0);
  });

  it('takes the side with more room when the bar fits on neither', () => {
    // An element 555px tall in a 600px viewport: 25px above it, 20px below. Neither is the 38 a bar
    // needs, so there is no placement the user can see all of — and 'above whenever above does not
    // fit, below otherwise' would pick the worse of the two.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 25, left: 40, width: 200, height: 555 });

    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
    expect(hostTop()).toBe(25 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
  });

  it('takes below when below is the roomier of two bad sides', () => {
    // The same shape the other way up, so the rule is 'more room' and not 'prefer above'.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 20, left: 40, width: 200, height: 555 });

    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    expect(hostTop()).toBe(20 + 555 + TOOLBAR_GAP);
  });

  it('takes the nearer side for an element taller than the viewport', () => {
    // Scrolled into the middle of a very tall element: 300px of it above the viewport, 1100px below.
    // Nothing welded to document coordinates can be visible here, and the honest choice is the edge
    // the user is closer to — 300px off the top beats 1100px off the bottom.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: -300, left: 40, width: 200, height: 2000 });
    setScroll(500);

    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
    expect(hostTop()).toBe(200 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
  });

  it('takes the nearer side when the nearer side is below', () => {
    // The mirror of the case above, and the one that says the comparison is on the raw numbers.
    // Scrolled near the *bottom* of a very tall element: 1100px of it above the viewport, 300px
    // below, so neither side has room and both measure negative. Clamping the two at zero before
    // comparing makes them tie at 0, and a tie answers 'above' — the further edge, and the one the
    // user is 1100px away from.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: -1100, left: 40, width: 200, height: 2000 });
    setScroll(1500);

    select('#one');

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    // Document coordinates: the element's top is 1500 - 1100 = 400, so its bottom is 2400.
    expect(hostTop()).toBe(2400 + TOOLBAR_GAP);
  });

  it('refuses a zero-size element rather than parking a toolbar at 0,0', () => {
    const el = document.querySelector('#one')!;
    setRect(el, { top: 0, left: 0, width: 0, height: 0 });

    select('#one');

    // A display:none element, and a detached one, both measure as all zeros. Placing against that
    // puts a toolbar in the corner of the page pointing at something the user cannot see.
    expect(host()).toBeNull();
  });
});

describe('scrolling', () => {
  it('sends the host nothing at all on scroll', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');
    posted = [];

    // Across a threshold crossing, which is the busiest a scroll ever gets here.
    scrollFrameTo(180);
    scrollEvent();
    flushFrame();

    // The reason the toolbar is built in the frame at all: a host round trip is one frame behind by
    // construction, and the bar would read as swimming away from its element. Nothing may go over
    // postMessage on scroll, crossing or no crossing.
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    expect(posted).toEqual([]);
  });

  it('coalesces any number of scroll events into one check per animation frame', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');

    scrollFrameTo(50);
    scrollEvent();
    scrollEvent();
    scrollEvent();
    scrollEvent();

    // A trackpad scroll fires far faster than the frame rate and the check reads geometry, so an
    // unthrottled listener would force a layout per event. One queued callback, not four.
    expect(frameCallbacks).toHaveLength(1);

    // Run it, so the frame's "already queued" flag is not left set for the next test in this file.
    flushFrame();
  });

  it('re-places once, at the crossing, when the chosen side stops fitting', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');

    // 180px down: the element is 20 from the viewport top now, and a bar above it would be at -18.
    scrollFrameTo(180);
    scrollEvent();

    // Not until the frame runs. Asserted so the throttle is proven to be real rather than assumed —
    // an implementation that repositioned synchronously per event would already have moved.
    expect(hostTop()).toBe(200 - NEED);

    flushFrame();

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    // The same document anchor — 200 is where the element is in the document, and scrolling did not
    // move it. Only the side changed, which is the whole difference between a threshold check and a
    // per-frame follow.
    expect(hostTop()).toBe(200 + 50 + TOOLBAR_GAP);
    expect(hostTop() - 180).toBe(80);
  });

  it('flips back when the crossing is recrossed', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');

    scrollFrameTo(180);
    scrollEvent();
    flushFrame();
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');

    scrollFrameTo(0);
    scrollEvent();
    flushFrame();

    // The check compares against the side the bar is on, so it has to be able to answer in both
    // directions — an implementation that only ever escaped upwards would strand the bar below the
    // element for the rest of the selection.
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
    expect(hostTop()).toBe(200 - NEED);
  });

  it('re-checks the fit when the viewport itself gets shorter', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 20, left: 40, width: 200, height: 50 });
    select('#one');
    // No room above, plenty below.
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');

    // A viewport 80px tall has 10px under the element and 20 above it — so the side the bar is on is
    // now the worse of the two, with no scroll and no element resize to say so.
    setViewport(80);
    window.dispatchEvent(new Event('resize'));
    flushFrame();

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
  });

  it('asks on the frame after a scroll, and only re-places at the crossing', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');
    const before = hostTop();
    expect(before).toBe(200 - NEED);

    // 100px down: the element is still 100 from the viewport top, so the side it is on still fits.
    scrollFrameTo(100);
    scrollEvent();
    reads.clear();
    flushFrame();

    // Measured once — by the fit check — and not a second time, which is what a re-place would cost.
    // This is the assertion that separates a threshold check from a per-frame follow: the bar's
    // document position is identical either way, so nothing about its inline style can show it.
    expect(reads.get(el) ?? 0).toBe(1);
    // Welded, meanwhile: absolute in document coordinates, so the browser moved the bar with the page
    // and the frame wrote nothing.
    expect(hostTop()).toBe(before);
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');

    // 80px further: no room above now.
    scrollFrameTo(180);
    scrollEvent();
    reads.clear();
    flushFrame();

    // Twice: the check, and then the re-place it asked for.
    expect(reads.get(el) ?? 0).toBe(2);
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
  });

  it('does not put a stale toolbar back after the document is replaced', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 200, left: 40, width: 200, height: 50 });
    select('#one');
    expect(host()).not.toBeNull();

    // What a recompile does, as far as anything observable here goes: a new body, so the toolbar host
    // and the tracked element are both detached — while the frame's script, and everything it is
    // holding in closures, survives.
    document.body.innerHTML = MARKUP;
    expect(host()).toBeNull();

    scrollFrameTo(180);
    scrollEvent();
    flushFrame();

    // The check is guarded on the host still being in the document. Without that guard a scroll in the
    // *new* document re-appends the old toolbar — anchored to an element that is no longer in the page,
    // and for a selection the host has already been told to re-resolve.
    //
    // The same guard is what keeps a *dismissed* selection down: `selection-clear` takes the host out
    // of the document too, so both cases are this one condition rather than two.
    expect(host()).toBeNull();
  });

});

describe('the scroll position across a recompile', () => {
  it('restores the position instantly, not as an animated scroll', () => {
    // Three built-in templates (portfolio, contact-landing, business-website) set
    // scroll-behavior: smooth on the document. scrollTo(x, y) obeys that, so restoring a position
    // animated a scroll over a document that had only just been replaced -- the page visibly slid to
    // where it had been instead of simply opening there. 'instant' overrides the CSS declaration;
    // 'auto' defers to it, which is the bug.
    send({ type: 'scroll-restore', scrollX: 0, scrollY: 500 });

    expect(scrollBehaviours).toEqual(['instant']);
  });

  it('scrolls a fresh document back to where the host says the old one was', () => {
    // Every Text or Replace edit writes a source file, which recompiles, which mints a document that
    // starts at the top. Measured: scrollY 500 before, 0 after.
    setScroll(0);

    send({ type: 'scroll-restore', scrollX: 7, scrollY: 500 });

    expect(window.scrollY).toBe(500);
    expect(window.scrollX).toBe(7);
  });

  it('ignores a restore that names no position rather than jumping to the top', () => {
    scrollFrameTo(120, 4);

    send({ type: 'scroll-restore' });

    // The top is where an untouched fresh document already is, so acting on a malformed message could
    // only ever take the user somewhere they did not ask to go.
    expect(window.scrollY).toBe(120);
    expect(window.scrollX).toBe(4);
  });

  it('re-checks an already-mounted bar against the restored scroll', () => {
    const el = document.querySelector('#one')!;
    setViewport(600);
    // 529 down the document, and the document is at the top — so there is room above it right now.
    setRect(el, { top: 529, left: 40, width: 200, height: 40 });
    setScroll(0);
    select('#one');
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');

    send({ type: 'scroll-restore', scrollX: 0, scrollY: 500 });

    // The host sends the restore *before* the `selection-resolve` that re-anchors the bar, so on the
    // ordinary frame-ready path there is no toolbar up yet for this to matter to. It matters for every
    // other order: a bar placed against scroll 0 and then shown at scroll 500 is a bar 9px off the top
    // of the screen, which is the defect this pair of fixes exists for.
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    expect(hostTop()).toBe(529 + 40 + TOOLBAR_GAP);
  });

  it('places a selection resolved after a restore against the restored scroll', () => {
    // The two messages in the order the host sends them, which is the property Fix 2 turns on: the
    // toolbar is re-anchored by `selection-resolve`, and its side is chosen from the viewport.
    const el = document.querySelector('#one')!;
    setViewport(600);
    setRect(el, { top: 529, left: 40, width: 200, height: 40 });
    setScroll(0);

    send({ type: 'scroll-restore', scrollX: 0, scrollY: 500 });
    send({ type: 'selection-resolve', domPath: '#one' });

    expect(window.scrollY).toBe(500);
    expect(host()).not.toBeNull();
    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    // Visible: 79px below the top of what the user is looking at, rather than 9px above it.
    expect(hostTop() - 500).toBe(79);
  });
});

describe('lifetime', () => {
  it('removes the host entirely on selection-clear', () => {
    select('#one');
    expect(host()).not.toBeNull();

    send({ type: 'selection-clear' });

    // Removed, not hidden: the host is what every exclusion keys on, and one left in the document
    // with display:none is still serialised into an outerHTML capture.
    expect(host()).toBeNull();
  });

  it('leaves exactly one toolbar in the document after selecting a second element', () => {
    select('#one');
    select('#two');

    // The leak this architecture invites: the toolbar is created imperatively, so a missing teardown
    // accumulates hosts rather than replacing them — and each one is invisible to the document walks
    // that would otherwise reveal it.
    expect(document.querySelectorAll(`[${TOOLBAR_HOST_ATTR}]`)).toHaveLength(1);
    expect(hostTop()).toBe(100 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
  });

  it('re-positions when its ResizeObserver fires', () => {
    const el = document.querySelector('#one')!;
    setRect(el, { top: 100, left: 40, width: 200, height: 50 });
    select('#one');
    expect(hostTop()).toBe(100 - TOOLBAR_HEIGHT - TOOLBAR_GAP);

    // The observer is constructed once at script init, so there is exactly one callback to drive —
    // an implementation that registered it per selection would have accumulated more by now.
    expect(resizeCallbacks).toHaveLength(1);
    setRect(el, { top: 300, left: 40, width: 200, height: 90 });
    resizeCallbacks[0]();

    expect(hostTop()).toBe(300 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
  });

  it('re-positions after a style-preview', () => {
    const el = document.querySelector('#one')!;
    setRect(el, { top: 100, left: 40, width: 200, height: 50 });
    select('#one');

    // A transient style is how the Inspector shows an uncommitted change, and padding, font-size and
    // border-width all move the element. Nothing else would ask for a new position: there is no
    // scroll, no message back to the host and no recompile. This is also the only path that works
    // where ResizeObserver is absent.
    setRect(el, { top: 100, left: 40, width: 200, height: 140 });
    send({ type: 'style-preview', markerId: 'm1', css: 'padding: 40px' });

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('above');
    expect(hostTop()).toBe(100 - TOOLBAR_HEIGHT - TOOLBAR_GAP);
    // The element grew downwards, so its top did not move — but the toolbar has to have been asked.
    // Proven by the flip: the same reposition on an element that has moved to the document top must
    // now place below, which a reposition that never ran cannot produce.
    setRect(el, { top: 4, left: 40, width: 200, height: 140 });
    send({ type: 'style-preview', markerId: 'm1', css: 'padding: 40px' });

    expect(host()!.getAttribute(TOOLBAR_PLACEMENT_ATTR)).toBe('below');
    expect(hostTop()).toBe(4 + 140 + TOOLBAR_GAP);
  });

  it('releases a tracked element that has been removed from the document', () => {
    select('#one');
    document.querySelector('#one')!.remove();

    send({ type: 'style-preview', markerId: 'm1', css: 'color: red' });

    // The frame holds the element in a closure, so nothing else would ever let go of it.
    expect(host()).toBeNull();
  });
});

describe('the chrome is in a shadow root', () => {
  it('is invisible to document walks and to a children walk of the host', () => {
    select('#one');

    // The three properties the exclusion design rests on, measured rather than assumed.
    expect(document.querySelector('.osw-toolbar')).toBeNull();
    expect(host()!.children).toHaveLength(0);
    expect(host()!.shadowRoot!.querySelector('.osw-toolbar')).not.toBeNull();
  });
});

describe('elementKind', () => {
  function payload(over: Partial<FocusContextPayload>): FocusContextPayload {
    return {
      domPath: 'html > body > p', tagName: 'p', nodeId: '1', attributes: {}, outerHTML: '<p>a</p>',
      ...over,
    };
  }

  it('calls an img an image whatever else it carries', () => {
    expect(elementKind(payload({ tagName: 'img', attributes: { src: '/logo.png' } }))).toBe('image');
    // Even one the frame did not call text-bearing, which is every image: the tag decides.
    expect(elementKind(payload({ tagName: 'IMG', textBearing: false }))).toBe('image');
  });

  it('does not read srcAttr to decide, and does not confuse it with the image src', () => {
    // srcAttr is the raw data-osw-src provenance value, "<path>:<index>" — not a URL. An earlier
    // draft of the plan named it as the image source, which would resolve every image to a file
    // that does not exist. The image's own source is attributes.src.
    const image = payload({ tagName: 'img', srcAttr: '/index.hbs:412', attributes: { src: '/a.png' } });

    expect(elementKind(image)).toBe('image');
    expect(elementKind(payload({ tagName: 'p', srcAttr: '/index.hbs:412', textBearing: true }))).toBe('text');
  });

  it('calls a text-bearing element text, on the frame word rather than on the markup', () => {
    expect(elementKind(payload({ tagName: 'h1', textBearing: true }))).toBe('text');
    // outerHTML says there is text in there; the frame says it is not one plain run, and the frame
    // is the half that had the live element.
    expect(elementKind(payload({
      tagName: 'p', textBearing: false, outerHTML: '<p>Hello <strong>you</strong></p>',
    }))).toBe('container');
  });

  it('calls anything else a container, including a payload that never stated the fact', () => {
    expect(elementKind(payload({ tagName: 'div' }))).toBe('container');
    expect(elementKind(payload({ tagName: 'section', textBearing: false }))).toBe('container');
  });
});

describe('the emitted script text', () => {
  it('carries the toolbar source verbatim, exactly once', () => {
    const emitted = generateNavigationScript('/index.html');
    let count = 0;
    const needle = 'function __oswToolbarTrack(';
    for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) count++;

    expect(count).toBe(1);
    // Verbatim, so the escaping guard below is a guard on what actually ships and not on a copy.
    expect(emitted).toContain(TOOLBAR_DOM_JS);
  });

  it('contains no backtick anywhere', () => {
    // A build-breakage guard, not a style check: the whole script is a template literal, and one
    // backtick in it terminates the literal. That has broken the build twice, once from a backtick
    // inside a comment. Asserted over the entire emitted script rather than the toolbar's share of
    // it, because a backtick anywhere in the file is the same breakage — and the file is clean
    // today, so there is nothing to carve out.
    expect(generateNavigationScript('/index.html')).not.toContain('`');
    expect(TOOLBAR_DOM_JS).not.toContain('`');
    expect(TOOLBAR_SHADOW_CSS).not.toContain('`');
  });

  it('carries no regex escape out of the toolbar source', () => {
    // The other half of the trap: an authored `\s` inside those literals collapses to a literal `s`
    // before it is emitted, so a hand-written regex is wrong in a way only the emitted text shows.
    // The rule for this module is therefore "no regexes at all", and a backslash-escape in its
    // emitted text is the evidence that one was written.
    //
    // Scoped to the toolbar rather than the whole script, deliberately: the surrounding script does
    // emit `\s`, from STRIP_PROVENANCE_JS, which is authored in `lib/preview/provenance.ts` with the
    // doubling that survives. A whole-script assertion here would fail against code that is correct.
    expect(TOOLBAR_DOM_JS).not.toContain('\\s');
    expect(TOOLBAR_DOM_JS).not.toContain('\\d');
    expect(TOOLBAR_SHADOW_CSS).not.toContain('\\s');

    // Those three only see an escape that survived, which is the doubled, working form. The
    // regression the comment above describes — a single `\s` — never reaches the value at all, so it
    // is looked for where it was written: the authored text of the two literals.
    const source = fs.readFileSync(path.join(__dirname, '..', 'toolbar-dom.ts'), 'utf8');
    const between = (start: string, end: string) => {
      const from = source.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const to = source.indexOf(end, from + start.length);
      expect(to, end).toBeGreaterThan(from);
      return source.slice(from + start.length, to);
    };
    const authoredJs = between('export const TOOLBAR_DOM_JS = `', '\n`;');
    const authoredCss = between('export const TOOLBAR_SHADOW_CSS = [', '].join(');
    // The slices are the literals and not something empty: each carries text the value is known to.
    expect(authoredJs).toContain('function __oswToolbarTrack(');
    expect(authoredCss).toContain('.osw-toolbar-btn {');
    expect(authoredJs).not.toContain('\\');
    expect(authoredCss).not.toContain('\\');
  });
});

/**
 * The bar is icon-only, so the tooltip is the only thing that says what a button does.
 *
 * Asserted against the emitted stylesheet because that text *is* the feature: there is no node to
 * inspect and jsdom computes no styles, so the rule either reaches the shadow root or the bar ships
 * five unlabelled glyphs.
 */
describe('the tooltip', () => {
  it('takes its words from the accessible name, so there is one source', () => {
    expect(TOOLBAR_SHADOW_CSS).toContain('content: attr(aria-label);');
  });

  it('is hidden until the button is hovered', () => {
    expect(TOOLBAR_SHADOW_CSS).toContain('.osw-toolbar-btn::after');
    expect(TOOLBAR_SHADOW_CSS).toContain('.osw-toolbar-btn:hover::after');
    expect(TOOLBAR_SHADOW_CSS).toContain('opacity: 0;');
  });

  it('waits before appearing, so sweeping the bar does not flash four labels', () => {
    // The delay is the third value in the shorthand; without it an icon bar is unusable to move
    // across, which is the objection icon-only bars usually earn.
    expect(TOOLBAR_SHADOW_CSS).toMatch(/transition: opacity \d+ms ease \d+ms;/);
  });

  it('opens away from the element, flipping with the bar', () => {
    // Above the button while the bar is above the element; below it once the bar has flipped. The
    // other way round and the label covers the thing the button is about to change.
    expect(TOOLBAR_SHADOW_CSS).toContain('bottom: calc(100% + 7px);');
    expect(TOOLBAR_SHADOW_CSS).toContain(
      ':host([' + TOOLBAR_PLACEMENT_ATTR + '="below"]) .osw-toolbar-btn::after');
    expect(TOOLBAR_SHADOW_CSS).toContain('top: calc(100% + 7px);');
  });

  it('needs the button to be a containing block, or it positions off the bar', () => {
    const btn = TOOLBAR_SHADOW_CSS.slice(TOOLBAR_SHADOW_CSS.indexOf('.osw-toolbar-btn {'));
    expect(btn.slice(0, btn.indexOf('}'))).toContain('position: relative;');
  });

  it('carries no solid accent fill anywhere', () => {
    // The whole bar is neutral now: nothing on it is destructive or a commitment, and a solid
    // orange block was the loudest thing on the page while only meaning "opens a panel".
    expect(TOOLBAR_SHADOW_CSS).not.toContain('osw-toolbar-btn-primary');

    // The class name is only one way back. A solid fill arrives as a background, under any selector,
    // so every background the sheet sets has to be one of the neutral surfaces or nothing.
    const fills = [...TOOLBAR_SHADOW_CSS.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)].map(m => m[1].trim());
    expect(fills.length).toBeGreaterThan(0);
    const neutral = ['bg', 'hover', 'border'].map(name => 'var(' + TOOLBAR_THEME_PREFIX + name + ',');
    for (const fill of fills) {
      expect(fill === 'transparent' || neutral.some(prefix => fill.startsWith(prefix)), fill).toBe(true);
    }
    // And no colour the host sends is the app's accent proper: `--accent` is the muted hover tint.
    expect(TOOLBAR_THEME_TOKENS.map(t => t.token)).not.toContain('--primary');
  });
});

