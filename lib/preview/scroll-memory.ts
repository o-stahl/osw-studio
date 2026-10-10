/**
 * Remembers the preview frame's scroll position across `srcdoc` reassignments.
 * The outgoing document reports its own position (`preview:scroll`, see `preview-bridge.ts`);
 * keyed on `activePath` so a genuine page navigation opens at the top.
 */

export interface FrameScroll {
  x: number;
  y: number;
}

/** Single slot, not a map: only the outgoing page's position is meaningful. */
export class FrameScrollMemory {
  private held: { path: string; x: number; y: number } | null = null;

  /**
   * Record where the outgoing document was scrolled to, on the way to replacing it.
   *
   * A missing path, or no position reported by the frame, clears the slot instead of leaving the
   * previous record in it: a record that survives the load it was taken for would be restored onto the *next* one.
   *
   * Zero is not recorded; a fresh document is already at the top.
   */
  remember(path: string | null | undefined, scroll: FrameScroll | null): void {
    if (!path || !scroll) {
      this.held = null;
      return;
    }
    const x = Math.max(0, Math.round(scroll.x));
    const y = Math.max(0, Math.round(scroll.y));
    if (x === 0 && y === 0) {
      this.held = null;
      return;
    }
    this.held = { path, x, y };
  }

  /** The position to restore, or null. One-shot: consumed whether or not the path matched. */
  take(path: string | null | undefined): FrameScroll | null {
    const held = this.held;
    this.held = null;
    if (!held || !path || held.path !== path) return null;
    return { x: held.x, y: held.y };
  }
}
