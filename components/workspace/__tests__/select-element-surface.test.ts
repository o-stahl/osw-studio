import { describe, it, expect } from 'vitest';
import { selectElementSurface } from '../index';

/**
 * Which surface the Inspector's `Select element` button addresses.
 *
 * Exported and asserted as a pure function for the same reason `focusToolPress` is: nothing in the
 * repo renders `Workspace`. Addressed to Live Preview, the press opens it and arms its picker, which
 * brings it in front of Canvas when the two share a cell; that is the case this rule keeps away
 * from a person looking at Canvas.
 */

const input = (over: Partial<Parameters<typeof selectElementSurface>[0]>) => ({
  canvas: true,
  previewOnScreen: false,
  canvasOnScreen: false,
  target: 'preview' as const,
  ...over,
});

describe('selectElementSurface', () => {
  it('addresses Canvas when Canvas is on screen and Live Preview is not', () => {
    // The default layout: Canvas in front of Live Preview in the centre cell, the Inspector still
    // reading the preview because nothing has been picked on Canvas yet.
    expect(selectElementSurface(input({ canvasOnScreen: true, target: 'preview' }))).toBe('canvas');
  });

  it('addresses Live Preview when it is on screen and Canvas is not', () => {
    expect(selectElementSurface(input({ previewOnScreen: true, target: 'canvas' }))).toBe('preview');
  });

  it('follows the surface the Inspector reads when both are on screen', () => {
    expect(selectElementSurface(input({ previewOnScreen: true, canvasOnScreen: true, target: 'canvas' }))).toBe('canvas');
    expect(selectElementSurface(input({ previewOnScreen: true, canvasOnScreen: true, target: 'preview' }))).toBe('preview');
  });

  it('follows the surface the Inspector reads when neither is on screen', () => {
    expect(selectElementSurface(input({ target: 'canvas' }))).toBe('canvas');
    expect(selectElementSurface(input({ target: 'preview' }))).toBe('preview');
  });

  it('addresses Live Preview whenever the project has no Canvas', () => {
    // A terminal runtime, or quick edit: whatever a stale layout or target says, the press must not
    // reveal a panel the project cannot show.
    expect(selectElementSurface(input({ canvas: false, canvasOnScreen: true, target: 'canvas' }))).toBe('preview');
  });
});
