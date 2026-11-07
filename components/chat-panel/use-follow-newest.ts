import { useEffect, useRef, type RefObject } from 'react';

/** How close to the bottom counts as the bottom, in pixels. */
const AT_BOTTOM = 50;
/** How long after a wheel turn, a touch or a key a scroll is taken as the person's, in milliseconds. */
const PERSON_MS = 250;
/** Keys that scroll the box the focus is in. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Keeps a scroll box on its newest content while the person lets it. Scrolling up stops it, and the
 * view stays where they put it; scrolling back to the bottom, sending a message or opening another
 * conversation starts it again.
 *
 * Only the person stops it. Following only ever scrolls down, and the page moves the view up on its
 * own too, when content under the bottom shrinks or scroll anchoring keeps a row in place, so an
 * upward scroll counts only right after a wheel turn, a touch or a key, or with the scrollbar held.
 */
export function useFollowNewest(
  scrollRef: RefObject<HTMLElement | null>,
  { content, requests, conversation, empty }: {
    /** Changes whenever the content does. */
    content: unknown;
    /** How many messages the person has sent. */
    requests: number;
    /** Changes when another conversation is shown. */
    conversation: unknown;
    /** An empty box reads from the top, as a page, not from the end of a conversation. */
    empty: boolean;
  },
): void {
  const following = useRef(true);
  const seenRequests = useRef(requests);

  // Declared before the scroll below, so that a message sent or a conversation opened is followed
  // from the render it arrives in.
  useEffect(() => {
    if (requests > seenRequests.current) following.current = true;
    seenRequests.current = requests;
  }, [requests]);

  useEffect(() => {
    following.current = true;
  }, [conversation]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box || empty || !following.current) return;
    const frame = requestAnimationFrame(() => {
      // Asked again: the person may have scrolled up since this frame was asked for.
      if (following.current) box.scrollTop = box.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRef, content, empty]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    let personUntil = 0;
    let dragging = false;
    let lastTop = box.scrollTop;
    const byPerson = () => { personUntil = performance.now() + PERSON_MS; };
    const onWheel = (event: WheelEvent) => {
      byPerson();
      if (event.deltaY < 0) following.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) byPerson();
    };
    // A press on the box itself, not on its content, is on its scrollbar.
    const onPointerDown = (event: Event) => {
      if (event.target === box) dragging = true;
    };
    const onPointerUp = () => { dragging = false; };
    const onScroll = () => {
      const top = box.scrollTop;
      const up = top < lastTop;
      lastTop = top;
      if (up && (dragging || performance.now() < personUntil)) {
        following.current = false;
        return;
      }
      if (box.scrollHeight - top - box.clientHeight <= AT_BOTTOM) following.current = true;
    };
    box.addEventListener('wheel', onWheel, { passive: true });
    box.addEventListener('touchmove', byPerson, { passive: true });
    box.addEventListener('keydown', onKey);
    box.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('touchmove', byPerson);
      box.removeEventListener('keydown', onKey);
      box.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      box.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);
}
