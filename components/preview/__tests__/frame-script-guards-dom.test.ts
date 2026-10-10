// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateNavigationScript, generatePlacementScript } from '../multipage-preview';

/**
 * Two things the preview's frame scripts must do, run for real against a live document.
 *
 * The placement script acts on messages, and only the host's: project code can open a window of
 * its own and post to the frame, and a message from it must not remove the user's placed blocks.
 * (The navigation script's equivalent guard is pinned in style-query-dom.test.ts.)
 *
 * An in-page link click hands the navigation to the host, which writes the next page at once. The
 * project's storage writes are reported on a 50 ms timer, so they have to be flushed first, or the
 * next page starts from storage without them.
 *
 * One instance of each script for the whole file: every run adds listeners to the same window.
 */

function jsOf(html: string): string {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
}

/** What the frame did, in order: messages to the host, and storage flushes. */
const log: unknown[] = [];

function send(message: unknown, source: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source }));
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: unknown) => { log.push(message); } },
  });
  (window as unknown as { __oswFlushStorage: () => void }).__oswFlushStorage = () => { log.push('flush'); };
  new Function(jsOf(generatePlacementScript()))();
  new Function(jsOf(generateNavigationScript('/index.html')))();
});

beforeEach(() => {
  log.length = 0;
  document.body.innerHTML = '';
});

describe('the placement script', () => {
  it('removes a placed block only when the host asks', () => {
    document.body.innerHTML = '<section data-placement-id="sb-1700000000000-abc123">placed</section>';
    const remove = { type: 'placement-remove', placementId: 'sb-1700000000000-abc123' };

    send(remove, window);
    expect(document.querySelector('[data-placement-id]')).not.toBeNull();

    send(remove, window.parent);
    expect(document.querySelector('[data-placement-id]')).toBeNull();
  });
});

describe('an in-page link click', () => {
  it('flushes storage before handing the navigation to the host', () => {
    document.body.innerHTML = '<a href="/about.html">About</a>';
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });

    document.querySelector('a')!.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(log.filter(m => m === 'flush' || (m as { type?: string }).type === 'navigate'))
      .toEqual(['flush', { type: 'navigate', path: '/about' }]);
  });
});
