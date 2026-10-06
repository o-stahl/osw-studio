import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '@/app/api/models/route';
import type { NextRequest } from 'next/server';

/**
 * Route-level guard wiring for /api/models. This locks the behavior that regressed once:
 * the SSRF guard must apply to user-supplied custom endpoints but NOT to built-in local
 * providers (which legitimately point at localhost). A guard rejection falls through to
 * `{ models: [] }`, so the meaningful signal is whether the outbound fetch is reached.
 */

function makeReq(body: unknown): NextRequest {
  return { json: async () => body, headers: { get: () => null } } as unknown as NextRequest;
}

function jsonResponse(obj: unknown): Response {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, json: async () => obj, text: async () => text } as unknown as Response;
}

function codexToken(accountId = 'acct-123'): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `header.${payload}.signature`;
}

let fetchMock: ReturnType<typeof vi.fn>;

const CODEX_FIXTURE = {
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Later model',
      context_window: 200000,
      input_modalities: ['text'],
      visibility: 'list',
      priority: 2,
    },
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      description: 'First model',
      max_context_window: 300000,
      input_modalities: ['text', 'image'],
      visibility: 'list',
      priority: 1,
    },
    { slug: 'gpt-5.4', visibility: 'hide', priority: 0 },
    { slug: 'gpt-5.2', visibility: 'list', priority: 4 },
  ],
};

const MODELS_DEV_FIXTURE = {
  'opencode-go': {
    models: {
      'glm-5.2': {
        id: 'glm-5.2',
        limit: { context: 1000000, output: 131072 },
        modalities: { input: ['text'] },
        status: 'active',
      },
      'minimax-m3': {
        id: 'minimax-m3',
        limit: { context: 1000000, output: 131072 },
        modalities: { input: ['text', 'image', 'video'] },
        status: 'active',
      },
      'glm-5': {
        id: 'glm-5',
        limit: { context: 202752 },
        modalities: { input: ['text'] },
        status: 'deprecated',
      },
    },
  },
};

beforeEach(() => {
  fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('127.0.0.1:11434/api/show')) return jsonResponse({ model_info: { 'llama.context_length': 131072 } });
    if (u.includes('127.0.0.1:11434')) return jsonResponse({ models: [{ name: 'llama3' }] });
    if (u.includes('api.example.com')) return jsonResponse({ data: [{ id: 'gpt-x' }] });
    if (u.includes('/backend-api/codex/models')) return jsonResponse(CODEX_FIXTURE);
    if (u.includes('models.dev')) return jsonResponse(MODELS_DEV_FIXTURE);
    if (u.includes('gen.pollinations.ai/v1/models')) return jsonResponse({ data: [
      { id: 'openai/gpt-5.4-nano', category: 'text', community: false, tools: true, supported_endpoints: ['/v1/chat/completions'] },
      { id: 'community/someone/proxy', category: 'text', community: true, tools: true },
      { id: 'jaredpalmer/kev-4b', category: 'text', community: false, supported_endpoints: ['/alpha/decisions', '/v1/chat/completions'] },
      { id: 'black-forest-labs/flux.1-schnell', category: 'image', community: false, output_modalities: ['image'], input_modalities: ['text'], supported_endpoints: ['/v1/images/generations'] },
      { id: 'community/someone/image', category: 'image', community: true, output_modalities: ['image'], supported_endpoints: ['/v1/images/generations'] },
      { id: 'some/video', category: 'video', community: false, output_modalities: ['video'] },
    ] });
    if (u.includes('generativelanguage.googleapis.com')) return jsonResponse({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 },
      { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
    ] });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/models SSRF guard wiring', () => {
  it('rejects a custom provider on a private/loopback URL — no outbound fetch is made', async () => {
    const res = await POST(makeReq({ provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'http://169.254.169.254/v1' }));
    const data = await res.json();
    expect(data.models).toEqual([]);          // guard threw → outer catch → empty
    expect(fetchMock).not.toHaveBeenCalled();  // never reached the endpoint
  });

  it('allows a custom provider on a public URL — fetches that endpoint', async () => {
    const res = await POST(makeReq({ provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1' }));
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.anything());
    expect(data.models).toContain('gpt-x');
  });

  it('does NOT guard built-in local providers — Ollama on localhost still works (regression)', async () => {
    const res = await POST(makeReq({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1' }));
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags');
    // Each model carries its trained limit; the loaded window is the provider setting.
    expect(data.models).toEqual([{ id: 'llama3', contextLength: 131072 }]);
  });
});

describe('/api/models custom header forwarding', () => {
  const sent = () => fetchMock.mock.calls[0][1].headers as Record<string, string>;

  it('forwards a configured header on the discovery request', async () => {
    await POST(makeReq({
      provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1',
      customHeaders: { 'X-Tenant': 'acme' },
    }));
    expect(sent()['X-Tenant']).toBe('acme');
    expect(sent()['Authorization']).toBe('Bearer sk-x');
  });

  it('sends only the Bearer header when none are configured', async () => {
    await POST(makeReq({ provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1' }));
    expect(sent()).toEqual({ Authorization: 'Bearer sk-x' });
  });

  it('keeps the API key when a configured header also claims Authorization', async () => {
    await POST(makeReq({
      provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1',
      customHeaders: { Authorization: 'Bearer other' },
    }));
    expect(sent()['Authorization']).toBe('Bearer sk-x');
  });

  it('drops reserved and hop-by-hop names supplied by the client', async () => {
    await POST(makeReq({
      provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1',
      customHeaders: { Host: 'evil.example', Connection: 'keep-alive', Cookie: 'a=b', 'X-Tenant': 'acme' },
    }));
    expect(sent()).toEqual({ Authorization: 'Bearer sk-x', 'X-Tenant': 'acme' });
  });

  it('gives the discovery request an abort signal', async () => {
    // A custom endpoint that never answers must not hold the route open indefinitely.
    await POST(makeReq({ provider: 'my-cloud', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1' }));
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('/api/models openai-codex discovery', () => {
  it('fetches the account catalog and preserves its model metadata', async () => {
    const token = codexToken();
    const res = await POST(makeReq({ provider: 'openai-codex', apiKey: token }));
    const data = await res.json();

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/backend-api/codex/models'));
    expect(call?.[0]).toMatch(/\/codex\/models\?client_version=/);
    const headers = (call?.[1] as RequestInit).headers as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('chatgpt-account-id')).toBe('acct-123');

    // 5.2 is excluded by the 5.5/5.6-series gate; 5.4 is hidden by visibility.
    // The local image tiers are appended because Codex does not advertise tools as models.
    expect(data.models.map((m: { id: string }) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-image-2-low',
      'gpt-image-2-medium',
      'gpt-image-2-high',
    ]);
    expect(data.models[0]).toMatchObject({
      name: 'GPT-5.6-Sol',
      description: 'First model',
      contextLength: 300000,
      inputModalities: ['text', 'image'],
      supportsVision: true,
    });
  });

  it('falls back to hardcoded codex models when the catalog returns 401 or 500', async () => {
    for (const status of [401, 500]) {
      fetchMock.mockImplementationOnce(async () => ({ ok: false, status } as unknown as Response));
      const res = await POST(makeReq({ provider: 'openai-codex', apiKey: codexToken() }));
      const data = await res.json();
      const ids = data.models.map((m: { id: string }) => (typeof m === 'string' ? m : m.id));
      expect(ids).toContain('gpt-5.6-sol');
      expect(ids).toContain('gpt-5.5');
    }
  });
});

describe('/api/models opencode-go discovery', () => {
  it('returns active models from models.dev and excludes deprecated ones', async () => {
    const res = await POST(makeReq({ provider: 'opencode-go', apiKey: 'sk-x' }));
    const data = await res.json();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('models.dev'));
    const ids = data.models.map((m: { id: string }) => m.id);
    expect(ids).toContain('glm-5.2');
    expect(ids).toContain('minimax-m3');
    expect(ids).not.toContain('glm-5');
  });

  it('maps contextLength and inputModalities from models.dev fixture', async () => {
    const res = await POST(makeReq({ provider: 'opencode-go', apiKey: 'sk-x' }));
    const data = await res.json();
    const glm = data.models.find((m: { id: string }) => m.id === 'glm-5.2');
    expect(glm).toBeDefined();
    expect(glm.contextLength).toBe(1000000);
    expect(glm.inputModalities).toEqual(['text']);
    const minimax = data.models.find((m: { id: string }) => m.id === 'minimax-m3');
    expect(minimax).toBeDefined();
    expect(minimax.contextLength).toBe(1000000);
    expect(minimax.inputModalities).toEqual(['text', 'image', 'video']);
  });

  it('returns empty models array gracefully when models.dev fetch fails', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503 } as unknown as Response));
    const res = await POST(makeReq({ provider: 'opencode-go', apiKey: 'sk-x' }));
    const data = await res.json();
    expect(data.models).toEqual([]);
  });
});

describe('/api/models Gemini discovery', () => {
  it('lists only chat-capable Gemini models', async () => {
    const res = await POST(makeReq({ provider: 'gemini', apiKey: 'AIza-x' }));
    const data = await res.json();
    // Image, speech and embedding models answer generateContent or not at all, but none of
    // them can run a task; Gemma is not Gemini.
    expect(data.models.map((m: { id: string }) => m.id)).toEqual(['gemini-3.8-flash']);
    expect(data.models[0].contextLength).toBe(1048576);
  });
});

describe('/api/models Pollinations discovery', () => {
  it('lists Pollinations\' own text and image models, without community or decision-only models', async () => {
    const res = await POST(makeReq({ provider: 'pollinations', apiKey: 'sk_x' }));
    const data = await res.json();
    expect(data.models.map((m: { id: string }) => m.id)).toEqual(['openai/gpt-5.4-nano', 'black-forest-labs/flux.1-schnell']);
    expect(data.models[1].outputModalities).toEqual(['image']);
  });
});


describe('/api/models Pollinations model details', () => {
  it('carries health and tool support, and lists only images made through /v1/images/generations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { id: 'healthy-tools', category: 'text', tools: true, health: { status: 'degraded' } },
      { id: 'no-tools', category: 'text', tools: false, health: { status: 'whatever' } },
      { id: 'img-ok', category: 'image', output_modalities: ['image'], supported_endpoints: ['/v1/images/generations'] },
      { id: 'img-chat-only', category: 'image', output_modalities: ['image'], supported_endpoints: ['/v1/chat/completions'] },
    ])));
    const data = await (await POST(makeReq({ provider: 'pollinations', apiKey: 'sk_x' }))).json();
    expect(data.models.map((m: { id: string }) => m.id)).toEqual(['healthy-tools', 'no-tools', 'img-ok']);
    expect(data.models[0]).toMatchObject({ supportsFunctions: true, health: 'degraded' });
    expect(data.models[1].supportsFunctions).toBe(false);
    expect(data.models[1]).not.toHaveProperty('health');
  });
});

describe('/api/models Vercel discovery', () => {
  it('lists language models with per-million pricing, tags and free flag', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [
      { id: 'openai/gpt-x', name: 'GPT X', type: 'language', context_window: 128000, max_tokens: 16000,
        tags: ['tool-use', 'reasoning'], modalities: { input: ['text', 'image'] }, pricing: { input: '0.000002', output: '0.000008' } },
      { id: 'free/small', type: 'language', tags: ['free'] },
      { id: 'openai/embed', type: 'embedding', pricing: { input: '0.0000001', output: '0' } },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const data = await (await POST(makeReq({ provider: 'vercel', apiKey: 'vck_x' }))).json();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://ai-gateway.vercel.sh/v1/models');
    expect(data.models.map((m: { id: string }) => m.id)).toEqual(['openai/gpt-x', 'free/small']);
    expect(data.models[0]).toMatchObject({
      name: 'GPT X', contextLength: 128000, maxTokens: 16000, supportsFunctions: true, supportsReasoning: true,
      inputModalities: ['text', 'image'],
    });
    expect(data.models[0].pricing.input).toBeCloseTo(2);
    expect(data.models[0].pricing.output).toBeCloseTo(8);
    expect(data.models[0]).not.toHaveProperty('free');
    expect(data.models[1]).toMatchObject({ name: 'free/small', free: true, supportsFunctions: false });
    expect(data.models[1]).not.toHaveProperty('pricing');
  });
});
