// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Signing in to OpenRouter from the connect drawer: the popup lands the key elsewhere and announces
 * it with `apiKeyUpdated`, and the drawer finishes only for the sign-in it started.
 */
const mocks = vi.hoisted(() => ({ startSignIn: vi.fn() }));
vi.mock('@/lib/auth/provider-sign-in', () => ({ startSignIn: mocks.startSignIn, prepareSignIn: async () => {} }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { ConnectConfigBody } from '../connections-pane';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
const onConnected = vi.fn();

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.startSignIn.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(providerId: 'openrouter' | 'openai' = 'openrouter') {
  act(() => {
    root.render(withMessages(<ConnectConfigBody providerId={providerId} onConnected={onConnected} onBack={() => {}} />));
  });
}

const signInButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent === en.settings.signInWithProvider.replace('{provider}', 'OpenRouter'));

async function signIn() {
  const button = signInButton();
  if (!button) throw new Error('no sign-in button');
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const announce = (provider: string, hasKey: boolean) =>
  act(() => { window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey } })); });

describe('OpenRouter sign-in from the connect drawer', () => {
  it('finishes when the key from its sign-in lands', async () => {
    mount();
    await signIn();
    expect(mocks.startSignIn).toHaveBeenCalledWith('openrouter', expect.anything());
    announce('openrouter', true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('finishes once, not on every later key change', async () => {
    mount();
    await signIn();
    announce('openrouter', true);
    announce('openrouter', true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('ignores a key that lands without a sign-in started here', () => {
    mount();
    announce('openrouter', true);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('ignores another provider, and a key being removed', async () => {
    mount();
    await signIn();
    announce('openai', true);
    announce('openrouter', false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('offers no sign-in for a provider without one', () => {
    mount('openai');
    expect(container.textContent).not.toContain('Sign in');
  });
});
