// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { createTranslator } from 'next-intl';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import { StoppedCard, LimitNotice } from '../limit-cards';
import { configManager } from '@/lib/config/storage';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(withMessages(node));
  });
}

const button = (label: RegExp) => [...container.querySelectorAll('button')].find((b) => label.test(b.textContent ?? ''));

describe('StoppedCard', () => {
  const working = (provider: string, model: string) =>
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider, model } });

  it('shows the live daily count and offers the other connected provider', () => {
    working('openrouter', 'qwen/qwen3.8-27b:free');
    const onContinue = vi.fn();
    render(
      <StoppedCard
        live
        onContinue={onContinue}
        data={{
          errorCategory: 'daily_limit',
          provider: 'openrouter',
          model: 'qwen/qwen3.8-27b:free',
          quota: { kind: 'daily', used: 1000, limit: 1000, remaining: 0, resetAt: Date.now() + 4 * 3600_000 },
          alternatives: [{ provider: 'gemini', model: 'gemini-3.8-flash' }],
        }}
      />,
    );
    expect(container.textContent).toContain('Today’s free OpenRouter requests are used up');
    expect(container.textContent).toMatch(/1,000 of 1,000 used\. They reset in 4 hours\./);
    expect(container.textContent).not.toContain('$10');
    expect(button(/^Continue$/)).toBeUndefined();
    act(() => button(/Continue with Google Gemini/)!.click());
    expect(onContinue).toHaveBeenCalledWith({ provider: 'gemini', model: 'gemini-3.8-flash' });
  });

  it('notes the $10 step only when the live limit is the free-tier 50', () => {
    working('openrouter', 'osw/free-models');
    render(<StoppedCard live onContinue={() => {}} data={{
      errorCategory: 'daily_limit', provider: 'openrouter', model: 'osw/free-models',
      quota: { kind: 'daily', used: 50, limit: 50, remaining: 0, resetAt: Date.now() + 3600_000 },
    }} />);
    expect(container.textContent).toContain('once you have added $10 of credit');
  });

  it('says nothing numeric when the provider gave no count', () => {
    working('openrouter', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'daily_limit', provider: 'openrouter', model: 'm' }} />);
    expect(container.textContent).toContain('They reset each day.');
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('offers ways to connect when HuggingFace runs out and nothing else is connected', () => {
    working('huggingface', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'credit_exhausted', provider: 'huggingface', model: 'm' }} />);
    expect(container.textContent).toContain('Your free HuggingFace allowance is used up');
    expect(container.textContent).toContain('It renews monthly.');
    expect(container.textContent).toContain('OpenRouter');
    expect(button(/^Continue$/)).toBeUndefined();
  });

  it('suggests "Free models" when a paid OpenRouter model is out of credit, as a choice', () => {
    working('openrouter', 'deepseek/deepseek-v4-flash');
    const onContinue = vi.fn();
    render(<StoppedCard live onContinue={onContinue} data={{
      errorCategory: 'credit_exhausted', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash',
      suggestion: { provider: 'openrouter', model: 'osw/free-models' },
    }} />);
    act(() => button(/Try Free models/)!.click());
    expect(onContinue).toHaveBeenCalledWith({ provider: 'openrouter', model: 'osw/free-models' });
  });

  it('keeps a busy picked model on offer and suggests another beside it', () => {
    working('openrouter', 'x/picked');
    const onContinue = vi.fn();
    render(<StoppedCard live onContinue={onContinue} data={{
      errorCategory: 'model_busy', provider: 'openrouter', model: 'x/picked', canRetrySame: true,
      suggestion: { provider: 'openrouter', model: 'x/other' },
    }} />);
    act(() => button(/^Continue$/)!.click());
    expect(onContinue).toHaveBeenCalledWith();
    expect(button(/Try other/)).toBeDefined();
  });

  it('continues on a model picked after the stop', () => {
    working('openrouter', 'other:free');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'daily_limit', provider: 'openrouter', model: 'qwen/qwen3.8-27b:free' }} />);
    expect(button(/^Continue with other:free$/)).toBeDefined();
  });

  it('offers no plain Continue when a resend cannot succeed', () => {
    working('groq', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'tool_not_supported', provider: 'groq', model: 'm', canRetrySame: false }} />);
    expect(button(/^Continue$/)).toBeUndefined();
  });

  it('words a failure without a provider without naming one', () => {
    working('openrouter', 'm');
    render(<StoppedCard live onContinue={() => {}} data={{ errorCategory: 'unknown', provider: '', model: '' }} />);
    expect(container.textContent).toContain('The request failed');
    expect(container.textContent).not.toContain('The request to');
  });

  it('keeps an earlier stop as history, without actions', () => {
    render(<StoppedCard live={false} onContinue={() => {}} data={{ errorCategory: 'rate_limited', provider: 'groq' }} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('LimitNotice', () => {
  it('says a provider is limiting requests on a 429 and not answering on a 5xx', () => {
    render(<LimitNotice data={{ kind: 'retrying', provider: 'groq', status: 429 }} />);
    expect(container.textContent).toContain('Groq is limiting requests');
    render(<LimitNotice data={{ kind: 'retrying', provider: 'groq', status: 502 }} />);
    expect(container.textContent).toContain('Groq did not answer');
  });

  it('names both models when it moved on', () => {
    render(<LimitNotice data={{ kind: 'switched', provider: 'openrouter', fromModel: 'qwen/qwen3.8-27b:free', toModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', reason: 'busy' }} />);
    const text = container.textContent ?? '';
    expect(text).toContain('qwen3.8-27b:free');
    expect(text).toContain('nemotron-3-ultra-550b-a55b:free');
    // In the order they happened, and as the busy notice rather than the unavailable one.
    const limits = createTranslator({ locale: 'en', messages: en, namespace: 'limits' });
    expect(text).toContain(limits('switchedBusy', { from: 'qwen3.8-27b:free', to: 'nemotron-3-ultra-550b-a55b:free' }));
  });
});
