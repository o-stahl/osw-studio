import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/llm/models-dev', () => ({
  enrichModelsFromModelsDev: vi.fn(async () => {}),
  loadModelsFromModelsDev: vi.fn(async () => []),
}));
vi.mock('@/lib/llm/models-api', () => ({ fetchAvailableModels: vi.fn(async () => { throw new Error('no network in this test'); }) }));
vi.mock('@/lib/llm/llm-client', () => ({ getAvailableModels: vi.fn(async () => []), normalizeModelEntry: (m: unknown) => m }));

import { configManager } from '@/lib/config/storage';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';

function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { dispatchEvent: () => true } as unknown as Window);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

beforeEach(() => {
  stubBrowserStorage();
  configManager.setProviderApiKey('openrouter', 'sk-or-test');
});
afterEach(() => vi.unstubAllGlobals());

describe('the "Free models" entry in OpenRouter\'s list', () => {
  it('heads the list the provider gave', async () => {
    configManager.setCachedModels('openrouter', [{ id: 'a/model', name: 'A', contextLength: 8000 }]);
    expect((await loadProviderModels('openrouter')).map((m) => m.id)).toEqual(['osw/free-models', 'a/model']);
  });

  it('is not offered on an empty list, where there is nothing to rotate through', async () => {
    configManager.setCachedModels('openrouter', []);
    expect(await loadProviderModels('openrouter')).toEqual([]);
  });

  it('is not added twice when the list already holds it', async () => {
    configManager.setCachedModels('openrouter', [
      { id: 'osw/free-models', name: 'Free models', contextLength: 128000 },
      { id: 'a/model', name: 'A', contextLength: 8000 },
    ]);
    const ids = (await loadProviderModels('openrouter')).map((m) => m.id);
    expect(ids.filter((id) => id === 'osw/free-models')).toHaveLength(1);
  });
});
