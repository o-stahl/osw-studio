import { describe, it, expect } from 'vitest';
import { shownPreview } from '../index';

/**
 * The Live Preview a workspace action reads: placing a block, and the composer's screenshot. Both
 * layouts are mounted, the other only hidden by CSS, so its document is not what the person sees.
 * Wired through `shownPreviewHandle`, which `workspace-wiring.test.ts` checks.
 */
describe('shownPreview', () => {
  const desktop = { name: 'desktop' };
  const mobile = { name: 'mobile' };

  it('is the desktop preview on a desktop, though the mobile one is mounted too', () => {
    expect(shownPreview(false, desktop, mobile)).toBe(desktop);
  });

  it('is the mobile preview on a phone', () => {
    expect(shownPreview(true, desktop, mobile)).toBe(mobile);
  });

  it('is nothing when the preview on screen is not mounted, rather than the hidden one', () => {
    expect(shownPreview(false, null, mobile)).toBeNull();
    expect(shownPreview(true, desktop, null)).toBeNull();
  });
});
