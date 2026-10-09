// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

/**
 * The HuggingFace Space's popup after a relayed sign-in: it finishes the sign-in, says so, and tries
 * to close; huggingface.co usually prevents that, so the screen tells the person to close it.
 */

const finish = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/lib/hooks/use-provider-sign-in-return', () => ({ finishRelayedSignIn: (s: URLSearchParams) => finish.fn(s) }));

import { SignInRelay } from '../index';
import { SignInError } from '@/lib/auth/provider-sign-in';

const t = createTranslator({ locale: 'en', messages: en, namespace: 'connect' });

let container: HTMLElement;
let root: Root;
const close = vi.fn();

async function render() {
  await act(async () => root.render(withMessages(<SignInRelay />)));
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  finish.fn.mockReset();
  close.mockReset();
  vi.spyOn(window, 'top', 'get').mockReturnValue({ close } as unknown as Window);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SignInRelay', () => {
  it('finishes the sign-in, says to close the window, and tries to close it', async () => {
    finish.fn.mockResolvedValue('openrouter');
    await render();
    expect(finish.fn).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(t('connected', { name: 'OpenRouter' }));
    expect(container.textContent).toContain(t('relayDone'));
    expect(close).toHaveBeenCalled();
  });

  it('shows a cancelled sign-in as cancelled, and does not try to close', async () => {
    finish.fn.mockRejectedValue(new SignInError('denied'));
    await render();
    expect(container.textContent).toContain(t('signInCancelled'));
    expect(close).not.toHaveBeenCalled();
  });

  it('shows any other failure as a sign-in that did not finish', async () => {
    finish.fn.mockRejectedValue(new SignInError('exchange'));
    await render();
    expect(container.textContent).toContain(t('signInFailed'));
    expect(container.textContent).toContain(t('relayClose'));
  });
});
