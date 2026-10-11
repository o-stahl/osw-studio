// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript } from '../multipage-preview';
import { STYLE_PREVIEW_JS, STYLE_LOCATOR_JS, STYLE_PROBE_JS } from '@/lib/preview/style-preview';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * The frame's `style-probe` handler, driven the way the host drives it.
 *
 * `lib/preview/__tests__/style-probe-dom.test.ts` covers the probe itself; this covers that the
 * message reaches it, that the reply always arrives, and that `winner` is present only when there is
 * one to name.
 *
 * The toggle-and-compare matrix is **not** here. jsdom detects exactly one loss — an inline `style`
 * attribute — so `!important` and `#id` losses would report as successes; they are asserted in
 * `e2e/style-probe.test.ts`, in Chrome.
 *
 * One script instance for the whole file, as in the other wiring specs: each `new Function(...)` run
 * installs another `message` listener on the same jsdom window and would double every reply.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

interface PostedMessage {
  type?: string;
  nodeId?: string;
  lost?: string[];
  winner?: string;
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

/** Select the card by clicking it, which is how the host comes by a nodeId for it. */
function selectCard(): string {
  posted.length = 0;
  send({ type: 'selector-toggle', active: true });
  document.querySelector('.card')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return (only('selector-selection').payload as FocusContextPayload).nodeId;
}

function probe(nodeId: string, markerId: string, properties: unknown): PostedMessage {
  posted.length = 0;
  send({ type: 'style-probe', nodeId, markerId, properties });
  return only('style-probe-result');
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { posted.push(message as PostedMessage); } },
  });
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  document.head.innerHTML = '<style>.card { color: rgb(50, 50, 50); }</style>';
  document.body.innerHTML = '<main><div class="card" data-osw-id="m1">c</div></main>';
  posted.length = 0;
});

describe('the style-probe message', () => {
  it('reports the property an inline style took from the override, and names it', () => {
    const nodeId = selectCard();
    send({ type: 'style-preview', markerId: 'm1', css: 'color: rgb(1, 2, 3);' });
    (document.querySelector('.card') as HTMLElement).style.color = 'rgb(3, 3, 3)';

    const reply = probe(nodeId, 'm1', ['color']);

    expect(reply.nodeId).toBe(nodeId);
    expect(reply.lost).toEqual(['color']);
    expect(reply.winner).toBe('inline style');
  });

  it('omits winner entirely when nothing was lost', () => {
    const nodeId = selectCard();
    send({ type: 'style-preview', markerId: 'm1', css: 'color: rgb(1, 2, 3);' });

    const reply = probe(nodeId, 'm1', ['color']);

    expect(reply.lost).toEqual([]);
    // Absent, not null: 4b renders this field, and an always-present null makes every caller branch
    // on a value that is null in the ordinary case.
    expect(reply).not.toHaveProperty('winner');
  });

  it('answers a stale nodeId with an empty list rather than silence', () => {
    expect(document.querySelector('[data-osw-node="999"]')).toBeNull();

    const reply = probe('999', 'm1', ['color']);

    expect(reply.nodeId).toBe('999');
    expect(reply.lost).toEqual([]);
    expect(reply).not.toHaveProperty('winner');
  });

  it('answers when no sheet carries the marker at all', () => {
    const nodeId = selectCard();

    const reply = probe(nodeId, 'no-such-marker', ['color']);

    expect(reply.lost).toEqual([]);
    expect(reply).not.toHaveProperty('winner');
  });

  it('leaves the rest of the handler standing when the payload is junk', () => {
    // `data` crosses postMessage, so any field can be anything. The reply is the evidence, not the
    // absence of a throw: dispatchEvent swallows a listener's exception, and the handler answers
    // every probe, so one that threw is one that never posted. Each field is junk on its own, with
    // the others valid — a junk nodeId resolves to no element and returns before the properties or
    // the marker are ever read, so it cannot stand in for them.
    const nodeId = selectCard();
    send({ type: 'style-preview', markerId: 'm1', css: 'color: rgb(1, 2, 3);' });

    for (const properties of [undefined, null, 7, {}, 'color']) {
      const reply = probe(nodeId, 'm1', properties);
      expect(reply.lost, String(properties)).toEqual([]);
      expect(reply).not.toHaveProperty('winner');
    }
    for (const markerId of [undefined, null, 5, {}]) {
      expect(probe(nodeId, markerId as unknown as string, ['color']).lost, String(markerId)).toEqual([]);
    }
    for (const junk of [undefined, null, 5, {}]) {
      expect(probe(junk as unknown as string, 'm1', ['color']).lost, String(junk)).toEqual([]);
    }

    // And a well-formed probe after all that still measures.
    (document.querySelector('.card') as HTMLElement).style.color = 'rgb(3, 3, 3)';
    expect(probe(nodeId, 'm1', ['color']).lost).toEqual(['color']);
  });
});

describe('the frame script emits the style constants once, and in the order they depend on', () => {
  const emitted = generateNavigationScript('/index.html');
  const occurrences = (needle: string) => {
    let count = 0;
    for (let i = emitted.indexOf(needle); i !== -1; i = emitted.indexOf(needle, i + 1)) count++;
    return count;
  };

  it('interpolates each constant exactly once', () => {
    expect(occurrences(STYLE_LOCATOR_JS)).toBe(1);
    expect(occurrences(STYLE_PROBE_JS)).toBe(1);
    expect(occurrences('function __oswLocateOverrideRule(')).toBe(1);
    expect(occurrences('function __oswProbeStyleLoss(')).toBe(1);
  });

  it('puts the injector before the locator, which borrows from it', () => {
    // `__oswSelectorFor` and `__oswTransientStyleElement` are declared in STYLE_PREVIEW_JS and used
    // by the locator. Function declarations hoist, so the wrong order would not throw — it would
    // leave `__oswSelectorTemplate` undefined at call time and every lookup silently answering null.
    // Nothing in the constants themselves can enforce this, which is why it is asserted here.
    expect(emitted.indexOf(STYLE_PREVIEW_JS)).toBeLessThan(emitted.indexOf(STYLE_LOCATOR_JS));
    expect(emitted.indexOf(STYLE_LOCATOR_JS)).toBeLessThan(emitted.indexOf(STYLE_PROBE_JS));
  });
});
