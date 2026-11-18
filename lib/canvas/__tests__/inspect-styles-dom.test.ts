// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
import { generateNavigationScript } from '@/lib/preview/navigation-script';
import { canvasBridgeJs } from '../bridge';

/**
 * `canvas:inspect`'s winning declarations, against the shared document: jsdom builds style sheets
 * only for a document with a window, so the bridge harness's detached documents have none.
 */

const posted: { type?: string; reqId?: number; report?: { styles?: { property: string; computed: string; declared?: Record<string, string | boolean> }[] } }[] = [];

beforeAll(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: (m: (typeof posted)[number]) => { posted.push(m); } } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
  document.body.innerHTML =
    '<style>.hero { padding: 48px 24px; } @media (max-width: 767px) { .hero h1 { font-size: 36px; } }' +
    '[data-osw-id="h1abc123"][data-osw-id] { color: red; }</style>' +
    '<section class="hero" data-osw-src="/index.html:40"><h1 data-osw-id="h1abc123" data-osw-src="/index.html:70" style="margin-top: 4px">Hello</h1></section>';
  const html = generateNavigationScript('/index.html', false, canvasBridgeJs('settle', 900, 1));
  new Function([...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'))();
});

describe('canvas:inspect on a styled page', () => {
  it('names the rule that sets each value: selector, file and media', () => {
    window.dispatchEvent(Object.assign(new Event('message'), {
      data: { type: 'canvas:inspect', reqId: 4, target: '.hero h1', depth: 0, props: ['font-size', 'color', 'margin-top', 'letter-spacing'] },
      source: window.parent,
    }));
    const report = posted.find((m) => m.type === 'canvas:inspected' && m.reqId === 4)!.report!;
    const byName = Object.fromEntries(report.styles!.map((s) => [s.property, s]));
    expect(byName['font-size'].declared).toMatchObject({ value: '36px', selector: '.hero h1', media: '(max-width: 767px)' });
    expect(byName.color.declared).toMatchObject({ value: 'red', selector: '[data-osw-id="h1abc123"][data-osw-id]' });
    expect(byName['margin-top'].declared).toMatchObject({ value: '4px', origin: 'inline style' });
    expect(byName['letter-spacing'].declared).toBeUndefined();
    // The element's own override is marked, which is how `style` checks that a change took; a
    // project rule's win and the style attribute's are not.
    expect(byName.color.declared).toMatchObject({ ours: true });
    expect(byName['font-size'].declared).not.toHaveProperty('ours');
    expect(byName['margin-top'].declared).not.toHaveProperty('ours');
  });

  it('gives a computed url() as the project\'s path, not the preview\'s blob URL', () => {
    const w = window as unknown as { __oswVfsBlobUrls?: Record<string, string>; __oswShellUrls?: Record<string, string> };
    w.__oswVfsBlobUrls = { '/assets/hero.jpg': 'blob:http://app/host-1' };
    w.__oswShellUrls = { 'blob:http://app/host-1': 'blob:null/frame-1' };
    const h1 = document.querySelector('h1')!;
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) => (el === h1
      ? { display: 'block', getPropertyValue: (p: string) => (p === 'background-image' ? 'linear-gradient(red, blue), url("blob:null/frame-1")' : '') }
      : real(el))) as typeof window.getComputedStyle;
    window.dispatchEvent(Object.assign(new Event('message'), {
      data: { type: 'canvas:inspect', reqId: 5, target: '.hero h1', depth: 0, props: ['background-image'] },
      source: window.parent,
    }));
    window.getComputedStyle = real;
    const report = posted.find((m) => m.type === 'canvas:inspected' && m.reqId === 5)!.report!;
    expect(report.styles![0].computed).toBe('linear-gradient(red, blue), url("/assets/hero.jpg")');
  });
});
