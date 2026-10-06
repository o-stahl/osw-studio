// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

/** Every element carrying the message, however many there are. */
function banners(): Element[] {
  return Array.from(container.querySelectorAll('*'))
    .filter(el => el.children.length === 0 && (el.textContent || '').includes('loses to'));
}

describe('the loss message', () => {
  it('is absent until something is actually lost', () => {
    expect(container.textContent).not.toContain('not applied');
    expect(banners()).toHaveLength(0);
  });

  it('is rendered exactly once for a loss on one property', () => {
    probed(['padding-block-start', 'padding-block-end'], '/styles.css');

    expect(banners()).toHaveLength(1);
    expect(container.textContent).toContain('padding-block loses to /styles.css.');
  });

  it('is STILL rendered exactly once when several properties are lost', () => {
    // The regression this file exists for. Per-control rendering passes the test above and fails
    // this one, which is why one loss is not enough to assert on.
    probed(['padding-block-start', 'border-top-left-radius', 'color'], '/styles.css');

    expect(banners()).toHaveLength(1);
    const text = container.textContent || '';
    expect(text).toContain('padding-block loses to');
    expect(text).toContain('border-radius loses to');
    expect(text).toContain('color loses to');
    expect(text).toContain('3 changes are not applied');
  });

  it('sits at the foot of the panel, below every control', () => {
    probed(['padding-block-start'], '/styles.css');

    const panel = container.firstElementChild!;
    const foot = panel.lastElementChild!;
    expect(foot.textContent).toContain('loses to');
    // Not merely last in the DOM — outside the scrolling region, so it does not have to be
    // scrolled to. The controls live in the element before it.
    expect(panel.children.length).toBeGreaterThan(1);
    expect(panel.children[panel.children.length - 2].textContent).toContain('Corner radius');
  });

  it('marks the control it concerns without saying anything a second time', () => {
    probed(['padding-block-start'], '/styles.css');

    const marked = container.querySelectorAll('[title*="not in force"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('Padding, vertical');
    // The marker is a marker. Two copies of the sentence is the thing being avoided.
    expect(banners()).toHaveLength(1);
  });

  it('offers one agent request covering every loss', () => {
    probed(['padding-block-start', 'color'], '/styles.css');

    const buttons = Array.from(container.querySelectorAll('button'))
      .filter(el => (el.textContent || '').includes('Ask the agent'));
    expect(buttons).toHaveLength(1);
  });
});

// When a loss is *cleared* is `reduceStyles`' business and is asserted in `state.test.ts`: it turns
// on `state.probing`, which the reducer sets when it emits the probe, so a handler call from here
// arrives with nothing outstanding to re-decide and would be asserting the harness.
