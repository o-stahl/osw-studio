import { describe, it, expect } from 'vitest';
import { FrameScrollMemory, frameScrollReport } from '../scroll-memory';

/**
 * Keeping the preview frame's scroll position across the recompile that replaces its document.
 *
 * The whole decision lives here, as a pure object, for the same reason `focusReloadAction` does: the
 * two call sites are inside a React component that owns a live iframe, and neither the `srcdoc` write
 * nor the load event is reachable from jsdom in any way that would prove anything. What is testable is
 * the rule — record on the way out, hand it back only for the same page, once — and that is what this
 * file pins.
 *
 * **Only reachable by hand:** that `loadPage` records before writing `srcdoc` and that
 * `handleReadyAck` restores before announcing frame-ready. Both are ordering facts about a real browser.
 */

describe('FrameScrollMemory', () => {
  it('hands a recorded position back for the same page', () => {
    const memory = new FrameScrollMemory();

    memory.remember('/index.html', { x: 0, y: 500 });

    expect(memory.take('/index.html')).toEqual({ x: 0, y: 500 });
  });

  it('refuses a position recorded on a different page', () => {
    const memory = new FrameScrollMemory();

    memory.remember('/index.html', { x: 0, y: 500 });

    // The point of keying it. `loadPage` records the *outgoing* path, so a navigation records where
    // the user was on the page they left — restoring that onto the page they went to would open the
    // new page halfway down for no reason the user could name.
    expect(memory.take('/about.html')).toBeNull();
  });

  it('drops a mismatched record instead of keeping it for later', () => {
    const memory = new FrameScrollMemory();
    memory.remember('/index.html', { x: 0, y: 500 });

    memory.take('/about.html');

    // The record belongs to a page that has now been navigated away from. Keeping it would restore it
    // on some later return to that page, from a session the user has long finished.
    expect(memory.take('/index.html')).toBeNull();
  });

  it('is one-shot even for a matching page', () => {
    const memory = new FrameScrollMemory();
    memory.remember('/index.html', { x: 0, y: 500 });

    expect(memory.take('/index.html')).toEqual({ x: 0, y: 500 });
    // A second load of the same page with no `remember` in between is not evidence the user is still
    // where they were — every real reload records first.
    expect(memory.take('/index.html')).toBeNull();
  });

  it('records nothing for a document that was already at the top', () => {
    const memory = new FrameScrollMemory();

    memory.remember('/index.html', { x: 0, y: 0 });

    // Nothing to put back: a fresh document is already there. Holding it would mean sending a message
    // that cannot change anything.
    expect(memory.take('/index.html')).toBeNull();
  });

  it('clears the slot when there is nothing to record', () => {
    const memory = new FrameScrollMemory();
    memory.remember('/index.html', { x: 0, y: 500 });

    memory.remember('/index.html', null);

    // A frame that reported no position must not leave the previous load's record in the slot, or it is restored
    // onto the document *after* the one it was taken from.
    expect(memory.take('/index.html')).toBeNull();
  });

  it('clears the slot when there is no page to key on', () => {
    const memory = new FrameScrollMemory();
    memory.remember('/index.html', { x: 0, y: 500 });

    memory.remember(null, { x: 0, y: 400 });

    expect(memory.take('/index.html')).toBeNull();
  });

  it('overwrites on every record, so only the latest load is held', () => {
    const memory = new FrameScrollMemory();

    memory.remember('/index.html', { x: 0, y: 500 });
    memory.remember('/about.html', { x: 0, y: 120 });

    expect(memory.take('/index.html')).toBeNull();
    expect(memory.take('/about.html')).toBeNull();
  });

  it('rounds and floors what it is given', () => {
    const memory = new FrameScrollMemory();

    memory.remember('/index.html', { x: -4, y: 499.6 });

    // Sub-pixel offsets are real (a zoomed frame reports them) and a negative one is what an
    // overscroll bounce reports on macOS. Neither is a position worth restoring literally.
    expect(memory.take('/index.html')).toEqual({ x: 0, y: 500 });
  });
});

describe('frameScrollReport', () => {
  it("takes the position from the current document's report", () => {
    expect(frameScrollReport({ loadId: 4, x: 12, y: 500 }, 4)).toEqual({ x: 12, y: 500 });
  });

  it('drops a report from the document being replaced, or one that is not a position', () => {
    // The outgoing page's last report would put the new one at the old one's offset.
    expect(frameScrollReport({ loadId: 3, x: 12, y: 500 }, 4)).toBeNull();
    for (const [x, y] of [[NaN, 0], [0, Infinity], ['12', 500], [12, undefined]]) {
      expect(frameScrollReport({ loadId: 4, x, y }, 4), `${x}, ${y}`).toBeNull();
    }
  });
});
