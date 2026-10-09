// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { STYLE_QUERY_JS } from '@/lib/preview/style-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The frame's `style-query` handler, run for real against a live document.
 *
 * `lib/preview/__tests__/style-preview.test.ts` covers the expander in isolation; this covers the
 * wiring the host actually talks to — that the id is resolved through the same `__oswResolveNode`
 * every other node-keyed message uses, that `getComputedStyle` is reached, and that a reply comes
 * back in every case.
 *
 * The stylesheet below is what makes the reply a fact rather than a shape: jsdom does cascade real
 * rules, so a handler that returned the *inline* style or an empty map would fail here.
 *
 * One script instance for the whole file, installed in `beforeAll`: each `new Function(...)` run
 * installs another `message` listener on the same jsdom window, so a second instance would double
 * every reply and invalidate the "posted exactly once" assertions.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  nodeId?: string;
  values?: Record<string, string>;
  rootFontSize?: string;
  payload?: FocusContextPayload;
}

const posted: PostedMessage[] = [];

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

function only(type: string): PostedMessage {
  const matches = posted.filter(m => m.type === type);
  expect(matches, `expected exactly one ${type}, got ${posted.map(m => m.type).join(', ') || 'nothing'}`)
    .toHaveLength(1);
  return matches[0];
}

/** Select the one card by clicking it, which is how the host comes by a nodeId for it. */
function selectCard(): string {
  posted.length = 0;
  send({ type: 'selector-toggle', active: true });
  document.querySelector('.card')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return (only('selector-selection').payload as FocusContextPayload).nodeId;
}

function query(nodeId: string, properties: unknown): PostedMessage {
  posted.length = 0;
  send({ type: 'style-query', nodeId, properties });
  return only('style-computed');
}

beforeAll(() => {
  document.head.innerHTML =
    '<style>' +
      // A root that is not the browser default, so the reply's root font size is a measurement
      // rather than a coincidence: 16 is what a hardcoded answer would also produce.
      'html { font-size: 10px; }' +
      '.card { padding: 10px 12px; color: rgb(20, 30, 40); border-radius: 4px; display: flex; }' +
    '</style>';
  document.body.innerHTML = '<main data-osw-src="/index.hbs:0"><div class="card" data-osw-src="/index.hbs:8">c</div></main>';

  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
  });

  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  posted.length = 0;
});

describe('style-query', () => {
  it('ignores a query that did not come from the host', () => {
    const nodeId = selectCard();
    posted.length = 0;
    window.dispatchEvent(Object.assign(new Event('message'), {
      data: { type: 'style-query', nodeId, properties: ['color'] },
      source: window,
    }));
    expect(posted).toEqual([]);
  });

  it('returns the rendered values for the properties asked about', () => {
    const nodeId = selectCard();

    const reply = query(nodeId, ['color', 'display']);

    expect(reply.nodeId).toBe(nodeId);
    // Real cascaded values from the stylesheet above, not the element's (empty) inline style.
    expect(reply.values).toEqual({ color: 'rgb(20, 30, 40)', display: 'flex' });
  });

  it('reports what one rem is worth in this document, on the same reply', () => {
    // The panel converts every rem it shows or writes through this. There is no other message that
    // could carry it — style-query is per node and the host holds no id for <html> — and without
    // it the panel has to assume 16, which this document makes wrong by 60%.
    const nodeId = selectCard();

    expect(query(nodeId, ['color']).rootFontSize).toBe('10px');
  });

  it('reports it even for a node that no longer resolves', () => {
    // It is a fact about the document, not about the element, and the panel's unit selector should
    // not go dead because the selection went stale.
    expect(query('999', ['color']).rootFontSize).toBe('10px');
  });

  it('answers a stale nodeId with an empty map rather than silence', () => {
    // 999 was never minted in this document. The host is waiting on this reply and cannot tell a
    // dead id from a frame that has not got round to answering, so the reply has to arrive.
    expect(document.querySelector('[data-osw-node="999"]')).toBeNull();

    const reply = query('999', ['color']);

    expect(reply.nodeId).toBe('999');
    expect(reply.values).toEqual({});
  });

  it('answers an id the resolver rejects outright, too', () => {
    // Non-decimal ids never reach querySelector — `__oswResolveNode` returns null before that — and
    // that branch has to end in a reply as well.
    const reply = query('" ], [data-osw-src="/index.hbs:8', ['color']);

    expect(reply.values).toEqual({});
  });

  it('expands padding into the four sides a per-side control needs', () => {
    const nodeId = selectCard();

    const reply = query(nodeId, ['padding']);

    // Keyed on the longhands, and `padding` itself is gone: a control editing one side needs that
    // side's own number, and the shorthand resolves to "10px 12px" — one string, not four numbers.
    // (It does resolve: `getComputedStyle(el).padding` is non-empty in jsdom and in Chrome alike.
    // The expansion is about the shape the controls need, not about a shorthand coming back empty.)
    expect(Object.keys(reply.values!)).toEqual([
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    ]);
    expect(reply.values).toEqual({
      'padding-top': '10px',
      'padding-right': '12px',
      'padding-bottom': '10px',
      'padding-left': '12px',
    });
  });

  it('expands border-radius into its four corners', () => {
    const nodeId = selectCard();

    const reply = query(nodeId, ['border-radius']);

    // The second shorthand, and the one that catches a `setProperty`-based expander: measured, a
    // scratch element expands `padding` in jsdom but leaves `border-radius` as itself, so the
    // padding test alone passes against an implementation that returns the shorthand here.
    expect(Object.keys(reply.values!)).toEqual([
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-right-radius', 'border-bottom-left-radius',
    ]);
    // jsdom resolves the shorthand but not these corners, so the values are empty here while the
    // keys are not. Present-with-empty is the contract: the key set is the request's, so the host
    // can tell "no value" from "never asked".
    expect(Object.values(reply.values!).every(v => typeof v === 'string')).toBe(true);
    expect(reply.values).not.toHaveProperty('border-radius');
  });

  it('replies to a malformed properties list instead of throwing out of the handler', () => {
    const nodeId = selectCard();

    // `properties` crosses postMessage, so the frame is not the only writer. A throw here would
    // take every branch after it in the shared message handler down with it.
    expect(query(nodeId, undefined).values).toEqual({});
    expect(query(nodeId, 'color').values).toEqual({});
  });
});

describe('the computed reader is authored once', () => {
  it('is interpolated from the shared constant, not hand-written into the script', () => {
    const emitted = generateNavigationScript('/index.html');
    let count = 0;
    for (let i = emitted.indexOf(STYLE_QUERY_JS); i !== -1; i = emitted.indexOf(STYLE_QUERY_JS, i + 1)) count++;
    expect(count).toBe(1);
    // And nowhere a second time under its own name — a hand-written copy inside the template
    // literal is the trap the whole constant-plus-interpolation arrangement exists to avoid.
    let declarations = 0;
    const needle = 'function __oswReadComputed(';
    for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) declarations++;
    expect(declarations).toBe(1);
  });
});
