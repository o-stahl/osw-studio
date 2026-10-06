// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StylesContent, type StylesContentProps } from '..';

/**
 * The `Select element` button on the Styles tab's empty state.
 *
 * Mounted rather than asserted through a pure function because the whole point of the button is what
 * it *reports*: it neither arms the picker nor opens a panel itself — the host does both, because
 * arming means putting the preview where the user can use it and only the workspace's mount knows
 * which surface it is on (`SelectionSurface`). What can go wrong here is therefore wiring, and wiring
 * needs events.
 *
 * The hover half is not decoration. It is the only feedback that says *which* panel the press is
 * about to send you to, and a leave that never fires strands a dashed outline on the preview for as
 * long as the tab sits on the empty state. Where that outline goes is `previewHoverHighlight` in
 * `components/workspace/__tests__/preview-hover-highlight.test.ts`; this owns that the panel reports
 * the enter *and* the leave at all.
 */

let container: HTMLDivElement;
let root: Root;

const base: StylesContentProps = {
  selection: null,
  sendToFrame: vi.fn(),
  applyStyle: vi.fn(),
  tokens: [],
  onOpenFile: vi.fn(),
  onAskAgent: vi.fn(),
  onRefreshPreview: vi.fn(),
};

function mount(over: Partial<StylesContentProps> = {}) {
  act(() => {
    root.render(withMessages(<StylesContent {...base} {...over} />));
  });
}

/**
 * The empty state's picker button, or null when the panel offers none.
 *
 * Found by its marker attribute rather than by its text, because its text is one of the things
 * under test: armed, it reads `Cancel selection`.
 */
function button(): HTMLButtonElement | null {
  return container.querySelector('[data-osw-select-element]');
}

function fire(type: 'click' | 'mouseover' | 'mouseout') {
  const el = button();
  if (!el) throw new Error('no Select element button');
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

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

describe('the Select element button', () => {
  it('is offered on the empty state when the host can arm the picker', () => {
    mount({ onSelectElement: vi.fn() });
    expect(button()).not.toBeNull();
    // An addition, not a replacement — both lines of the empty state are still there.
    expect(container.textContent).toContain('No element selected');
    expect(container.textContent).toContain('Pick one in the tree');
  });

  it('is absent for a host that passes no handler', () => {
    // Every container but the workspace. A disabled button that cannot be made to work is worse
    // than no button, and the same bargain the CONTENT section's props strike.
    mount();
    expect(button()).toBeNull();
    expect(container.textContent).toContain('No element selected');
  });

  it('is absent once something is selected — it is the empty state\'s button', () => {
    mount({
      onSelectElement: vi.fn(),
      selection: {
        domPath: 'html > body > p',
        tagName: 'P',
        nodeId: 'n1',
        attributes: {},
        outerHTML: '<p></p>',
      },
    });
    expect(button()).toBeNull();
  });

  it('reports the press to the host instead of acting on it', () => {
    const onSelectElement = vi.fn();
    mount({ onSelectElement });
    fire('click');
    expect(onSelectElement).toHaveBeenCalledTimes(1);
  });

  it('reports the pointer arriving and leaving, both', () => {
    const onSelectElementHover = vi.fn();
    mount({ onSelectElement: vi.fn(), onSelectElementHover });

    fire('mouseover');
    expect(onSelectElementHover).toHaveBeenLastCalledWith(true);

    fire('mouseout');
    expect(onSelectElementHover).toHaveBeenLastCalledWith(false);
  });

  it('drops the hover highlight as it presses, before the host is told to arm', () => {
    // The press moves the user's attention into the preview. A dashed outline left on the panel reads
    // as a gesture that did not finish — and no `mouseout` is guaranteed, since arming can move focus
    // and the pointer may never leave the button's box.
    const calls: string[] = [];
    mount({
      onSelectElement: () => calls.push('arm'),
      onSelectElementHover: hovering => calls.push(hovering ? 'enter' : 'leave'),
    });

    fire('mouseover');
    fire('click');

    expect(calls).toEqual(['enter', 'leave', 'arm']);
  });

  it('works for a host that offers the press but no hover feedback', () => {
    // Optional props, independently: a press must not throw looking for the hover callback.
    const onSelectElement = vi.fn();
    mount({ onSelectElement });
    fire('click');
    expect(onSelectElement).toHaveBeenCalledTimes(1);
  });

  /**
   * The armed state, which is the host's — see `focusToolArmed`. What the button owes the user is
   * that a press it cannot undo *looks* undoable: the picker is armed, the next press stands it
   * down (`focusToolPress`), and a button that went on reading `Select element` in an unchanged
   * outline would be describing the press it already answered rather than the one available now.
   */
  describe('while the picker is armed', () => {
    it('says the press is a cancel, in the label and in the title', () => {
      mount({ onSelectElement: vi.fn(), focusToolArmed: true });
      expect(button()!.textContent).toContain('Cancel selection');
      expect(button()!.textContent).not.toContain('Select element');
      // Word for word the header crosshair's title for the same state — it is the same tool.
      expect(button()!.getAttribute('title')).toBe('Cancel element selection');
    });

    it('reports the state where the app puts it, so it is not colour alone', () => {
      mount({ onSelectElement: vi.fn(), focusToolArmed: true });
      expect(button()!.getAttribute('aria-pressed')).toBe('true');
    });

    it('looks different from idle', () => {
      // The app's fill for a control that is on (`secondary`), not the header's inline
      // `var(--button-preview-active)`. Asserted as "not the idle class list" rather than by naming
      // the utilities, so a restyle is free and losing the state entirely is not.
      mount({ onSelectElement: vi.fn(), focusToolArmed: true });
      const armed = button()!.className;
      mount({ onSelectElement: vi.fn(), focusToolArmed: false });
      expect(button()!.className).not.toBe(armed);
    });

    it('still only reports the press — cancelling is the host\'s to do', () => {
      const onSelectElement = vi.fn();
      mount({ onSelectElement, focusToolArmed: true });
      fire('click');
      expect(onSelectElement).toHaveBeenCalledTimes(1);
    });

    it('reads as idle for a host that says nothing about arming', () => {
      // Optional, so the fixtures that render this panel with a fixed prop list keep their markup.
      mount({ onSelectElement: vi.fn() });
      expect(button()!.textContent).toContain('Select element');
      expect(button()!.getAttribute('aria-pressed')).toBe('false');
      expect(button()!.getAttribute('title')).toBe('Select element');
    });
  });

  /**
   * The hover has to be retracted however the button leaves, not only when the pointer walks off it.
   *
   * The highlight it raises lives in the workspace — a dashed outline on the preview panel and a
   * tint on the header's crosshair — so nothing about this component's own teardown clears it. A
   * `mouseleave` that never comes leaves both painted with no pointer to explain them.
   */
  describe('retracting the hover', () => {
    it('retracts when the panel unmounts under the pointer', () => {
      const onSelectElementHover = vi.fn();
      mount({ onSelectElement: vi.fn(), onSelectElementHover });
      fire('mouseover');
      expect(onSelectElementHover).toHaveBeenLastCalledWith(true);

      act(() => root.unmount());
      expect(onSelectElementHover).toHaveBeenLastCalledWith(false);
      // The afterEach unmount would throw on an already-unmounted root; give it a live one.
      root = createRoot(container);
    });

    it('retracts when a selection lands and takes the button away', () => {
      // The ordinary end of this gesture: the user hovers the button, the picker resolves a click in
      // the preview, and the empty state — button and all — is replaced without the pointer moving.
      const onSelectElementHover = vi.fn();
      mount({ onSelectElement: vi.fn(), onSelectElementHover });
      fire('mouseover');

      mount({
        onSelectElement: vi.fn(),
        onSelectElementHover,
        selection: {
          domPath: 'html > body > p',
          tagName: 'P',
          nodeId: 'n1',
          attributes: {},
          outerHTML: '<p></p>',
        },
      });
      expect(button()).toBeNull();
      expect(onSelectElementHover).toHaveBeenLastCalledWith(false);
    });
  });
});
