// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { TranslatorBridge } from '@/lib/i18n/translator-bridge';
import { translator } from '@/lib/i18n/runtime';

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

const mount = (locale: 'en' | 'fi') =>
  act(() => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'fi' ? fi : en}>
        <TranslatorBridge />
      </NextIntlClientProvider>
    );
  });

describe('TranslatorBridge', () => {
  it('gives code outside components the provider’s language', () => {
    mount('fi');
    expect(translator()('orchestrator.noPrompt')).toBe(fi.orchestrator.noPrompt);
  });

  it('follows a change of language without a reload', () => {
    mount('fi');
    mount('en');
    expect(translator()('orchestrator.noPrompt')).toBe(en.orchestrator.noPrompt);
  });

  it('falls back to the key path once it is gone', () => {
    mount('fi');
    act(() => root.render(<></>));
    expect(translator()('orchestrator.noPrompt')).toBe('orchestrator.noPrompt');
  });
});
