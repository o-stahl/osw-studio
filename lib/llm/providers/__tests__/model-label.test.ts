import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configManager } from '@/lib/config/storage';
import { modelLabel } from '../model-label';
import { freeModelsEntry } from '@/lib/llm/suggestions/free-models';

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

beforeEach(stubBrowserStorage);
afterEach(() => vi.unstubAllGlobals());

describe('modelLabel', () => {
  it('uses the listed name without its vendor prefix', () => {
    configManager.setCachedModels('openrouter', [{ id: 'qwen/qwen3.8-27b:free', name: 'Qwen: Qwen3.8 27B (free)', contextLength: 128000 }]);
    expect(modelLabel('openrouter', 'qwen/qwen3.8-27b:free')).toBe('Qwen3.8 27B (free)');
  });

  it('falls back to the id without its vendor when the model is not listed', () => {
    expect(modelLabel('openrouter', 'vendor/some-model')).toBe('some-model');
  });
});

describe('the "Free models" entry', () => {
  it('is offered as a model that takes tools, so the picker does not badge it as unable to', () => {
    expect(freeModelsEntry()).toMatchObject({ supportsFunctions: true, free: true });
  });
});
