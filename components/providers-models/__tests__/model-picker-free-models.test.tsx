// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * "Free models" is a selection, not a model, so its developer column cannot name a developer: it
 * lands on whichever free model is available. The column says that it varies, in both the phone and
 * the desktop layout, rather than showing the placeholder id's prefix as if it were a vendor.
 */

vi.mock('@/lib/llm/providers/connection-status', () => ({ getConnectedProviders: () => ['openrouter'] }));
vi.mock('@/lib/llm/models/model-catalog', () => ({
  modelsForSlot: async () => [
    { provider: 'openrouter', model: { id: 'osw/free-models', name: 'Free models' } },
    { provider: 'openrouter', model: { id: 'anthropic/claude-x', name: 'Anthropic: Claude X', contextLength: 200000 } },
  ],
  matchesSlot: () => true,
  loadProviderModels: async () => [],
}));

import { createTranslator } from 'next-intl';
import { ModelPicker } from '../model-picker';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

const models = createTranslator({ locale: 'en', messages: en, namespace: 'models' });

let container: HTMLDivElement;
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

async function mount() {
  await act(async () => {
    root.render(withMessages(<ModelPicker slot="agent" currentValue={null} onPick={() => {}} />));
  });
}

const row = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(name));

describe('the "Free models" row in the model picker', () => {
  it('names its developer as varying, in both layouts, never the placeholder id\'s prefix', async () => {
    await mount();
    const free = row(models('freeModels'));
    expect(free).toBeDefined();
    const layouts = [...free!.children];
    expect(layouts).toHaveLength(2);
    for (const layout of layouts) {
      expect(layout.textContent).toContain(models('freeModelsDeveloper'));
      expect(layout.textContent).not.toContain('osw');
    }
  });

  it('still names the developer of a real model', async () => {
    await mount();
    const claude = row('Claude X');
    expect(claude?.textContent).toContain('anthropic');
    expect(claude?.textContent).not.toContain(models('freeModelsDeveloper'));
  });
});
