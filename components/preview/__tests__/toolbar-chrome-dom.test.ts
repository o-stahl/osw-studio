// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  TOOLBAR_HOST_ATTR,
  TOOLBAR_ACTION_ATTR,
  TOOLBAR_HEIGHT,
  TOOLBAR_SHADOW_CSS,
  TOOLBAR_THEME_PREFIX,
  TOOLBAR_THEME_TOKENS,
  resolveToolbarTheme,
} from '@/lib/preview/toolbar-dom';
import { generateNavigationScript } from '../multipage-preview';

/**
 * The toolbar's chrome: what it shows, what pressing it says, and where its colours come from.
 *
 * A separate file from `lib/preview/__tests__/toolbar-dom.test.ts` (placement and lifetime) because
 * each file may install the emitted script exactly once — a second `new Function(...)` run adds
 * another `message` listener to the same jsdom window and doubles every reply.
 *
 * Two measured jsdom facts shape everything below:
 *
 * - **no layout**, so `getBoundingClientRect()` is all zeros and the toolbar — which refuses a
 *   zero-size element — would never mount at all. Stubbed, or every test here passes vacuously.
 * - **a shadow event needs `composed: true`** to cross the boundary. The handlers under test are on
 *   the buttons themselves so they fire either way, but a click a real user makes is composed, and
 *   the interesting question is what the *document* sees at the same time.
 */

interface StubRect { top: number; left: number; width: number; height: number }

const RECT: StubRect = { top: 100, left: 40, width: 200, height: 50 };

interface Posted { type?: string; action?: string; nodeId?: string }

let posted: Posted[] = [];

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function host(): HTMLElement {
  return document.querySelector<HTMLElement>(`[${TOOLBAR_HOST_ATTR}]`)!;
}

function bar(): HTMLElement {
  return host().shadowRoot!.querySelector<HTMLElement>('.osw-toolbar')!;
}

/**
 * The bar's children, left to right, named by what they *are*.
 *
 * A button is named by its action and everything else by its class. Naming the buttons by class
 * instead pinned the restyle rather than the layout: changing the icon buttons' padding turned this
 * red while the order it exists to check had not moved.
 */
function layout(): string[] {
  return Array.from(bar().children).map(el =>
    el.getAttribute(TOOLBAR_ACTION_ATTR) || el.getAttribute('class') || el.tagName.toLowerCase());
}

/**
 * By accessible name, which is also what the tooltip shows.
 *
 * Not by `title`: every action is an icon now, and the bar carries its own tooltip built from
 * `aria-label` in CSS, so the native attribute was removed rather than left to fire a second, slower
 * copy of the same words.
 */
function button(label: string): HTMLElement {
  const found = Array.from(bar().querySelectorAll<HTMLElement>('button'))
    .find(el => el.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no button labelled ${label}, have: ${
    Array.from(bar().querySelectorAll('button')).map(el => el.getAttribute('aria-label')).join(' | ')}`);
  return found;
}

/** A press, as a user makes it: inside the shadow root, and composed so the document sees it too. */
function press(label: string): void {
  button(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
}

function select(selector: string): Element {
  const el = document.querySelector(selector)!;
  send({ type: 'selector-toggle', active: true });
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return el;
}

function actions(): Posted[] {
  return posted.filter(m => m.type === 'toolbar-action');
}

/**
 * One element per kind the slot has an answer for, plus the two edges that decide the boundary: an
 * element whose only content is whitespace, and one whose text is wrapped in a child.
 */
const MARKUP = '<main>'
  + '<section id="one">a</section>'
  + '<section class="card wide">b</section>'
  + '<section>c</section>'
  + '<section id="box"><span>words</span></section>'
  + '<section id="blank">   </section>'
  + '<img id="pic" src="/logo.png" alt="a logo">'
  + '</main>';

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

describe('the bar', () => {
  it('reads left to right: element name, Style, separator, include, dismiss', () => {
    // A container, so the middle slot is empty and this is the bar at its shortest. The kinds that
    // fill the slot are their own describe below.
    select('#box');

    expect(layout()).toEqual([
      'osw-toolbar-name',
      'style',
      'osw-toolbar-sep',
      'include',
      'dismiss',
    ]);
    // Icon-only: the name lives on `aria-label`, which is what `button()` found it by, and the
    // tooltip renders from that same attribute.
    expect(button('Style').querySelector('svg')).not.toBeNull();
    expect(button('Style').textContent).toBe('');
  });

  it('names the element it is anchored to, and renames when the selection moves', () => {
    select('#one');
    expect(bar().querySelector('.osw-toolbar-name')!.textContent).toBe('section#one');

    select('.card');

    // Not a second toolbar with the old label still on the first — the host is reused, so the label
    // is state that has to be rewritten rather than rebuilt.
    expect(document.querySelectorAll(`[${TOOLBAR_HOST_ATTR}]`)).toHaveLength(1);
    expect(bar().querySelector('.osw-toolbar-name')!.textContent).toBe('section.card');
  });

  it('falls back to the bare tag when there is no id and no class', () => {
    select('main > section:nth-of-type(3)');

    expect(bar().querySelector('.osw-toolbar-name')!.textContent).toBe('section');
  });

  it('leaves the outline on the element after a click selection, not only a tree one', () => {
    // The picker disarms the instant you click, and disableSelector used to blank the outline on the
    // way out — so a click-selected element showed a toolbar pointing at nothing marked, while the
    // same element picked from the Inspector tree kept its outline. The two paths now agree.
    select('#one');

    const overlay = document.querySelector<HTMLElement>('[data-osw-overlay]')!;
    expect(overlay.style.opacity).toBe('1');
    // On the element, not parked at the origin: the stub puts every rect at RECT.
    expect(overlay.style.top).toBe(RECT.top + 'px');
    expect(overlay.style.left).toBe(RECT.left + 'px');
  });

  it('takes the outline away when the selection is dismissed', () => {
    select('#one');
    expect(document.querySelector<HTMLElement>('[data-osw-overlay]')!.style.opacity).toBe('1');

    send({ type: 'selection-clear' });

    // The toolbar and the outline mark the same element, so releasing one has to release the other
    // or the page keeps a highlight with nothing anchored to it.
    expect(document.querySelector<HTMLElement>('[data-osw-overlay]')!.style.opacity).toBe('0');
    expect(document.querySelector(`[${TOOLBAR_HOST_ATTR}]`)).toBeNull();
  });

  it('does not use a crosshair for the include button', () => {
    select('#one');

    // The preview header already spends the crosshair on arming the focus tool, and tints it
    // whenever something is selected. A second crosshair meaning 'include in the message', beside a
    // tinted one meaning only 'something is selected', is the same mark for two different states.
    const icon = button('Add to next message').querySelector('svg')!;
    const paths = Array.from(icon.querySelectorAll('path')).map(p => p.getAttribute('d'));
    expect(paths.length).toBeGreaterThan(1);
    // A crosshair is a circle plus two crossing lines. Neither shape is here.
    expect(icon.querySelector('circle')).toBeNull();
    expect(paths[0]).toContain('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
  });
});

describe('the kind-specific slot', () => {
  it('offers Text, between Style and the separator, for a leaf with words in it', () => {
    select('#one');

    // Position is the assertion, not merely presence: the mockup puts the kind-specific action with
    // the one other thing that changes the element, on the near side of the divider from the two
    // that act on the selection.
    expect(layout()).toEqual([
      'osw-toolbar-name',
      'style',
      'text',
      'osw-toolbar-sep',
      'include',
      'dismiss',
    ]);
    expect(button('Edit text').querySelector('svg')).not.toBeNull();
    expect(button('Edit text').textContent).toBe('');
  });

  it('offers Replace, in the same place, for an image', () => {
    select('#pic');

    expect(layout()).toEqual([
      'osw-toolbar-name',
      'style',
      'replace',
      'osw-toolbar-sep',
      'include',
      'dismiss',
    ]);
    expect(button('Replace image').querySelector('svg')).not.toBeNull();
    expect(button('Replace image').textContent).toBe('');
  });

  it('gives a container no middle button rather than a disabled one', () => {
    select('#box');

    // Its text lives in a child, so replacing the element's content would clobber the markup. The
    // slot is empty, not filled with something that refuses when pressed.
    expect(bar().querySelector(`[${TOOLBAR_ACTION_ATTR}="text"]`)).toBeNull();
    expect(bar().querySelector(`[${TOOLBAR_ACTION_ATTR}="replace"]`)).toBeNull();
    expect(layout()).not.toContain('text');
  });

  it('treats an element holding only whitespace as a container', () => {
    select('#blank');

    // A leaf with nothing but spaces in it has no text to edit, and offering Text on it would open a
    // popover on an empty run. The boundary is non-whitespace content, not "has a text node".
    expect(layout()).not.toContain('text');
  });

  it('swaps the slot as the selection moves between kinds, leaving one button at most', () => {
    select('#one');
    expect(layout()).toContain('text');

    select('#pic');

    // The bar is reused across selections, so the slot is state that has to be taken out as well as
    // put in — a rebuild-free implementation that only ever appends would show Text and Replace at
    // once here, and then keep both over a container.
    expect(layout()).toContain('replace');
    expect(layout()).not.toContain('text');

    select('#box');

    expect(layout()).not.toContain('replace');
    expect(layout()).toEqual(['osw-toolbar-name', 'style', 'osw-toolbar-sep', 'include', 'dismiss']);
  });

  it('relays a slot press like any other, naming the tracked element', () => {
    const el = select('#pic');
    posted = [];

    press('Replace image');

    // What the button does is Task 2. What it says is this: the same message shape every other
    // button sends, so the host has one place that learns about presses rather than two.
    expect(actions()).toEqual([
      { type: 'toolbar-action', action: 'replace', nodeId: el.getAttribute('data-osw-node') },
    ]);
  });

  it('relays a Text press, from the element the bar is on now', () => {
    select('#pic');
    const second = select('#one');
    posted = [];

    press('Edit text');

    // The slot buttons are built once and moved, so their handlers close over the tracked state and
    // not over the element the bar happened to be on when they were built.
    expect(actions()).toEqual([
      { type: 'toolbar-action', action: 'text', nodeId: second.getAttribute('data-osw-node') },
    ]);
  });
});

describe('a press', () => {
  it('relays style, include and dismiss to the host, naming the tracked element', () => {
    const el = select('#one');
    const nodeId = el.getAttribute('data-osw-node');
    expect(nodeId).toMatch(/^\d+$/);
    posted = [];

    press('Style');
    press('Add to next message');
    press('Dismiss');

    expect(actions()).toEqual([
      { type: 'toolbar-action', action: 'style', nodeId },
      { type: 'toolbar-action', action: 'include', nodeId },
      { type: 'toolbar-action', action: 'dismiss', nodeId },
    ]);
  });

  it('names the element currently tracked, not the one the toolbar first mounted on', () => {
    select('#one');
    const second = select('.card');
    posted = [];

    press('Dismiss');

    // One host, reused across selections — so the handlers bound at build time close over the
    // *state*, not over the element they were built for.
    expect(actions()[0].nodeId).toBe(second.getAttribute('data-osw-node'));
  });

  it('is not reported to the host as a click in the page', () => {
    select('#one');
    posted = [];

    press('Dismiss');

    // Composed, so the document-level relay does see the event — retargeted to the host, which is
    // where the exclusion catches it. Without that, pressing a toolbar button would also close the
    // block palette and fire onPlacementToggle.
    expect(posted.filter(m => m.type === 'iframe-click')).toHaveLength(0);
    expect(actions()).toHaveLength(1);
  });
});

describe('hovering Style', () => {
  function hovers(): Array<string | null> {
    return posted.filter(m => m.type === 'toolbar-hover').map(m => (m as { action?: string | null }).action ?? null);
  }

  function pointer(title: string, type: string): void {
    button(title).dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
  }

  it('announces the hover so the host can show which panel would be replaced', () => {
    select('#one');
    posted = [];

    pointer('Style', 'mouseenter');

    // Pressing Style rearranges the panels, and which one closes to make room is not visible on the
    // button. The host answers that with the same picker `togglePanel` uses.
    expect(hovers()).toEqual(['style']);
  });

  it('withdraws it on leave and on the press itself', () => {
    select('#one');
    posted = [];

    pointer('Style', 'mouseleave');
    expect(hovers()).toEqual([null]);

    posted = [];
    press('Style');

    // The press opens the panel, so a highlight still saying a panel is *about to* close is
    // describing something that has already happened.
    expect(hovers()).toEqual([null]);
  });

  it('says nothing for the buttons whose effect is visible where they are', () => {
    select('#one');
    posted = [];

    pointer('Add to next message', 'mouseenter');
    pointer('Dismiss', 'mouseenter');

    expect(hovers()).toEqual([]);
  });
});

describe('the theme', () => {
  it('sets the app colours as custom properties on the shadow host', () => {
    send({ type: 'toolbar-theme', colors: { [`${TOOLBAR_THEME_PREFIX}bg`]: 'rgb(1, 2, 3)' } });

    select('#one');

    // Set on the host, not inside the shadow root: custom properties inherit across the boundary,
    // which is the only way the app's palette reaches chrome the app's stylesheet cannot style.
    expect(host().style.getPropertyValue(`${TOOLBAR_THEME_PREFIX}bg`)).toBe('rgb(1, 2, 3)');
  });

  it('applies colours that arrive after the toolbar is already mounted', () => {
    select('#one');

    send({ type: 'toolbar-theme', colors: { [`${TOOLBAR_THEME_PREFIX}fg`]: 'rgb(9, 9, 9)' } });

    // The app re-sends on every frame-ready and on every theme change, and a theme change does not
    // reload the frame — so a toolbar already on screen has to pick the new colours up.
    expect(host().style.getPropertyValue(`${TOOLBAR_THEME_PREFIX}fg`)).toBe('rgb(9, 9, 9)');
  });

  it('ignores properties outside the toolbar namespace', () => {
    send({
      type: 'toolbar-theme',
      colors: { 'position': 'fixed', '--page-bg': 'red', [`${TOOLBAR_THEME_PREFIX}bg`]: 'rgb(4, 5, 6)' },
    });

    select('#one');

    // These values arrive over postMessage and are written straight into inline style. The prefix
    // check is why the frame does not have to trust the sender: 'position' here would unpin the
    // toolbar from the element it is anchored to.
    expect(host().style.position).toBe('absolute');
    expect(host().style.getPropertyValue('--page-bg')).toBe('');
    expect(host().style.getPropertyValue(`${TOOLBAR_THEME_PREFIX}bg`)).toBe('rgb(4, 5, 6)');
  });
});

describe('resolveToolbarTheme', () => {
  it('reads the app tokens off the element it is given', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (const entry of TOOLBAR_THEME_TOKENS) root.style.setProperty(entry.token, 'rgb(7, 7, 7)');

    const colors = resolveToolbarTheme(root, 'dark');

    for (const entry of TOOLBAR_THEME_TOKENS) expect(colors[entry.prop], entry.prop).toBe('rgb(7, 7, 7)');
    root.remove();
  });

  it('falls back per theme when a token resolves to nothing', () => {
    // Not cosmetic. getComputedStyle returns an empty string for an undefined custom property, and
    // setProperty with an empty string *removes* the declaration — so without the fallback the
    // chrome would silently drop to its dark CSS default in a light-themed app.
    const dark = resolveToolbarTheme(document.createElement('div'), 'dark');
    const light = resolveToolbarTheme(document.createElement('div'), 'light');

    for (const entry of TOOLBAR_THEME_TOKENS) {
      expect(dark[entry.prop], entry.prop).toBe(entry.dark);
      expect(light[entry.prop], entry.prop).toBe(entry.light);
    }
    // Light and dark must actually differ somewhere, or the fallback pair is decoration.
    expect(TOOLBAR_THEME_TOKENS.some(entry => entry.dark !== entry.light)).toBe(true);
  });

  it('answers with a full palette even with no element to read', () => {
    const colors = resolveToolbarTheme(null);

    // Every key present: a partial palette leaves some of the chrome on its CSS fallback and the
    // rest on the app's, which is the one outcome that looks broken rather than merely wrong.
    expect(Object.keys(colors).sort()).toEqual(TOOLBAR_THEME_TOKENS.map(e => e.prop).sort());
    for (const value of Object.values(colors)) expect(value).not.toBe('');
  });
});

describe('the chrome fits the constant the placement is computed from', () => {
  it('declares no height taller than TOOLBAR_HEIGHT', () => {
    // TOOLBAR_HEIGHT is load-bearing three times over: it is the offset the host is lifted by, the
    // threshold for flipping below, and the bar's own height. A child taller than the bar makes the
    // rendered toolbar overlap the element it is labelling, and no test of the placement would see
    // it — placement reads the constant, not the DOM.
    const heights = [...TOOLBAR_SHADOW_CSS.matchAll(/height:\s*(\d+)px/g)].map(m => Number(m[1]));

    expect(heights.length).toBeGreaterThan(0);
    expect(Math.max(...heights)).toBe(TOOLBAR_HEIGHT);
    expect(TOOLBAR_SHADOW_CSS).toContain(`height: ${TOOLBAR_HEIGHT}px`);
  });
});

describe('every action is an icon', () => {
  it('gives each button a glyph, an accessible name, and no native title', () => {
    select('#one');
    const buttons = Array.from(bar().querySelectorAll<HTMLElement>('button'));
    expect(buttons.length).toBeGreaterThan(2);
    for (const el of buttons) {
      const name = el.getAttribute('aria-label');
      expect(name, 'a button with no accessible name has no tooltip either').toBeTruthy();
      expect(el.textContent, `${name} still carries a word`).toBe('');
      expect(el.querySelector('svg'), `${name} has no icon`).not.toBeNull();
      // Both would render: ours on a delay, the browser's a second later, saying the same thing.
      expect(el.getAttribute('title'), `${name} kept a native tooltip`).toBeNull();
    }
  });

  it('names them in words a non-developer can act on', () => {
    select('#one');
    const names = Array.from(bar().querySelectorAll('button'))
      .map(el => el.getAttribute('aria-label'));
    expect(names).toContain('Style');
    expect(names).toContain('Add to next message');
    expect(names).toContain('Dismiss');
  });
});

