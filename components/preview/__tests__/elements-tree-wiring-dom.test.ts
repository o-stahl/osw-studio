// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript, generatePlacementScript } from '../multipage-preview';
import type { FocusContextPayload, TreeNode } from '@/lib/preview/types';

/**
 * The Elements tree's three frame handlers, run for real against a live document.
 *
 * `preview-plumbing.test.ts` asserts the structure of the emitted script — that there is one payload
 * builder and one overlay control. This asserts the handlers actually reach them, which is the part
 * no amount of reading the template literal can settle: everything here is a string until the
 * browser parses it.
 *
 * One script instance for the whole file, installed in `beforeAll`. Each `new Function(...)` run
 * installs another `message` listener on the same jsdom window, so a second instance would double
 * every posted reply and quietly invalidate the "posted exactly once" assertions.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  payload?: FocusContextPayload;
  parentId?: string | null;
  nodes?: TreeNode[];
  truncated?: number;
  nodeId?: string;
}

/**
 * Two rendered articles from one source tag, as a `{{#each}}` produces — so `instanceCount` is a
 * number that a wrong document or a wrong element would get wrong, rather than 1 either way.
 */
const MARKUP =
  '<main data-osw-src="/index.hbs:0">' +
    '<article class="post" data-tone="warm" data-osw-src="/index.hbs:24">' +
      '<h2 data-osw-src="/index.hbs:66">one</h2>' +
    '</article>' +
    '<article class="post" data-tone="warm" data-osw-src="/index.hbs:24">' +
      '<h2 data-osw-src="/index.hbs:66">two</h2>' +
    '</article>' +
  '</main>';

const posted: PostedMessage[] = [];

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function overlays(): NodeListOf<Element> {
  return document.querySelectorAll('[data-osw-overlay]');
}

function only(type: string): PostedMessage {
  const matches = posted.filter(m => m.type === type);
  expect(matches, `expected exactly one ${type}, got ${posted.map(m => m.type).join(', ') || 'nothing'}`)
    .toHaveLength(1);
  return matches[0];
}

/** Expand a level and return its rows. */
function requestLevel(nodeId: string | null): TreeNode[] {
  posted.length = 0;
  send({ type: 'tree-request', nodeId });
  return only('tree-level').nodes as TreeNode[];
}

/** The full text of a named function declaration, brace-matched out of a script. */
function functionText(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `no ${name} in the emitted script`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces around ${name}`);
}

interface Instance {
  doc: Document;
  posted: PostedMessage[];
  send: (message: unknown) => void;
}

/**
 * A second script instance over a fresh document, with its own message bus.
 *
 * The script reads `document` and `window` as free variables, so passing them as parameters to
 * `new Function` shadows the globals for the whole IIFE — an instance built here touches neither
 * the shared document nor the shared message bus.
 *
 * Two things need this. A reference payload has to come from a document the shared serializer has
 * never stamped, or it would carry the same leak as the payload under test and the two would
 * compare equal while both were wrong. And any assertion about *which numbers* the node counter
 * mints has to start from a counter at zero, which only a new instance gives.
 */
function isolatedInstance(markup: string): Instance {
  const doc = document.implementation.createHTMLDocument('isolated');
  doc.body.innerHTML = markup;

  const bus = new EventTarget();
  const instancePosted: PostedMessage[] = [];
  const win = {
    // `isInIframe` is `window !== window.parent`, so this object must not be its own parent.
    parent: { postMessage: (message: unknown) => { instancePosted.push(message as PostedMessage); } },
    scrollX: 0,
    scrollY: 0,
    addEventListener: (type: string, handler: EventListener, capture?: boolean) =>
      bus.addEventListener(type, handler, capture),
    removeEventListener: (type: string, handler: EventListener, capture?: boolean) =>
      bus.removeEventListener(type, handler, capture),
  };

  new Function('document', 'window', jsOf(generateNavigationScript('/index.html')))(doc, win);

  return {
    doc,
    posted: instancePosted,
    send: (message: unknown) => bus.dispatchEvent(Object.assign(new Event('message'), { data: message, source: win.parent })),
  };
}

/**
 * The payload a *click* produces, from a document this file's serializer has never touched.
 *
 * The clicked element comes back alongside the payload: its `nodeId` is minted by *that* document's
 * counter and so is legitimately not the shared document's, which means the equality assertion has
 * to check each id against the document that minted it rather than against the other payload.
 */
function referenceClickPayload(): { payload: FocusContextPayload; element: Element } {
  const instance = isolatedInstance(MARKUP);
  instance.send({ type: 'selector-toggle', active: true });
  const element = instance.doc.querySelectorAll('article')[1];
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  const selection = instance.posted.find(m => m.type === 'selector-selection');
  expect(selection, 'the reference document produced no click selection').toBeTruthy();
  return { payload: selection!.payload as FocusContextPayload, element };
}

beforeAll(() => {
  document.body.innerHTML = MARKUP;
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  posted.length = 0;
});

describe('tree-request', () => {
  it('serializes the body level when the id is null', () => {
    send({ type: 'tree-request', nodeId: null });

    const level = only('tree-level');
    expect(level.parentId).toBeNull();
    expect(level.nodes!.map(n => n.tag)).toEqual(['main']);
    expect(level.truncated).toBe(0);
    // From the body level, one row that can be opened — the thing the panel draws a caret from.
    expect(level.nodes![0].hasChildren).toBe(true);
    expect(level.nodes![0].file).toBe('/index.hbs');
  });

  it('names the parent it was asked about when expanding a node', () => {
    const [main] = requestLevel(null);
    posted.length = 0;

    send({ type: 'tree-request', nodeId: main.id });

    const level = only('tree-level');
    expect(level.parentId).toBe(main.id);
    expect(level.nodes!.map(n => n.tag)).toEqual(['article', 'article']);
    // Both rows come from the one source tag, and the panel has to be able to say so.
    expect(level.nodes!.map(n => n.instances)).toEqual([2, 2]);
  });
});

describe('tree-select', () => {
  it('produces the payload a click on the same element produces', () => {
    const reference = referenceClickPayload();

    const [main] = requestLevel(null);
    const articles = requestLevel(main.id);
    posted.length = 0;

    send({ type: 'tree-select', nodeId: articles[1].id });

    const payload = only('selector-selection').payload as FocusContextPayload;
    // `nodeId` is the one field that is *correctly* different: each document has its own counter,
    // and the shared document's articles were stamped by the two expansions above while the
    // reference document's start from zero. Compared with it lifted out of both sides — the
    // equality is what protects the "one payload builder" guarantee, so it stays — and then each
    // id is checked against the document that minted it.
    const { nodeId: payloadNodeId, ...payloadRest } = payload;
    const { nodeId: referenceNodeId, ...referenceRest } = reference.payload;
    expect(payloadRest).toEqual(referenceRest);
    expect(payloadNodeId).toBe(document.querySelectorAll('article')[1].getAttribute('data-osw-node'));
    expect(referenceNodeId).toBe(reference.element.getAttribute('data-osw-node'));

    // Spelled out as well as compared, so a regression that broke *both* paths at once — the one
    // failure equality alone cannot see — still fails here.
    expect(payload.domPath).toBe('html > body > main > article:nth-of-type(2)');
    expect(payload.outerHTML).toBe('<article class="post" data-tone="warm"><h2>two</h2></article>');
    expect(payload.srcAttr).toBe('/index.hbs:24');
    expect(payload.instanceCount).toBe(2);

    // The elements under test genuinely carry the stamp by now — the two expansions above put it
    // there — so this fails the moment the select path stops stripping it.
    expect(document.querySelectorAll('article')[1].getAttribute('data-osw-node')).toBe(articles[1].id);
    expect(JSON.stringify(payload)).not.toContain('data-osw-node');
  });

  it('treats an id the frame could not have minted as stale', () => {
    // Ids are minted inside the frame as `String(counter)`, so digits are the entire alphabet — but
    // this value arrives from the host over postMessage, which is a second writer. Fed to an
    // attribute selector unchecked, the string below closes the bracket and adds a second clause
    // that matches the two real articles, and the tree would answer a select nobody asked for.
    // (Other punctuation makes the selector invalid instead, throwing SyntaxError out of the
    // message handler and taking every branch after it down.)
    send({ type: 'tree-select', nodeId: '" ], [data-osw-src="/index.hbs:24' });

    expect(only('tree-stale')).toBeTruthy();
    expect(posted.filter(m => m.type === 'selector-selection')).toHaveLength(0);
  });

  it('reports a removed element as stale and selects nothing', () => {
    const [main] = requestLevel(null);
    const aside = document.createElement('aside');
    aside.setAttribute('data-osw-src', '/index.hbs:120');
    document.querySelector('main')!.appendChild(aside);

    const row = requestLevel(main.id).find(n => n.tag === 'aside');
    expect(row, 'the appended element was not serialized').toBeTruthy();
    aside.remove();
    posted.length = 0;

    send({ type: 'tree-select', nodeId: row!.id });

    expect(only('tree-stale').nodeId).toBe(row!.id);
    // The point of the whole addressing scheme: a dead id must not fall through to a payload built
    // from a detached node, whose domPath resolves to nothing or to a different element.
    expect(posted.filter(m => m.type === 'selector-selection')).toHaveLength(0);
  });
});

describe('tree-highlight', () => {
  it('shows and clears the click selector\'s own overlay, stranding nothing', () => {
    // Nothing has hovered or clicked in this document, so the overlay does not exist yet: a clear
    // arriving first must not conjure one.
    send({ type: 'tree-highlight', nodeId: null });
    expect(overlays()).toHaveLength(0);

    const [main] = requestLevel(null);
    send({ type: 'tree-highlight', nodeId: main.id });

    expect(overlays()).toHaveLength(1);
    const shown = overlays()[0] as HTMLElement;
    expect(shown.style.opacity).toBe('1');

    send({ type: 'tree-highlight', nodeId: null });

    // Hidden, not detached — and still the same node. Detaching would churn document.body.children
    // between two serializations of the body level, which is the instability the tree is built to
    // be immune to.
    expect(overlays()).toHaveLength(1);
    expect(overlays()[0]).toBe(shown);
    expect(shown.style.opacity).toBe('0');
  });

  it('leaves the body level unchanged, so the overlay is never a row', () => {
    const [main] = requestLevel(null);
    send({ type: 'tree-highlight', nodeId: main.id });

    expect(document.body.contains(overlays()[0])).toBe(true);
    expect(requestLevel(null).map(n => n.tag)).toEqual(['main']);
  });
});

/**
 * `nodeId` on a click selection — the handle the host has no other way to get.
 *
 * A clicked element is the case the addressing scheme did not previously cover: only the tree
 * serializer minted ids, so an element the user picked in the preview had none and nothing keyed on
 * a node id could be asked about it.
 */
describe('the nodeId a click produces', () => {
  /** An element that no expansion has reached, so nothing has stamped it yet. */
  function freshElement(): Element {
    const aside = document.createElement('aside');
    aside.setAttribute('data-osw-src', '/index.hbs:900');
    aside.textContent = 'unstamped-aside';
    document.querySelector('main')!.appendChild(aside);
    return aside;
  }

  function clickPayload(el: Element): FocusContextPayload {
    posted.length = 0;
    send({ type: 'selector-toggle', active: true });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return only('selector-selection').payload as FocusContextPayload;
  }

  it('stamps an element the tree never touched, and reports the id it stamped', () => {
    const fresh = freshElement();
    expect(fresh.getAttribute('data-osw-node'), 'the fixture was already stamped').toBeNull();

    const payload = clickPayload(fresh);

    expect(payload.nodeId).toBeTruthy();
    expect(fresh.getAttribute('data-osw-node')).toBe(payload.nodeId);
    // Decimal digits are the entire alphabet `__oswResolveNode` accepts; anything else is rejected
    // by its guard and the id would be dead on arrival.
    expect(payload.nodeId).toMatch(/^[0-9]+$/);
    fresh.remove();
  });

  it('hands back an id that resolves to the same element', () => {
    const fresh = freshElement();
    const clicked = clickPayload(fresh);

    posted.length = 0;
    send({ type: 'tree-select', nodeId: clicked.nodeId });

    // Round-tripped through the frame's own resolver rather than through querySelector here: that
    // is what proves the guard accepts the id and that it addresses this element and no other. The
    // fixture's text is unique in the document, so an equal payload cannot be a different element.
    expect(posted.filter(m => m.type === 'tree-stale')).toHaveLength(0);
    expect(only('selector-selection').payload).toEqual(clicked);
    expect(clicked.outerHTML).toContain('unstamped-aside');
    fresh.remove();
  });

  it('keeps the id the tree serializer already minted for an element', () => {
    const [main] = requestLevel(null);
    const articles = requestLevel(main.id);

    const payload = clickPayload(document.querySelectorAll('article')[1]);

    // The whole point of routing through `__oswNodeId`: a click on a row the panel is already
    // showing must not renumber it under the host, which is still holding the row's id.
    expect(payload.nodeId).toBe(articles[1].id);
  });

  it('draws from the tree serializer\'s counter, so two ids can never collide', () => {
    // An isolated instance, because this is an assertion about the numbers themselves: the shared
    // document's counter is already well past zero, so a click path with its own counter would mint
    // into a range the tree happens to have vacated and the collision would not show.
    const instance = isolatedInstance(MARKUP);

    // Click *first*, so the click path takes id 1 — the id a serializer starting from its own zero
    // would then hand to the first row it walks.
    instance.send({ type: 'selector-toggle', active: true });
    instance.doc.querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const clicked = instance.posted.find(m => m.type === 'selector-selection')!.payload as FocusContextPayload;
    expect(clicked.nodeId).toBe('1');

    instance.posted.length = 0;
    instance.send({ type: 'tree-request', nodeId: null });
    const rows = instance.posted.find(m => m.type === 'tree-level')!.nodes as TreeNode[];

    // The serializer has to carry on from where the click left off. A second counter renumbers into
    // the range the other already used, and two live elements end up answering to one id — every
    // node-keyed message then addresses whichever the document happens to hit first.
    expect(rows.map(r => r.id)).not.toContain(clicked.nodeId);
    const ids = Array.from(instance.doc.querySelectorAll('[data-osw-node]'), el => el.getAttribute('data-osw-node'));
    expect(new Set(ids).size, `duplicate node ids: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('does not reach the agent through attributes or outerHTML', () => {
    const [main] = requestLevel(null);
    const articles = requestLevel(main.id);
    // Expanded one level deeper so the descendant carries a stamp too: outerHTML is a whole
    // subtree, and stripping only the outermost tag would pass a test that checked one element.
    requestLevel(articles[1].id);

    const payload = clickPayload(document.querySelectorAll('article')[1]);

    // The element and its child genuinely carry the attribute at this point, so each assertion
    // below fails the moment the filtering stops.
    expect(document.querySelectorAll('article')[1].getAttribute('data-osw-node')).toBe(articles[1].id);
    expect(document.querySelectorAll('article')[1].querySelector('h2')!.getAttribute('data-osw-node')).toBeTruthy();
    expect(Object.keys(payload.attributes)).toEqual(['class', 'data-tone']);
    expect(payload.outerHTML).toBe('<article class="post" data-tone="warm"><h2>two</h2></article>');
    // The id itself is a named field the host reads, not markup smuggled through the snippet.
    expect(JSON.stringify(payload.attributes)).not.toContain('data-osw-node');
    expect(payload.outerHTML).not.toContain('data-osw-node');
  });

  it('does not reach the agent through the placement path\'s htmlContext', () => {
    // A click now leaves the stamp on any element the user picked, which widens the set of
    // documents the placement script can be asked to serialize. `buildHtmlContext` is lifted out of
    // the emitted placement script and run directly: driving a real drop needs `elementFromPoint`
    // and non-zero rects, neither of which jsdom has, and the emitted text is the only thing that
    // ever runs in the frame.
    const doc = document.implementation.createHTMLDocument('placement');
    doc.body.innerHTML =
      '<section data-osw-src="/index.hbs:0" data-osw-node="41">' +
        '<p data-osw-src="/index.hbs:8" data-osw-node="42">a</p>' +
      '</section>';

    const placement = jsOf(generatePlacementScript());
    const build = new Function('document', [
      functionText(placement, '__oswStripProv'),
      functionText(placement, '__oswStripNodeId'),
      functionText(placement, 'buildHtmlContext'),
      'return buildHtmlContext;',
    ].join('\n'))(doc) as (target: Element, position: string, blockName: string) => string;

    const html = build(doc.querySelector('p')!, 'after', 'Feature Grid');

    expect(html).toContain('<!-- INSERT Feature Grid HERE -->');
    expect(html).not.toContain('data-osw-node');
    expect(html).not.toContain('data-osw-src');
  });
});
