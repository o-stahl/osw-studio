import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock model-catalog so activateProviderAsGlobalDefault's non-built-in path does not
// hit the network; control exactly which model ids a provider "serves".
const loadProviderModels = vi.fn(async (_provider: string) => [{ id: 'model-a' }, { id: 'model-b' }]);
vi.mock('@/lib/llm/models/model-catalog', () => ({
  loadProviderModels: (p: string) => loadProviderModels(p),
}));

const fetchProviderStatus = vi.fn(async (_p: string, _k: string) => ({ quota: { kind: 'none' } }) as unknown);
vi.mock('@/lib/llm/provider-status', () => ({
  fetchProviderStatus: (p: string, k: string) => fetchProviderStatus(p, k),
}));

import { configManager } from '@/lib/config/storage';
import { activateProviderAsGlobalDefault, fitModelToAccount } from '@/lib/llm/models/global-auto-assign';

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
  loadProviderModels.mockClear();
  // Seed the editable "default" template (agent -> openrouter, no key present).
  configManager.migrateModels();
  configManager.setDefaultTemplateId('default');
});
afterEach(() => vi.unstubAllGlobals());

describe('activateProviderAsGlobalDefault', () => {
  it('connecting openrouter activates the or-recommended built-in globally (no model load)', async () => {
    await activateProviderAsGlobalDefault('openrouter');
    expect(configManager.getDefaultTemplateId()).toBe('or-recommended');
    expect(loadProviderModels).not.toHaveBeenCalled();
    // The working selection (effective model) must also reflect the activated provider.
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
  });

  it('connecting huggingface activates the hf-recommended built-in globally (no model load)', async () => {
    await activateProviderAsGlobalDefault('huggingface');
    expect(configManager.getDefaultTemplateId()).toBe('hf-recommended');
    expect(loadProviderModels).not.toHaveBeenCalled();
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'huggingface', model: 'deepseek-ai/DeepSeek-V4-Flash' });
  });

  it('connecting a provider without a built-in recommended rewrites+activates default', async () => {
    await activateProviderAsGlobalDefault('groq');
    expect(loadProviderModels).toHaveBeenCalledWith('groq');
    expect(configManager.getDefaultTemplateId()).toBe('default');
    const agent = configManager.getModelTemplate('default')!.assignment.agent;
    expect(agent.provider).toBe('groq');
    expect(agent.model).toBe('model-a'); // pickModelForProvider -> first available
    // Working selection reflects the rewritten default agent too.
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'groq', model: 'model-a' });
  });

  it('does not write when the provider serves no models (empty-model bail)', async () => {
    // opencode-go has no built-in recommended and getDefaultModel('opencode-go') === '',
    // so with zero available models pickModelForProvider yields '' and the helper must bail.
    loadProviderModels.mockResolvedValueOnce([]);
    const before = configManager.getModelTemplate('default')!.assignment.agent;
    const setDefault = vi.spyOn(configManager, 'setDefaultTemplateId');
    const save = vi.spyOn(configManager, 'saveModelTemplate');

    await activateProviderAsGlobalDefault('opencode-go');

    expect(setDefault).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(configManager.getModelTemplate('default')!.assignment.agent).toEqual(before);
    setDefault.mockRestore();
    save.mockRestore();
  });

  it('does not write when readiness flips during the awaited model load (async re-check bail)', async () => {
    // Simulate a concurrent connect completing mid-load: keying openrouter (default's agent
    // provider) makes shouldAutoAssignAgent() false by the time loadProviderModels resolves.
    loadProviderModels.mockImplementationOnce(async () => {
      configManager.setProviderApiKey('openrouter', 'sk-mid-flight');
      return [{ id: 'model-a' }];
    });
    const before = configManager.getModelTemplate('default')!.assignment.agent;
    const setDefault = vi.spyOn(configManager, 'setDefaultTemplateId');
    const save = vi.spyOn(configManager, 'saveModelTemplate');

    await activateProviderAsGlobalDefault('groq');

    expect(setDefault).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(configManager.getModelTemplate('default')!.assignment.agent).toEqual(before);
    setDefault.mockRestore();
    save.mockRestore();
  });
});

describe('fitModelToAccount', () => {
  beforeEach(() => {
    fetchProviderStatus.mockClear();
    configManager.setProviderApiKey('openrouter', 'sk-or-test');
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' } });
  });

  it('gives a free-only OpenRouter account "Free models" instead of a paid model', async () => {
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: true });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'openrouter', model: 'osw/free-models' });
  });

  it('leaves an account that has bought credit on its model', async () => {
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: false });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('leaves a free model alone', async () => {
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' } });
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: true });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent.model).toBe('google/gemma-4-31b-it:free');
  });

  it('ignores a connect for a provider the working model is not on', async () => {
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'groq', model: 'llama-x' } });
    fetchProviderStatus.mockResolvedValue({ quota: { kind: 'none' }, freeOnly: true });
    try {
      await fitModelToAccount('openrouter');
    } finally {
      fetchProviderStatus.mockResolvedValue({ quota: { kind: 'none' } });
    }
    expect(fetchProviderStatus).not.toHaveBeenCalled();
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'groq', model: 'llama-x' });
  });

  it('leaves the model alone when OpenRouter does not say whether the account is free-only', async () => {
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' } });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('keeps a picked model the list shows as free, whatever its id', async () => {
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'openrouter', model: 'vendor/zero-priced' } });
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: true });
    loadProviderModels.mockResolvedValueOnce([{ id: 'vendor/zero-priced', pricing: { input: 0, output: 0 } } as never]);
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent.model).toBe('vendor/zero-priced');
  });

  it('does not overwrite a selection that moved while the model list loaded', async () => {
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: true });
    loadProviderModels.mockImplementationOnce(async () => {
      configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'openrouter', model: 'picked/meanwhile' } });
      return [{ id: 'deepseek/deepseek-v4-flash' }];
    });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment().agent.model).toBe('picked/meanwhile');
  });

  it('changes only the agent model, keeping the rest of the selection', async () => {
    const imageGen = { provider: 'openai', model: 'gpt-image-1' };
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), imageGen } as never);
    fetchProviderStatus.mockResolvedValueOnce({ quota: { kind: 'none' }, freeOnly: true });
    await fitModelToAccount('openrouter');
    expect(configManager.getActiveAssignment()).toMatchObject({ agent: { provider: 'openrouter', model: 'osw/free-models' }, imageGen });
  });

  it('ignores a provider that has no "Free models" entry', async () => {
    configManager.setProviderApiKey('groq', 'gsk_test');
    configManager.setActiveAssignment({ ...configManager.getActiveAssignment(), agent: { provider: 'groq', model: 'llama-x' } });
    fetchProviderStatus.mockResolvedValue({ quota: { kind: 'none' }, freeOnly: true });
    try {
      await fitModelToAccount('groq');
    } finally {
      fetchProviderStatus.mockResolvedValue({ quota: { kind: 'none' } });
    }
    expect(fetchProviderStatus).not.toHaveBeenCalled();
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'groq', model: 'llama-x' });
  });
});
