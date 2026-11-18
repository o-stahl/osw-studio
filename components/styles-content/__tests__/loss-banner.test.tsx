// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { StylesContent, type StylesContentHandle } from '..';
import type { FocusContextPayload } from '@/lib/preview/types';

/**
 * Where the "not applied" message goes — **one** of it, at the foot of the panel.
 *
 * The only test in this tab that mounts the component, and it mounts because that is the only way
 * to make the assertion at all: a loss reaches the panel through the `style-probe-result` handler
 * on its imperative ref, so `renderToStaticMarkup` — which runs no effect and takes no second
 * render — can never produce a panel that has one. Everything else in `styles-content/` is asserted
 * as a pure function precisely so that this stays the exception rather than the pattern.
 *
 * What it is guarding is a UX regression, not a logic one: the message used to render under every
 * control it applied to, so an element that lost two properties grew two paragraphs wedged between
 * the controls the user was trying to read. `lostOverrides` and `lossMessage` in `state.ts` own what
 * it *says*; this owns how many of it there are and where.
 */

const payload = (over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: 'html > body > main > p',
  tagName: 'P',
  nodeId: 'n1',
  attributes: { class: 'card' },
  outerHTML: '<p></p>',
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const ref = createRef<StylesContentHandle>();

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(withMessages(
      <StylesContent
        ref={ref}
        selection={payload()}
        sendToFrame={vi.fn()}
        applyStyle={vi.fn()}
        tokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
      />,
    ));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Hand the panel a probe answer, as `multipage-preview` would. */
function probed(lost: string[], winner?: string): void {
  act(() => {
    ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'n1', lost, winner });
  });
}

const ts = createTranslator({ locale: 'en', messages: en, namespace: 'styles' });

/** The words of a loss line between the property and what beat it, whatever those two are. */
const LOSES = ts('lossItem', { property: '\u0001', winner: '\u0002' }).split('\u0001')[1].split('\u0002')[0].trim();

/** Every element carrying the message, however many there are. */
function banners(): Element[] {
  return Array.from(container.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && (el.textContent || '').includes(LOSES));
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The message's title at any count: its singular form, or its plural with any number. */
const NOT_APPLIED = new RegExp(
  `^(${escaped(ts('changesNotApplied', { count: 1 }))}|${escaped(ts('changesNotApplied', { count: 7 })).replace('7', '\\d+')})$`,
);
const titles = () => Array.from(container.querySelectorAll('*'))
  .filter(el => el.children.length === 0 && NOT_APPLIED.test(el.textContent || ''));

describe('the loss message', () => {
  it('is absent until something is actually lost', () => {
    expect(titles()).toHaveLength(0);
    expect(banners()).toHaveLength(0);
  });

  it('is rendered exactly once for a loss on one property', () => {
    probed(['padding-block-start', 'padding-block-end'], '/styles.css');

    expect(banners()).toHaveLength(1);
    expect(container.textContent).toContain(ts('lossItem', { property: 'padding-block', winner: '/styles.css' }));
  });

  it('is STILL rendered exactly once when several properties are lost', () => {
    // Per-control rendering passes the test above and fails this one, which is why one loss is not
    // enough to assert on.
    probed(['padding-block-start', 'border-top-left-radius', 'color'], '/styles.css');

    expect(banners()).toHaveLength(1);
    const text = container.textContent || '';
    for (const property of ['padding-block', 'border-radius', 'color']) {
      expect(text).toContain(ts('lossItem', { property, winner: '/styles.css' }));
    }
    expect(text).toContain(ts('changesNotApplied', { count: 3 }));
  });

  it('sits at the foot of the panel, below every control', () => {
    probed(['padding-block-start'], '/styles.css');

    const panel = container.firstElementChild!;
    const foot = panel.lastElementChild!;
    expect(foot.textContent).toContain(LOSES);
    // Not merely last in the DOM — outside the scrolling region, so it does not have to be
    // scrolled to. The controls live in the element before it.
    expect(panel.children.length).toBeGreaterThan(1);
    expect(panel.children[panel.children.length - 2].textContent).toContain(en.styleProps.labels['border-radius']);
  });

  it('marks the control it concerns without saying anything a second time', () => {
    probed(['padding-block-start'], '/styles.css');

    const marked = container.querySelectorAll('[data-osw-loss]');
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute('data-osw-row')).toBe('padding-block');
    // The marker is a marker. Two copies of the sentence is the thing being avoided.
    expect(banners()).toHaveLength(1);
  });

  it('offers one agent request covering every loss', () => {
    probed(['padding-block-start', 'color'], '/styles.css');

    const buttons = Array.from(container.querySelectorAll('button'))
      .filter(el => el.textContent === ts('askAgent'));
    expect(buttons).toHaveLength(1);
  });
});

describe('a change from an earlier session that loses', () => {
  const marked = payload({ attributes: { class: 'card', 'data-osw-id': 'm1' } });
  const sendToFrame = vi.fn();
  const applyStyle = vi.fn();

  /** The panel on an element whose block in the file sets a colour, with the file read. */
  async function open(): Promise<void> {
    sendToFrame.mockReset();
    applyStyle.mockReset().mockResolvedValue({ ok: true, markerId: 'm1', filesWritten: ['/overrides.css'], css: '/* written */' });
    await act(async () => {
      root.render(withMessages(
        <StylesContent
          ref={ref}
          selection={marked}
          sendToFrame={sendToFrame}
          applyStyle={applyStyle}
          onReadOverrides={async () => ({ byScope: new Map([['all' as const, { color: 'red' }]]), text: '', widths: [] })}
          tokens={[]}
          onOpenFile={vi.fn()}
          onAskAgent={vi.fn()}
          onRefreshPreview={vi.fn()}
        />,
      ));
    });
  }

  const makeApply = () => container.querySelector<HTMLButtonElement>('[data-osw-make-apply]');

  it('is asked about by the name the file declares, and shown with Make it apply', async () => {
    await open();
    expect(sendToFrame).toHaveBeenCalledWith({ type: 'style-probe', nodeId: 'n1', markerId: 'm1', properties: ['color'], tag: 'earlier' });
    expect(makeApply()).toBeNull();

    act(() => {
      ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'n1', lost: ['color'], winner: '/styles.css', written: ['color'], tag: 'earlier' });
    });
    expect(container.textContent).toContain(ts('lossItem', { property: 'color', winner: '/styles.css' }));
    expect(makeApply()!.textContent).toBe(ts('makeApply'));
    // Shown, not acted on: nothing is written until the button is pressed.
    expect(applyStyle).not.toHaveBeenCalled();
  });

  it('writes the mark for that declaration when pressed, and no value', async () => {
    await open();
    act(() => {
      ref.current!.handleStyleProbeResult({ type: 'style-probe-result', nodeId: 'n1', lost: ['color'], winner: '/styles.css', written: ['color'], tag: 'earlier' });
    });
    await act(async () => { makeApply()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(applyStyle).toHaveBeenCalledTimes(1);
    const [, changes, opts] = applyStyle.mock.calls[0];
    expect(changes).toEqual([]);
    expect(opts).toMatchObject({ scope: 'all', markerId: 'm1', strengthen: ['color'] });
    expect(banners()).toHaveLength(0);
  });
});

// When a loss is *cleared* is `reduceStyles`' business and is asserted in `state.test.ts`: it turns
// on `state.probing`, which the reducer sets when it emits the probe, so a handler call from here
// arrives with nothing outstanding to re-decide and would be asserting the harness.
