// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { generateNavigationScript } from '@/lib/preview/navigation-script';

/**
 * A selection names the page file it was made on and the width the page was laid out at: the focus
 * block leads with both, and the chip shows the width. The route (`/about`) is not the file
 * (`/about.html`), so the file is passed in and the payload must carry that, not the route.
 */

const posted: { type?: string; payload?: { page?: string; viewportWidth?: number; srcAttr?: string; instanceCount?: number } }[] = [];

function send(message: unknown): void {
  window.dispatchEvent(Object.assign(new Event('message'), { data: message, source: window.parent }));
}

beforeAll(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (message: { type?: string }) => { posted.push(message as (typeof posted)[number]); } },
  });
  const html = generateNavigationScript('/about', true, '', '/about.html');
  new Function([...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n'))();
});

describe('the selection payload', () => {
  it('carries the page file and the layout width', () => {
    document.body.innerHTML = '<main><p data-osw-src="/about.html:6">Hi</p></main>';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    send({ type: 'select-src', src: '/about.html:6' });
    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection?.payload).toMatchObject({ srcAttr: '/about.html:6', page: '/about.html', viewportWidth: 375 });
  });

  it('finds and counts the elements of a source whose path has a quote and a backslash in it', () => {
    const src = '/it\'s/a"b\\c.html:6';
    document.body.innerHTML = '<main></main>';
    for (const text of ['one', 'two']) {
      const p = document.createElement('p');
      p.setAttribute('data-osw-src', src);
      p.textContent = text;
      document.querySelector('main')!.appendChild(p);
    }
    posted.length = 0;
    send({ type: 'select-src', src });
    const selection = posted.find(m => m.type === 'selector-selection');
    expect(selection?.payload).toMatchObject({ srcAttr: src, instanceCount: 2 });
  });
});
