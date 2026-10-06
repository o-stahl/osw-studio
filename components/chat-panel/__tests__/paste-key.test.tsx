// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'connect' });

/**
 * A pasted key goes to one provider at most, and only the one it belongs to.
 *
 * A key's shape often names its provider (`sk-or-` is OpenRouter's). A bare `sk-` could be OpenAI's,
 * DeepSeek's or another's; trying it against each would hand the key to providers it does not
 * belong to, so the person is asked first and only their pick checks it.
 */

const verifyApiKey = vi.fn();
vi.mock('@/lib/llm/llm-client', () => ({
  verifyApiKey: (...args: unknown[]) => verifyApiKey(...args),
  getAvailableModels: async () => [],
}));
vi.mock('@/lib/telemetry/config', () => ({ detectDeploymentType: () => 'hosted' }));
vi.mock('@/lib/telemetry', () => ({ track: () => {} }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: async () => ({ oauthAvailable: false }), loginHF: () => {} }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

import { ConnectOptions } from '../connect-options';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  verifyApiKey.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(withMessages(<ConnectOptions />)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function paste(key: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, key);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('pasting a key', () => {
  it('asks whose a bare sk- key is without sending it anywhere, then checks only the pick', async () => {
    verifyApiKey.mockResolvedValue(true);
    await paste('sk-0123456789abcdef0123456789abcdef');
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Which provider is this key from?');

    await act(async () => { button('DeepSeek')!.click(); });
    expect(verifyApiKey).toHaveBeenCalledTimes(1);
    expect(verifyApiKey).toHaveBeenCalledWith('sk-0123456789abcdef0123456789abcdef', 'deepseek');
  });

  it('checks a key whose shape names its provider with that provider alone', async () => {
    verifyApiKey.mockResolvedValue(false);
    await paste('sk-or-v1-abcdef');
    expect(verifyApiKey).toHaveBeenCalledTimes(1);
    expect(verifyApiKey).toHaveBeenCalledWith('sk-or-v1-abcdef', 'openrouter');
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/OpenRouter/);
  });

  it('says the check could not run when it could not, rather than calling the key invalid', async () => {
    verifyApiKey.mockRejectedValue(new Error('Key check failed (502)'));
    await paste('sk-or-v1-abcdef');
    const alert = container.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe(t('checkFailed'));
    expect(alert).not.toBe(t('invalid', { name: 'OpenRouter' }));
  });
});
