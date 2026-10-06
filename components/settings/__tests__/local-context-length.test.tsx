// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The context-length field on a local provider: shows the stored value, saves digits as a
 * number, clears the setting when emptied, and tells the user whether OSW Studio applies
 * the value (Ollama) or they have to match it on the server (the others).
 */

const mocks = vi.hoisted(() => ({
  stored: undefined as number | undefined,
  setLocalContextLength: vi.fn(),
}));

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getLocalContextLength: () => mocks.stored,
    setLocalContextLength: mocks.setLocalContextLength,
  },
}));

import { LocalContextLength } from '@/components/settings/local-context-length';
import { DEFAULT_LOCAL_CONTEXT_LENGTH } from '@/lib/llm/local-context';
import en from '@/messages/en.json';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import type { ProviderId } from '@/lib/llm/providers/types';

const localContext = en.settings.localContext;

let container: HTMLDivElement;
let root: Root;

function mount(providerId: ProviderId) {
  act(() => { root.render(withMessages(<LocalContextLength providerId={providerId} />)); });
}

function input(): HTMLInputElement {
  return container.querySelector('input')!;
}

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.stored = undefined;
  mocks.setLocalContextLength.mockReset();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('LocalContextLength', () => {
  it('shows the default as a placeholder and the stored value when there is one', () => {
    mount('ollama');
    expect(input().value).toBe('');
    expect(input().placeholder).toBe(String(DEFAULT_LOCAL_CONTEXT_LENGTH));

    act(() => { root.unmount(); });
    root = createRoot(container);
    mocks.stored = 65536;
    mount('ollama');
    expect(input().value).toBe('65536');
  });

  it('saves typed digits as a number and drops anything else', () => {
    mount('ollama');

    type('64k');

    expect(input().value).toBe('64');
    expect(mocks.setLocalContextLength).toHaveBeenLastCalledWith('ollama', 64);
  });

  it('clears the setting when the field is emptied', () => {
    mocks.stored = 65536;
    mount('ollama');

    type('');

    expect(mocks.setLocalContextLength).toHaveBeenLastCalledWith('ollama', undefined);
  });

  it('says the value is applied for Ollama and must be matched for the others', () => {
    mount('ollama');
    const ollamaText = container.textContent ?? '';
    expect(ollamaText).toContain(localContext.ollama);

    act(() => { root.unmount(); });
    root = createRoot(container);
    mount('llamacpp');
    const llamaText = container.textContent ?? '';
    expect(llamaText).toContain(localContext.llamacpp);
    // The providers that cannot take the value get one more sentence than Ollama does.
    expect(llamaText.length - localContext.llamacpp.length).toBeGreaterThan(ollamaText.length - localContext.ollama.length);
  });

  it.each(['lmstudio', 'llamacpp', 'meshllm'] as const)('gives %s its own instructions', (id) => {
    mount(id);
    expect(container.textContent).toContain(localContext[id]);
  });
});
