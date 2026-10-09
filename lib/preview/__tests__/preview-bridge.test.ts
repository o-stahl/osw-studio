// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { previewBridgeScript } from '../preview-bridge';

/**
 * The host learns about a preview document only from what the document posts: its load, and its
 * scroll position. It never reads the frame, so the frame can be kept off the app's origin.
 */

let posted: unknown[];
let listeners: Array<[string, EventListenerOrEventListenerObject]>;

function run(loadId: number) {
  const source = previewBridgeScript(loadId).replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function(source)();
}

beforeEach(() => {
  vi.useFakeTimers();
  posted = [];
  listeners = [];
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => { posted.push(message); });
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    listeners.push([type, fn]);
    add(type, fn, opts as AddEventListenerOptions);
  });
});

afterEach(() => {
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('previewBridgeScript', () => {
  it('is one inline script with an integer load id', () => {
    const script = previewBridgeScript(7.9);
    expect(script.startsWith('<script>') && script.endsWith('</script>')).toBe(true);
    expect(script).toContain('id=7,');
    expect(script).not.toMatch(/contentDocument|parent\.document|parent\.location/);
  });

  it('reports its load with the id it was written with', () => {
    run(42);
    expect(posted).toEqual([]);
    window.dispatchEvent(new Event('load'));
    expect(posted).toEqual([{ type: 'preview:ready', loadId: 42 }]);
  });

  it('reports the scroll position once scrolling settles, not per event', () => {
    run(3);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 });
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(posted).toEqual([{ type: 'preview:scroll', loadId: 3, x: 12, y: 500 }]);
  });
});
