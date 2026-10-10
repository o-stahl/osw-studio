// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { ProviderId } from '@/lib/llm/providers/types';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'connect' });

/**
 * What connecting from the chat does: a checked key is stored and announced as Settings ›
 * Connections stores it; a model server on this machine is offered only where the app's server can
 * reach it; sign-in uses a popup where the page must stay; excluded providers are not offered.
 * (Which provider a pasted key is sent to is covered in paste-key.test.tsx.)
 */

let surface = 'browser';
const verifyApiKey = vi.fn();
let localModels: Partial<Record<ProviderId, string[]>> = {};
const getAvailableModels = vi.fn(async (_key: unknown, provider: ProviderId) => localModels[provider] ?? []);
vi.mock('@/lib/llm/llm-client', () => ({
  verifyApiKey: (...args: unknown[]) => verifyApiKey(...args),
  getAvailableModels: (key: unknown, provider: ProviderId) => getAvailableModels(key, provider),
}));
vi.mock('@/lib/telemetry/config', () => ({ detectDeploymentType: () => surface }));
const track = vi.fn();
vi.mock('@/lib/telemetry', () => ({ track: (...a: unknown[]) => track(...a) }));
const checkHFCapabilities = vi.fn(async () => ({ oauthAvailable: true, clientId: 'hf-client', scopes: 'openid' }));
vi.mock('@/lib/auth/hf-auth', () => ({ checkHFCapabilities: () => checkHFCapabilities(), loginHF: vi.fn(async () => {}) }));
const startSignIn = vi.fn(async (..._a: unknown[]) => true);
const prepareSignIn = vi.fn(async () => {});
vi.mock('@/lib/auth/provider-sign-in', () => ({ startSignIn: (...a: unknown[]) => startSignIn(...a), prepareSignIn: () => prepareSignIn() }));
let embedded = false;
vi.mock('@/lib/web/embedded', () => ({ isEmbedded: () => embedded }));
const loadProviderModels = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/llm/models/model-catalog', () => ({ loadProviderModels: (...a: unknown[]) => loadProviderModels(...a) }));
const activateProviderAsGlobalDefault = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/llm/models/global-auto-assign', () => ({ activateProviderAsGlobalDefault: (...a: unknown[]) => activateProviderAsGlobalDefault(...a) }));
let autoAssign = true;
vi.mock('@/lib/llm/models/project-assignment', () => ({ shouldAutoAssignAgent: () => autoAssign }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ConnectOptions } from '../connect-options';
import { configManager } from '@/lib/config/storage';

let container: HTMLElement;
let root: Root;
let events: Array<{ provider: string; hasKey: boolean }>;
const onKey = (e: Event) => events.push((e as CustomEvent).detail);

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  surface = 'browser';
  localModels = {};
  autoAssign = true;
  embedded = false;
  events = [];
  for (const m of [verifyApiKey, getAvailableModels, track, checkHFCapabilities, startSignIn, prepareSignIn, loadProviderModels, activateProviderAsGlobalDefault]) m.mockClear();
  window.addEventListener('apiKeyUpdated', onKey);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  window.removeEventListener('apiKeyUpdated', onKey);
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function render(props: React.ComponentProps<typeof ConnectOptions> = {}) {
  await act(async () => { root.render(withMessages(<ConnectOptions {...props} />)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

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
const rowButton = (rowText: string, label: string) => {
  const row = [...container.querySelectorAll('button')].filter((b) => b.textContent === label)
    .find((b) => b.parentElement?.textContent?.includes(rowText));
  return row as HTMLButtonElement | undefined;
};

describe('a key that checks out', () => {
  it('is stored, clears the provider\'s cached models, is announced, and the field empties', async () => {
    const clearModelCache = vi.spyOn(configManager, 'clearModelCache');
    verifyApiKey.mockResolvedValue(true);
    await render();
    await paste('sk-or-v1-abcdef');
    expect(configManager.getProviderApiKey('openrouter')).toBe('sk-or-v1-abcdef');
    expect(clearModelCache).toHaveBeenCalledWith('openrouter');
    expect(events).toEqual([{ provider: 'openrouter', hasKey: true }]);
    expect(track).toHaveBeenCalledWith('connection_added', { provider: 'openrouter', method: 'key' });
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('does nothing for an empty field', async () => {
    await render();
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(verifyApiKey).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Which provider is this key from?');
  });
});

describe('a model on this computer', () => {
  it.each(['hf_space', 'managed'])('is not offered on %s, and nothing is probed', async (s) => {
    surface = s;
    await render();
    expect(container.textContent).not.toContain(t('localTitle'));
    expect(getAvailableModels).not.toHaveBeenCalled();
  });

  it.each([
    ['browser', false],
    ['server', false],
    ['desktop', true],
  ])('on a remote host, is offered on %s: %s', async (s, offered) => {
    surface = s;
    vi.stubGlobal('location', { ...window.location, hostname: 'studio.example.com' });
    try {
      await render();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(container.textContent?.includes(t('localTitle'))).toBe(offered);
  });

  it('is offered on desktop', async () => {
    surface = 'desktop';
    await render();
    expect(container.textContent).toContain(t('localTitle'));
  });

  it('is not offered when the stopped task ran out on a local provider', async () => {
    surface = 'desktop';
    await render({ exclude: ['ollama'] });
    expect(container.textContent).not.toContain(t('localTitle'));
  });

  it('connects a found server by loading its models, and announces it without a key', async () => {
    surface = 'desktop';
    localModels = { ollama: ['qwen3:4b', 'llama3'] };
    await render();
    expect(container.textContent).toContain(t('localFound', { name: 'Ollama', count: 2 }));
    await act(async () => { rowButton(t('localTitle'), t('use'))!.click(); });
    expect(loadProviderModels).toHaveBeenCalledWith('ollama');
    expect(activateProviderAsGlobalDefault).toHaveBeenCalledWith('ollama');
    expect(events).toEqual([{ provider: 'ollama', hasKey: false }]);
  });

  it('leaves the model assignment alone when it should not be auto-assigned', async () => {
    surface = 'desktop';
    autoAssign = false;
    localModels = { lmstudio: ['m'] };
    await render();
    await act(async () => { rowButton(t('localTitle'), t('use'))!.click(); });
    expect(loadProviderModels).toHaveBeenCalledWith('lmstudio');
    expect(activateProviderAsGlobalDefault).not.toHaveBeenCalled();
  });
});

describe('signing in and exclusions', () => {
  it('signs in to OpenRouter in a popup when the page has to stay', async () => {
    await render({ keepPage: true });
    await act(async () => { rowButton('OpenRouter', t('signIn'))!.click(); });
    expect(startSignIn).toHaveBeenCalledWith('openrouter', { popup: true });
  });

  it('signs in with a redirect otherwise', async () => {
    await render();
    await act(async () => { rowButton('OpenRouter', t('signIn'))!.click(); });
    expect(startSignIn).toHaveBeenCalledWith('openrouter', { popup: false });
  });

  it('signs in in a popup inside a frame, where the sign-in page refuses to load', async () => {
    embedded = true;
    await render();
    await act(async () => { rowButton('OpenRouter', t('signIn'))!.click(); });
    expect(startSignIn).toHaveBeenCalledWith('openrouter', { popup: true });
  });

  it('redirects on desktop even where the page has to stay, since its popups open in the system browser', async () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP', 'true');
    embedded = true;
    await render({ keepPage: true });
    await act(async () => { rowButton('OpenRouter', t('signIn'))!.click(); });
    expect(startSignIn).toHaveBeenCalledWith('openrouter', { popup: false });
  });

  it('keeps the sign-in button busy until the sign-in is prepared', async () => {
    let finish!: () => void;
    prepareSignIn.mockImplementationOnce(() => new Promise<void>((r) => { finish = r; }));
    await render();
    expect(rowButton('OpenRouter', t('signIn'))!.disabled).toBe(true);
    await act(async () => { finish(); await Promise.resolve(); });
    expect(rowButton('OpenRouter', t('signIn'))!.disabled).toBe(false);
  });

  it('leaves out an excluded provider', async () => {
    await render({ exclude: ['openrouter'] });
    expect(rowButton('OpenRouter', t('signIn'))).toBeUndefined();
  });

  it('offers HuggingFace sign-in on the Space, but does not ask for it where the page must stay or HF is excluded', async () => {
    surface = 'hf_space';
    await render();
    expect(checkHFCapabilities).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('HuggingFace');

    // Fresh mounts: the capability check runs on mount.
    for (const props of [{ keepPage: true }, { exclude: ['huggingface' as ProviderId] }]) {
      act(() => root.unmount());
      root = createRoot(container);
      checkHFCapabilities.mockClear();
      await render(props);
      expect(checkHFCapabilities).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('HuggingFace');
    }
  });
});
