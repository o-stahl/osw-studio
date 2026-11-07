// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useFollowNewest } from '../use-follow-newest';

/**
 * The thread follows its newest content until the person scrolls up, and again once they scroll back
 * to the bottom, send a message or open another conversation. jsdom does no layout, so the scroll
 * box's geometry is stood in for: a box 500px high over content `height` px tall, which fires `scroll`
 * whenever its position changes, as a browser does. Frames queue until the test runs them, as a
 * browser's wait for the next paint.
 */

const CLIENT = 500;
let container: HTMLDivElement;
let root: Root;
let height: number;
let top: number;
let frames: Array<FrameRequestCallback | null>;

interface Props { content: number; requests?: number; conversation?: string; empty?: boolean }

function Thread({ content, requests = 0, conversation = 'p1', empty = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useFollowNewest(ref, { content, requests, conversation, empty });
  return <div ref={ref} />;
}

const box = () => container.firstElementChild as HTMLDivElement;
const bottom = () => height - CLIENT;
const render = (props: Props) => act(() => { root.render(<Thread {...props} />); });
const runFrames = () => { const due = frames; frames = []; for (const frame of due) frame?.(0); };
/** New content arrives: it grows the thread, which renders again. */
const grow = (props: Props) => { height += 400; render(props); runFrames(); };
/** A scroll the page makes itself (layout, scroll anchoring): no wheel, touch or key before it. */
const scrollTo = (y: number) => act(() => { box().scrollTop = y; });
/** The person turns the wheel, and the box scrolls with it. */
const wheel = (deltaY: number, y: number) => act(() => {
  box().dispatchEvent(new WheelEvent('wheel', { deltaY }));
  box().scrollTop = y;
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  height = 1000;
  top = 0;
  frames = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => CLIENT });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get: () => top,
    set(this: HTMLElement, y: number) {
      const next = Math.max(0, Math.min(y, height - CLIENT));
      if (next === top) return;
      top = next;
      this.dispatchEvent(new Event('scroll'));
    },
  });
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = null; });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

describe('a thread following its newest content', () => {
  it('keeps new content in view at the bottom', () => {
    render({ content: 1 });
    runFrames();
    expect(top).toBe(bottom());

    grow({ content: 2 });
    expect(top).toBe(bottom());
  });

  it('leaves an empty thread at its top', () => {
    render({ content: 0, empty: true });
    runFrames();
    expect(top).toBe(0);
  });

  it('stays where the person scrolled up to while content keeps coming', () => {
    render({ content: 1 });
    runFrames();
    wheel(-100, 200);

    grow({ content: 2 });
    grow({ content: 3 });
    expect(top).toBe(200);
  });

  it('stays put when the person scrolls up between asking for a frame and painting it', () => {
    render({ content: 1 });
    runFrames();
    height += 400;
    render({ content: 2 });
    wheel(-100, 200);

    runFrames();
    expect(top).toBe(200);
  });

  it('stops on the wheel turn itself, before a smooth scroll has moved the box', () => {
    render({ content: 1 });
    runFrames();
    const at = top;
    height += 400;
    render({ content: 2 });
    act(() => { box().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });

    runFrames();
    expect(top).toBe(at);
  });

  it('stays put after scrolling up only a little, inside the margin that counts as the bottom', () => {
    render({ content: 1 });
    runFrames();
    wheel(-10, bottom() - 10);
    const at = top;

    grow({ content: 2 });
    expect(top).toBe(at);
  });

  it('stops for the scrollbar dragged up, and for keys and touch', () => {
    for (const [name, start] of [
      ['scrollbar', () => box().dispatchEvent(new Event('pointerdown'))],
      ['key', () => box().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))],
      ['touch', () => box().dispatchEvent(new Event('touchmove'))],
    ] as const) {
      height = 1000;
      render({ content: 1, conversation: name });
      runFrames();
      act(start);
      scrollTo(100);
      act(() => { window.dispatchEvent(new Event('pointerup')); });

      grow({ content: 2, conversation: name });
      expect(top, name).toBe(100);
    }
  });

  it('keeps following through a scroll the page makes itself', () => {
    render({ content: 1 });
    runFrames();
    scrollTo(bottom() - 200);

    grow({ content: 2 });
    expect(top).toBe(bottom());
  });

  it('follows again once the person scrolls back to the bottom', () => {
    render({ content: 1 });
    runFrames();
    wheel(-100, 100);
    grow({ content: 2 });
    expect(top).toBe(100);

    wheel(300, bottom());
    grow({ content: 3 });
    expect(top).toBe(bottom());
  });

  it('follows again when the person sends a message', () => {
    render({ content: 1, requests: 1 });
    runFrames();
    wheel(-100, 100);

    grow({ content: 2, requests: 2 });
    expect(top).toBe(bottom());
  });

  it('follows again in another conversation', () => {
    render({ content: 1, conversation: 'p1' });
    runFrames();
    wheel(-100, 100);

    grow({ content: 2, conversation: 'p2' });
    expect(top).toBe(bottom());
  });
});
