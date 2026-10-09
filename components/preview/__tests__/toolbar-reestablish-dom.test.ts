// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { TOOLBAR_HOST_ATTR } from '@/lib/preview/toolbar-dom';
import { generateNavigationScript } from '../multipage-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * Getting the toolbar back after a recompile.
 *
 * Every `srcdoc` reassignment mints a new document, and it takes the toolbar, the tracked element
 * and every `nodeId` with it. This is not an edge case in this feature: pressing `Style` flips
 * `provenance={showElements}`, which forces exactly that recompile — so the *first* press of the
 * toolbar's primary action always destroys the toolbar, and the only way it comes back is the
 * frame-ready handshake the host already runs (`focusReloadAction` → `selection-resolve`).
 *
 * There is no new message here, and that is the point: `selection-resolve` reaches
 * `buildSelectionPayload`, which is the one place the toolbar is anchored. The thing worth pinning
 * is that the round trip re-anchors to the *new* element rather than leaving the frame holding the
 * detached one it was closed over.
 *
 * **The teardown is asserted before the recovery in every test below.** "The toolbar is there after
 * the reload" is satisfied by a toolbar that was never taken down, so without proving the absence
 * first these tests would pass against an implementation that does nothing at all.
 *
 * jsdom has no layout, so the rect is stubbed — the toolbar refuses a zero-size element, and
 * unstubbed nothing would ever mount.
 */

interface StubRect { top: number; left: number; width: number; height: number }

const RECT: StubRect = { top: 100, left: 40, width: 200, height: 50 };

interface Posted { type?: string; action?: string; nodeId?: string; payload?: FocusContextPayload | null }

let posted: Posted[] = [];

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function host(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`);
}

function name(): string | null {
  return host()!.shadowRoot!.querySelector('.osw-toolbar-name')!.textContent;
}

function pressDismiss(): void {
  const button = Array.from(host()!.shadowRoot!.querySelectorAll<HTMLElement>('button'))
    .find(el => el.getAttribute('aria-label') === 'Dismiss')!;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}

function select(selector: string): FocusContextPayload {
  posted = [];
  send({ type: 'selector-toggle', active: true });
  document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return posted.find(m => m.type === 'selector-selection')!.payload as FocusContextPayload;
}

/**
 * What a recompile does to this document, as far as anything observable from here goes: a brand new
 * body, so the toolbar host and the tracked element are both detached and every `data-osw-node`
 * stamp is gone. The frame's script survives, which a real recompile's would not — but the script is
 * re-emitted identically into the new document, so what it holds in closures is the only difference,
 * and that is exactly what these tests are about.
 */
function recompile(markup: string): void {
  document.body.innerHTML = markup;
}

const MARKUP = '<main><section id="one">a</section><section id="two">b</section></main>';

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: Posted) => { posted.push(message); } },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return {
      ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height,
      x: RECT.left, y: RECT.top, toJSON: () => ({}),
    } as DOMRect;
  };
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  send({ type: 'selection-clear' });
  document.body.innerHTML = MARKUP;
  posted = [];
});

describe('the toolbar after a recompile', () => {
  it('is destroyed by the new document and re-anchored by selection-resolve', () => {
    const before = select('#one');
    expect(host()).not.toBeNull();

    recompile(MARKUP);
    // The teardown, proven rather than assumed. Everything after this is only evidence of recovery
    // because the toolbar is genuinely gone at this point.
    expect(host()).toBeNull();

    posted = [];
    send({ type: 'selection-resolve', domPath: before.domPath });

    expect(host()).not.toBeNull();
    expect(document.querySelectorAll(`[${TOOLBAR_HOST_ATTR}]`)).toHaveLength(1);
    expect(name()).toBe('section#one');
  });

  it('anchors to the element in the new document, not the detached one it was holding', () => {
    const before = select('#one');
    const stale = document.querySelector('#one')!;

    recompile(MARKUP);
    expect(host()).toBeNull();
    const fresh = document.querySelector('#one')!;
    expect(fresh).not.toBe(stale);

    posted = [];
    send({ type: 'selection-resolve', domPath: before.domPath });
    pressDismiss();

    // The frame holds the tracked element in a closure, so a recovery that only re-mounted the host
    // would leave every subsequent press naming a node that is not in the document — and the id it
    // named would be the *old* document's, which resolves to nothing.
    const action = posted.find(m => m.type === 'toolbar-action')!;
    expect(action.nodeId).toBe(fresh.getAttribute('data-osw-node'));
    expect(document.querySelector(`[data-osw-node="${action.nodeId}"]`)).toBe(fresh);
  });

  it('mints a node id in the new document, so the host can go on asking about the selection', () => {
    const before = select('#one');

    recompile(MARKUP);
    expect(host()).toBeNull();

    posted = [];
    send({ type: 'selection-resolve', domPath: before.domPath });

    // What the recompile actually invalidated is the id, not the path. The reply carries a fresh one
    // that resolves here, which is what every node-keyed message — style-query, style-probe — needs.
    const payload = posted.find(m => m.type === 'selection-resolved')!.payload as FocusContextPayload;
    expect(payload).not.toBeNull();
    expect(document.querySelector(`[data-osw-node="${payload.nodeId}"]`)).toBe(document.querySelector('#one'));
  });

  it('stays gone when the path no longer resolves in the new document', () => {
    const before = select('#one');

    recompile('<main><article id="three">c</article></main>');
    expect(host()).toBeNull();

    posted = [];
    send({ type: 'selection-resolve', domPath: before.domPath });

    // The host clears its focus context on a null payload; the frame must not have put a toolbar
    // back in the meantime, pointing at an element the agent has just edited away.
    expect(posted.find(m => m.type === 'selection-resolved')!.payload).toBeNull();
    expect(host()).toBeNull();
  });
});
