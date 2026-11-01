import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configManager } from '@/lib/config/storage';
import { activateProviderAsGlobalDefault, reconcileActiveProviderIfConnected, shouldTakeOverAgent } from '@/lib/llm/models/global-auto-assign';
import { isProjectProviderReady } from '@/lib/llm/models/project-assignment';
import { getConnectedProviders, isProviderConnected } from '@/lib/llm/providers/connection-status';
import { checkAllowance, resetAllowanceStatus } from '@/lib/inference/allowance-status';
import type { ModelTemplate } from '@/lib/llm/models/assignment';
import type { ProviderId } from '@/lib/llm/providers/types';

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

function seedGlobalTemplate(agentProvider: ProviderId, agentModel: string): void {
  const tpl: ModelTemplate = {
    id: 'tpl1',
    name: 'T',
    builtin: false,
    assignment: {
      agent: { provider: agentProvider, model: agentModel },
      imageGen: null,
      voiceInput: null,
      autoCompact: false,
      compactLimit: null,
    },
  };
  configManager.saveModelTemplate(tpl);
  configManager.setDefaultTemplateId('tpl1');
}

describe('reconcileActiveProviderIfConnected', () => {
  it('repoints an unready active agent onto a genuinely connected provider (the issue #17 case)', async () => {
    // Active agent points at a keyless provider (as a pre-global migration can leave it)...
    seedGlobalTemplate('anthropic', 'claude-x');
    // ...while another provider IS actually connected.
    configManager.setProviderApiKey('openrouter', 'sk-test');
    expect(isProjectProviderReady()).toBe(false);

    await reconcileActiveProviderIfConnected();

    expect(isProjectProviderReady()).toBe(true);
  });

  it('prefers the globally selected provider when it is connected', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    configManager.setProviderApiKey('openrouter', 'sk-test');
    configManager.setSelectedProvider('openrouter');

    await reconcileActiveProviderIfConnected();

    expect(configManager.getSelectedProvider()).toBe('openrouter');
    expect(isProjectProviderReady()).toBe(true);
  });

  it('is a no-op for a genuine new user with nothing connected', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    expect(isProjectProviderReady()).toBe(false);

    await reconcileActiveProviderIfConnected();

    // Left as-is so the onboarding UI (HF sign-in button) still shows.
    expect(isProjectProviderReady()).toBe(false);
  });

  it('does not touch an already-ready active agent', async () => {
    configManager.setProviderApiKey('anthropic', 'sk-test');
    seedGlobalTemplate('anthropic', 'claude-x');
    configManager.setDefaultTemplateId('tpl1');

    await reconcileActiveProviderIfConnected();

    expect(configManager.getDefaultTemplateId()).toBe('tpl1');
  });
});

describe('the free allowance as the working model', () => {
  beforeEach(() => {
    process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
    // As the app does on load: a provider without a Recommended template is written into Default.
    configManager.migrateModels();
  });
  afterEach(() => {
    delete process.env.DEMO_GATEWAY_URL;
    resetAllowanceStatus();
  });

  /** The allowance's status check answers as the app server would. */
  async function checked(available: boolean) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ available }), { status: 200 }));
    await checkAllowance({ force: true });
  }

  it('gives a new visitor on the demo the allowance, so the first message needs no setup', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    await reconcileActiveProviderIfConnected();
    expect(configManager.getActiveAssignment().agent).toEqual({ provider: 'osws', model: 'osws/agent' });
    expect(isProjectProviderReady()).toBe(true);
  });

  it('prefers a provider the person connected over the allowance', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    configManager.setProviderApiKey('sambanova', 'sn-test');
    // SambaNova sorts after "OSW Studio", so the first connected provider is the allowance and only the preference passes it over.
    expect(getConnectedProviders()[0]).toBe('osws');
    await reconcileActiveProviderIfConnected();
    expect(configManager.getActiveAssignment().agent.provider).toBe('sambanova');
  });

  it('hands over to a provider connected later, and leaves a working choice of another provider alone', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    await reconcileActiveProviderIfConnected();
    expect(shouldTakeOverAgent('osws')).toBe(false);
    expect(shouldTakeOverAgent('groq')).toBe(true);

    configManager.setProviderApiKey('groq', 'gsk-test');
    await activateProviderAsGlobalDefault('groq');
    expect(configManager.getActiveAssignment().agent.provider).toBe('groq');
    expect(shouldTakeOverAgent('openrouter')).toBe(false);
  });

  it('is ready only while its status check passes, and gives way to any provider connected meanwhile', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    await reconcileActiveProviderIfConnected();
    await checked(true);
    expect(isProjectProviderReady()).toBe(true);

    await checked(false);
    expect(isProviderConnected('osws')).toBe(false);
    expect(isProjectProviderReady()).toBe(false);
    expect(shouldTakeOverAgent('groq')).toBe(true);
  });

  it('is not given to a new visitor while its status check fails', async () => {
    seedGlobalTemplate('anthropic', 'claude-x');
    await checked(false);
    await reconcileActiveProviderIfConnected();
    expect(configManager.getActiveAssignment().agent.provider).toBe('anthropic');
  });
});
