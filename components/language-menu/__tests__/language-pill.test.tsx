// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

/** The sign-in pages' language pill: it names the language in use, in that language. */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/i18n/actions', () => ({ setLocale: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { LanguagePill } from '..';
import { deepMerge } from '@/lib/i18n/merge';
import en from '@/messages/en.json';
import ko from '@/messages/ko.json';

let container: HTMLDivElement;
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

describe('LanguagePill', () => {
  it('names the active language in itself', () => {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={deepMerge(en, ko)}>
          <LanguagePill />
        </NextIntlClientProvider>,
      );
    });
    const label = container.querySelector('span[lang]');
    expect(label?.getAttribute('lang')).toBe('ko');
    expect(label?.textContent).toBe('한국어');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(ko.settings.language.title);
  });
});
