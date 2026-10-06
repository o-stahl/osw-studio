// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { ProviderId } from '@/lib/llm/providers/types';

/**
 * The stopped card's actions beyond the basics in limit-cards.test.tsx: which alternatives and
 * suggestions it offers, the lines it words from the event, and — when nothing else is connected —
 * continuing as soon as a provider connects, once, and only for a provider that is connected now.
 */

let connected: Set<string> | null = null;
vi.mock('@/lib/llm/providers/connection-status', async (orig) => {
  const real = await orig<typeof import('@/lib/llm/providers/connection-status')>();
  return { ...real, isProviderConnected: (p: ProviderId) => (connected ? connected.has(p) : real.isProviderConnected(p)) };
});
const modelForProvider = vi.fn(async (provider: ProviderId) => ({ provider, model: `${provider}/suggested` }));
vi.mock('@/lib/llm/suggestions/suggest', () => ({ modelForProvider: (p: ProviderId) => modelForProvider(p) }));

import { StoppedCard, LimitNotice } from '../limit-cards';
import { configManager } from '@/lib/config/storage';
import { getDefaultModel } from '@/lib/llm/providers/registry';

const limits = createTranslator({ locale: 'en', messages: en, namespace: 'limits' });

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  connected = null;
  modelForProvider.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => { root.render(withMessages(node)); });
}
const button = (label: RegExp) => [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));
const buttons = (label: RegExp) => [...container.querySelectorAll('button')].filter((b) => label.test(b.textContent ?? ''));
const working = (provider: string, model: string) =>
  configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider, model } });

async function announce(provider: string) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey: true } }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('StoppedCard — continuing once a provider connects', () => {
  const spentHf = (onContinue: (m?: unknown) => void) => {
    working('huggingface', 'm');
    render(<StoppedCard live onContinue={onContinue} data={{ errorCategory: 'credit_exhausted', provider: 'huggingface', model: 'm' }} />);
  };

  it('continues on the suggested model of the provider that just connected, once', async () => {
    const onContinue = vi.fn();
    spentHf(onContinue);
    expect(container.textContent).toContain(limits('connectAnother'));
    connected = new Set(['openrouter']);
    await announce('openrouter');
    await announce('openrouter');
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith({ provider: 'openrouter', model: 'openrouter/suggested' });
  });

  it('ignores the provider that ran out, and a provider that is not connected (a disconnect)', async () => {
    const onContinue = vi.fn();
    spentHf(onContinue);
    connected = new Set(['huggingface']);
    await announce('huggingface');
    await announce('groq');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('falls back to the provider\'s default model when no suggestion can be made', async () => {
    modelForProvider.mockRejectedValueOnce(new Error('offline'));
    const onContinue = vi.fn();
    spentHf(onContinue);
    connected = new Set(['groq']);
    await announce('groq');
    expect(onContinue).toHaveBeenCalledWith({ provider: 'groq', model: getDefaultModel('groq') });
  });

  it('offers no connect step when there is a suggestion to take instead', () => {
    working('openrouter', 'paid/model');
    render(<StoppedCard live onContinue={() => {}} data={{
      errorCategory: 'credit_exhausted', provider: 'openrouter', model: 'paid/model',
      suggestion: { provider: 'openrouter', model: 'osw/free-models' },
    }} />);
    expect(container.textContent).not.toContain(limits('connectAnother'));
  });
});

describe('StoppedCard — what it offers', () => {
  it('never offers the provider that stopped as an alternative, and at most three in all', () => {
    working('openrouter', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{
      errorCategory: 'daily_limit', provider: 'openrouter', model: 'm',
      alternatives: [
        { provider: 'openrouter', model: 'other' },
        { provider: 'gemini', model: 'g' },
        { provider: 'groq', model: 'q' },
        { provider: 'mistral', model: 'x' },
        { provider: 'zhipu', model: 'z' },
      ],
    }} />);
    expect(button(/^Continue with OpenRouter$/)).toBeUndefined();
    expect(button(/^Continue with Google Gemini$/)).toBeDefined();
    expect(buttons(/^Continue with /)).toHaveLength(3);
  });

  it('counts a model on another provider as moved on, even with the same id', () => {
    working('gemini', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'daily_limit', provider: 'openrouter', model: 'm' }} />);
    expect(button(/^Continue with m$/)).toBeDefined();
  });

  it('drops its own suggestion once the user picked another model', () => {
    working('openrouter', 'x/picked-later');
    render(<StoppedCard live onContinue={() => {}} data={{
      errorCategory: 'model_busy', provider: 'openrouter', model: 'x/picked',
      suggestion: { provider: 'openrouter', model: 'x/other' },
    }} />);
    expect(button(/^Try /)).toBeUndefined();
  });
});

describe('StoppedCard — lines from the event', () => {
  it('words the reset from the event when there is no live count', () => {
    working('openrouter', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'daily_limit', provider: 'openrouter', model: 'm', resetAt: Date.now() + 2 * 3600_000 }} />);
    expect(container.textContent).toContain('They reset in 2 hours.');
  });

  it('shows the balance left when the provider gave one', () => {
    working('pollinations', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{
      errorCategory: 'credit_exhausted', provider: 'pollinations', model: 'm', quota: { kind: 'balance', remaining: 0.5, unit: 'pollen' },
    }} />);
    expect(container.textContent).toContain(limits('balance', { remaining: 0.5 }));
  });

  it('shows the raw message only when it has nothing of its own to say', () => {
    render(<StoppedCard live={false} data={{ errorCategory: 'unknown', provider: 'groq', message: 'upstream said xyzzy' }} />);
    expect(container.textContent).toContain('upstream said xyzzy');
    render(<StoppedCard live={false} data={{ errorCategory: 'rate_limited', provider: 'groq', message: 'upstream said xyzzy' }} />);
    expect(container.textContent).not.toContain('upstream said xyzzy');
  });
});

describe('LimitNotice — wording', () => {
  it('treats exactly 500 as the provider not answering', () => {
    render(<LimitNotice data={{ kind: 'retrying', provider: 'groq', status: 500 }} />);
    expect(container.textContent).toContain(limits('retryingServer', { provider: 'Groq' }));
  });

  it('says the model was unavailable rather than busy when that was the reason', () => {
    render(<LimitNotice data={{ kind: 'switched', provider: 'openrouter', fromModel: 'a/x:free', toModel: 'b/y:free', reason: 'unavailable' }} />);
    expect(container.textContent).toContain('is not available right now');
  });
});
