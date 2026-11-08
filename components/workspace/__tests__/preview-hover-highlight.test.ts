import { describe, it, expect } from 'vitest';
import { previewHoverHighlight } from '../index';

/**
 * Which highlight the Styles tab's `Select element` button asks for while the pointer is on it.
 *
 * Exported and asserted as a pure function for the same reason `focusReloadAction` and
 * `applyToolbarAction` are: nothing in the repo renders `Workspace`, so a rule left inline in the
 * component is a rule nothing can check.
 *
 * The rule that matters is that "highlight the preview panel" is **two different hints**. With the
 * preview in front, the press arms a tool inside it and moves nothing, so the button outlines the
 * preview itself (an `outline` hint). Otherwise the press puts the preview on screen, and where it
 * would open, or which tab comes forward, is the `reveal` hint `handleSidebarHover` draws. The rail's
 * own hint would not do here: for a panel in front, it shows the press closing it.
 *
 * Getting that backwards is silent: hovering draws the wrong thing or nothing, which looks exactly
 * like a hover handler that was never wired.
 */

describe('previewHoverHighlight', () => {
  it('asks for the panel itself when the preview is already in front', () => {
    // The case the user is usually in: the Styles empty state shows with the preview open.
    expect(previewHoverHighlight({ hovering: true, previewOpen: true })).toBe('panel');
  });

  it('routes through the sidebar hint when the preview is not in front', () => {
    // Then the press opens it or brings its tab forward, and drawing where it lands is what the
    // `reveal` hint from `handleSidebarHover` does.
    expect(previewHoverHighlight({ hovering: true, previewOpen: false })).toBe('route');
  });

  it('clears on leave whether the preview is open or not', () => {
    // The leave is the half that gets forgotten, and forgetting it strands a dashed outline on the
    // panel for as long as the tab stays on the empty state.
    expect(previewHoverHighlight({ hovering: false, previewOpen: true })).toBe('clear');
    expect(previewHoverHighlight({ hovering: false, previewOpen: false })).toBe('clear');
  });
});
