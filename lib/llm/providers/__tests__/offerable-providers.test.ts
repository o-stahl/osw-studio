import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOfferableProviders } from '@/lib/llm/providers/registry';
import { saveCustomProvider, removeCustomProvider } from '@/lib/llm/providers/custom-providers';

function stubBrowserStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {} as unknown as Window);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
}

const customCfg = {
  id: 'my-custom', name: 'My Custom', description: '', apiKeyRequired: true,
  baseUrl: 'https://example.com/v1', supportsModelDiscovery: true,
  supportsFunctions: true, supportsStreaming: true,
};

beforeEach(stubBrowserStorage);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const offeredIds = () => getOfferableProviders().map((p) => p.id);

describe('getOfferableProviders', () => {
  it('offers local and custom providers on a standalone deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', '');
    saveCustomProvider('my-custom', customCfg);
    const ids = getOfferableProviders().map((p) => p.id);
    expect(ids).toContain('ollama');     // local built-in
    expect(ids).toContain('my-custom');  // custom endpoint
    removeCustomProvider('my-custom');
  });

  it('excludes local providers on the managed gateway but keeps cloud + custom', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', 'https://gateway.example.com');
    saveCustomProvider('my-custom', customCfg);
    const ids = getOfferableProviders().map((p) => p.id);
    expect(ids).not.toContain('ollama');
    expect(ids).not.toContain('lmstudio');
    expect(ids).toContain('my-custom');   // custom endpoints allowed (external-only)
    expect(ids).toContain('openrouter');  // cloud providers remain
    removeCustomProvider('my-custom');
  });

  it('leaves out the free allowance on a git clone and on a self-hosted server', () => {
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', '');
    expect(offeredIds()).not.toContain('osws');
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    expect(offeredIds()).not.toContain('osws');
  });

  it('offers the free allowance on the demo', () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.oswstudio.com');
    expect(offeredIds()).toContain('osws');
  });

  it('offers the free allowance on a hosted instance', () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubEnv('NEXT_PUBLIC_GATEWAY_URL', 'https://gateway.example.com');
    expect(offeredIds()).toContain('osws');
  });
});
