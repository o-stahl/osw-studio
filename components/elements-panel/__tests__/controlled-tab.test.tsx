// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ElementsPanel, type ElementsTab } from '..';

/**
 * The tab is the workspace's, not the panel's.
 *
 * `if (showElements) panelMap['elements']` in `workspace/index.tsx` means opening the Inspector is
 * what *mounts* this panel, so anything that wants to open it on a particular tab — the preview
 * toolbar's `Style` action — has to set the tab before the panel exists. A panel that kept the tab
 * in its own `useState` could not be steered at all, and an imperative `focusStyles()` on the handle
 * would be a silent no-op against a ref that is still null.
 *
 * `tabs.test.tsx` covers which pane is showing for a given `activeTab`. What needs a DOM, and is
 * therefore here, is the other direction: pressing a trigger must *report* rather than act. A panel
 * that seeded local state from the prop passes every static assertion in the sibling file and still
 * switches tabs behind the workspace's back — at which point the workspace's idea of the tab and the
 * user's diverge, and the next `Style` press appears to do nothing because the workspace already
 * believes it is on Styles.
 */

let container: HTMLDivElement;
let root: Root;
const onTabChange = vi.fn();

function mount(activeTab: ElementsTab) {
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
        activeTab={activeTab}
        onTabChange={onTabChange}
      />,
    ));
  });
}

/** The trigger with this label. Radix activates on mousedown, not click. */
function press(label: string) {
  const trigger = Array.from(container.querySelectorAll('[role="tab"]'))
    .find(el => el.textContent === label);
  if (!trigger) throw new Error(`no tab labelled ${label}`);
  act(() => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}

/** Which pane the user can see — the one without `hidden`, named by its trigger. */
function shownPane(): string | undefined {
  const visible = Array.from(container.querySelectorAll('[role="tabpanel"]'))
    .filter(el => !el.hasAttribute('hidden'));
  expect(visible).toHaveLength(1);
  return visible[0].getAttribute('aria-labelledby')?.split('-trigger-').pop();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onTabChange.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the Inspector tab, controlled', () => {
  it('reports a press upward instead of switching itself', () => {
    mount('tree');
    press('Styles');

    expect(onTabChange).toHaveBeenCalledWith('styles');
    // The parent did not act on it, so nothing moved. This is the assertion that fails against a
    // panel that still owns the tab.
    expect(shownPane()).toBe('tree');
  });

  it('switches when the parent hands back the new tab', () => {
    mount('tree');
    expect(shownPane()).toBe('tree');

    mount('styles');
    expect(shownPane()).toBe('styles');
  });

  it('reports the tab pressed, not merely that something was pressed', () => {
    mount('styles');
    press('Elements');
    expect(onTabChange).toHaveBeenCalledWith('tree');
  });
});
