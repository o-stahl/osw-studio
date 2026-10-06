// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import { SeoTab } from '../seo-tab';

/**
 * The Open Graph image preview says so when the image does not load, as text React renders (the
 * message is never parsed as HTML), and tries again when the URL changes.
 */

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (ogImage: string) =>
  act(() => {
    root.render(withMessages(
      <SeoTab settings={{ seo: { ogImage } } as never} onChange={() => {}} />,
    ));
  });

describe('the Open Graph image preview', () => {
  it('replaces an image that fails to load with the message, and tries a new URL', () => {
    render('https://example.com/broken.png');
    const preview = () => container.querySelector(`img[alt="${en.publishSettings.ogImageAlt}"]`);
    act(() => { preview()!.dispatchEvent(new Event('error')); });
    expect(preview()).toBeNull();
    expect(container.textContent).toContain(en.publishSettings.imageLoadFailed);

    render('https://example.com/other.png');
    expect(preview()?.getAttribute('src')).toBe('https://example.com/other.png');
  });
});
