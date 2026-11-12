// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

/**
 * The key field of a local provider in the Benchmark page's model settings, which is optional there,
 * labelled in the app's language like the key field of every other provider.
 */

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getSelectedProvider: () => 'ollama',
    getProviderApiKey: () => '',
    isCompactionEnabled: () => false,
    getCompactionLimit: () => undefined,
  },
}));
vi.mock('@/lib/llm/llm-client', () => ({ validateApiKey: vi.fn() }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: vi.fn(async () => ({ codexAvailable: true })) }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/components/model-selector', () => ({ ModelSelector: () => null }));
vi.mock('@/components/settings/ollama-preflight', () => ({ OllamaPreflight: () => null }));
vi.mock('@/components/settings/local-context-length', () => ({ LocalContextLength: () => null }));

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';
import { getProvider } from '@/lib/llm/providers/registry';
import { ModelSettingsPanel } from '../model-settings';

let container: HTMLElement;
let root: Root;

const messages = deepMerge(en, fi);
const t = createTranslator({ locale: 'fi', messages, onError: (e) => { throw e; } });

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

describe('ModelSettingsPanel with a local provider', () => {
  it('labels the optional key field in the app\'s language', () => {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={messages}>
          <ModelSettingsPanel />
        </NextIntlClientProvider>,
      );
    });
    const label = container.querySelector('label[for="api-key"]')!;

    expect(label.textContent).not.toMatch(/API Key|optional/);
    expect(label.textContent).toContain(t('settings.providerApiKey', { provider: getProvider('ollama').name }));
    expect(label.textContent).toContain(t('common.labels.optionalParen'));
  });
});
