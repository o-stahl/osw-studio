// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generatePlacementScript } from '../multipage-preview';

/**
 * A block dropped on a page compiled with source positions: the emitted placement script, run in a
 * jsdom document, reports the drop as a place in source terms for the host to write the placeholder
 * at, and puts nothing into the frame itself.
 *
 * jsdom has no layout and no `elementFromPoint`: the element under the pointer is stubbed (`hit`),
 * and every element measures 100 to 140 down, so a pointer at 105 is in the top half (before) and at
 * 135 in the bottom half (after).
 */

let posted: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
let hit: Element | null = null;

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

/** Drop the hero on `selector`'s element, in its top or bottom half; what the frame reports. */
function drop(selector: string, half: 'top' | 'bottom'): Record<string, unknown> {
  hit = document.querySelector(selector);
  if (!hit) throw new Error(`nothing at ${selector}`);
  posted = [];
  send({ type: 'placement-start', block: { id: 'hero', name: 'Hero Section', wireframeHtml: '<div data-semantic-placeholder="true">Hero</div>' } });
  send({ type: 'placement-hover', x: 10, y: half === 'top' ? 105 : 135 });
  send({ type: 'placement-drop' });
  send({ type: 'placement-cancel' });
  const complete = posted.filter(m => m.type === 'placement-complete');
  expect(complete).toHaveLength(1);
  return complete[0].payload!;
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message); } },
  });
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { top: 100, left: 0, width: 200, height: 40, right: 200, bottom: 140, x: 0, y: 100, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit });
  new Function(jsOf(generatePlacementScript('/index.html')))();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a block dropped on a page with source positions', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main data-osw-src="/index.html:6">' +
        '<h1 data-osw-src="/index.html:14">Hi</h1>' +
        '<p data-osw-src="/index.html:30">Lead</p>' +
      '</main>';
  });

  it('goes before or after the element by the half the pointer is in, and the frame adds nothing', () => {
    expect(drop('p', 'top')).toEqual({ blockId: 'hero', place: { before: '/index.html:30' }, instances: 1, page: '/index.html' });
    expect(drop('p', 'bottom')).toEqual({ blockId: 'hero', place: { after: '/index.html:30' }, instances: 1, page: '/index.html' });
    // The host writes the placeholder and every frame shows it from the source.
    expect(document.querySelector('[data-semantic-placeholder], [data-placement-id]')).toBeNull();
  });

  it('goes beside the nearest element from source when the pointer is on one a script built', () => {
    document.body.innerHTML = '<section data-osw-src="/index.html:6"><div class="built"><span>x</span></div></section>';
    expect(drop('span', 'bottom').place).toEqual({ after: '/index.html:6' });
  });
});

describe('a drop beside elements of other files', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<header data-osw-src="/templates/header.hbs:0"><nav data-osw-src="/templates/header.hbs:9"></nav></header>' +
      '<main data-osw-src="/index.html:40"><section data-osw-src="/templates/hero.hbs:0"></section></main>' +
      '<footer data-osw-src="/templates/footer.hbs:0"></footer>';
  });

  it('names the page\'s own neighbour at the top level', () => {
    expect(drop('header', 'bottom').place).toEqual({ before: '/index.html:40' });
    expect(drop('footer', 'top').place).toEqual({ after: '/index.html:40' });
  });

  it('has no place past the last partial, where the page\'s source names nothing', () => {
    expect(drop('footer', 'bottom').place).toBeNull();
  });

  it('goes first or last in a page element whose only child comes from a partial', () => {
    expect(drop('section', 'top').place).toEqual({ parent: '/index.html:40', at: 'start' });
    expect(drop('section', 'bottom').place).toEqual({ parent: '/index.html:40', at: 'end' });
  });

  it('goes into the partial when dropped among its own elements', () => {
    expect(drop('nav', 'bottom').place).toEqual({ after: '/templates/header.hbs:9' });
  });

  it('stays in the page beside the page\'s own element inside a partial\'s', () => {
    // A partial block: the page's markup rendered inside the partial's element.
    document.body.innerHTML = '<div data-osw-src="/templates/card.hbs:0"><p data-osw-src="/index.html:70">a</p></div>';
    expect(drop('p', 'bottom').place).toEqual({ after: '/index.html:70' });
  });
});

describe('how many times the place renders', () => {
  it('is how many elements share the parent\'s source tag', () => {
    document.body.innerHTML =
      '<article data-osw-src="/templates/card.hbs:0"><p data-osw-src="/templates/card.hbs:9">a</p></article>' +
      '<article data-osw-src="/templates/card.hbs:0"><p data-osw-src="/templates/card.hbs:9" id="second">b</p></article>';
    expect(drop('#second', 'top')).toMatchObject({ place: { before: '/templates/card.hbs:9' }, instances: 2 });
  });
});

describe('a drop with nowhere to go', () => {
  it('ends the drag with nothing placed and tells the host it was cancelled', () => {
    // A page with no elements: nothing under the pointer and no last element to go after.
    hit = null;
    posted = [];
    send({ type: 'placement-start', block: { id: 'hero', name: 'Hero Section', wireframeHtml: '<div>Hero</div>' } });
    send({ type: 'placement-hover', x: 10, y: 105 });
    send({ type: 'placement-drop' });
    expect(posted.map(m => m.type)).toEqual(['placement-cancelled']);
    // The drag is over: once the page has an element, a hover and a drop place nothing.
    document.body.innerHTML = '<main data-osw-src="/index.html:6"><p data-osw-src="/index.html:14">x</p></main>';
    hit = document.querySelector('p');
    send({ type: 'placement-hover', x: 10, y: 105 });
    send({ type: 'placement-drop' });
    expect(posted.map(m => m.type)).toEqual(['placement-cancelled']);
  });
});

describe('a page compiled without source positions', () => {
  it('still gets the frame\'s own placeholder and the markup around it', () => {
    document.body.innerHTML = '<main><section id="one">a</section></main>';
    const payload = drop('#one', 'bottom');
    expect(payload).toMatchObject({ blockId: 'hero', domPath: 'body > section#one', position: 'after' });
    expect(String(payload.htmlContext)).toContain('<!-- INSERT Hero Section HERE -->');
    expect(document.querySelector(`[data-placement-id="${String(payload.placementId)}"]`)).not.toBeNull();
  });
});
