// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ElementsPanel } from '..';

/**
 * The hover half of the `Select element` pass-through, through the panel.
 *
 * `tabs.test.tsx` proves `onSelectElement` reaches `StylesContent`, because a missing handler is
 * visible in the static markup — no handler, no button. `onSelectElementHover` is not: the button
 * renders identically whether the callback was forwarded or dropped on the floor, and the only symptom
 * of dropping it is that hovering draws nothing, which is indistinguishable from a workspace that
 * never wired the highlight. So this one needs a DOM and an event.
 *
 * What the highlight *is* belongs to `previewHoverHighlight`
 * (`components/workspace/__tests__/preview-hover-highlight.test.ts`); what the button does with the
 * pointer belongs to `components/styles-content/__tests__/select-element.test.tsx`. This owns only the
 * wire between them.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(over: { onSelectElementHover?: (hovering: boolean) => void; focusToolArmed?: boolean } = {}) {
  act(() => {
    root.render(withMessages(
      <ElementsPanel
        projectId="p1"
        runtime="handlebars"
        previewOpen
        onOpenPreview={vi.fn()}
        sendToFrame={vi.fn()}
        selection={null}
        applyStyle={vi.fn()}
        colorTokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
        onSelectElement={vi.fn()}
        {...over}
        activeTab="styles"
        onTabChange={vi.fn()}
      />,
    ));
  });
  const button = container.querySelector('[data-osw-select-element]');
  if (!button) throw new Error('no Select element button');
  return button;
}

describe('the Select element hover, through the panel', () => {
  it('reaches the host from the Styles tab\'s empty state', () => {
    const onSelectElementHover = vi.fn();
    const button = render({ onSelectElementHover });

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(onSelectElementHover).toHaveBeenLastCalledWith(true);

    act(() => {
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(onSelectElementHover).toHaveBeenLastCalledWith(false);
  });

  it('forwards the armed state, so the button can offer the cancel', () => {
    // Same class of failure as the hover: dropped on the floor, the button renders — it just never
    // leaves its idle face, and a picker armed from the panel looks like a press that did nothing.
    expect(render({ focusToolArmed: true }).textContent).toContain('Cancel selection');
    expect(render({ focusToolArmed: false }).textContent).toContain('Select element');
  });
});
