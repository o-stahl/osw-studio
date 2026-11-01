import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { PreflightResult } from '@/lib/llm/ollama-preflight';

/**
 * The check answers the same questions a task would hit in order: is Ollama there, is
 * anything pulled, is the chosen model pulled, can it call tools, how much context will
 * it get. Each failing row carries the command that fixes it. `fetch` is stubbed with a
 * small fake Ollama so the rows come from real response shapes, not from the route's own
 * expectations.
 */

type Fake = {
  version?: string;
  models?: string[];
  show?: Record<string, { capabilities: string[]; context?: number }>;
};

function fakeOllama(fake: Fake | 'down') {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (fake === 'down') throw new TypeError('fetch failed');
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/api/version')) return json({ version: fake.version ?? '0.34.1' });
    if (url.endsWith('/api/tags')) return json({ models: (fake.models ?? []).map(name => ({ name })) });
    if (url.endsWith('/api/show')) {
      const { name } = JSON.parse(String(init?.body));
      const entry = fake.show?.[name];
      if (!entry) return json({ error: `model '${name}' not found` }, 404);
      return json({ capabilities: entry.capabilities, model_info: entry.context ? { 'qwen3.context_length': entry.context } : {} });
    }
    return json({}, 404);
  });
}

async function run(body: Record<string, unknown>): Promise<PreflightResult> {
  const { POST } = await import('@/app/api/ollama/preflight/route');
  const res = await POST({ json: async () => body } as unknown as NextRequest);
  return res.json();
}

function byId(result: PreflightResult, id: string) {
  return result.checks.find(c => c.id === id);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('SPACE_ID', '');
  vi.stubEnv('DEMO_GATEWAY_URL', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/ollama/preflight', () => {
  it('passes every row for a pulled, tool-capable model with a large context', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: ['qwen3:4b'], show: { 'qwen3:4b': { capabilities: ['completion', 'tools', 'thinking'], context: 262144 } } }));

    const result = await run({ model: 'qwen3:4b' });

    expect(result.checks.map(c => [c.id, c.ok])).toEqual([
      ['reachable', true], ['models', true], ['model_pulled', true], ['tools', true], ['context', true],
    ]);
    expect(result.version).toBe('0.34.1');
    expect(byId(result, 'context')?.detail).toContain('32,768');
  });

  it('tells the user to start Ollama when nothing answers, and stops there', async () => {
    vi.stubGlobal('fetch', fakeOllama('down'));

    const result = await run({ model: 'qwen3:4b' });

    expect(result.checks).toHaveLength(1);
    expect(byId(result, 'reachable')).toMatchObject({ ok: false, fix: 'ollama serve' });
  });

  it('explains that a hosted instance cannot reach the machine at all', async () => {
    vi.stubEnv('SPACE_ID', 'otst/osw-studio');
    vi.stubGlobal('fetch', fakeOllama('down'));

    const result = await run({ model: 'qwen3:4b' });

    const row = byId(result, 'reachable');
    expect(row).toMatchObject({ ok: false, hosted: true });
    // No command fixes that, so none is offered.
    expect(row?.fix).toBeUndefined();
  });

  it('says the same on the hosted demo, which runs on a server too', async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    vi.stubGlobal('fetch', fakeOllama('down'));

    const result = await run({ model: 'qwen3:4b' });

    expect(byId(result, 'reachable')).toMatchObject({ ok: false, hosted: true });
    expect(byId(result, 'reachable')?.fix).toBeUndefined();
  });

  it('asks for a pull when the selected model is missing', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: ['qwen3:4b'], show: { 'qwen3:4b': { capabilities: ['tools'] } } }));

    const result = await run({ model: 'gpt-oss:20b' });

    expect(byId(result, 'model_pulled')).toMatchObject({ ok: false, fix: 'ollama pull gpt-oss:20b' });
    expect(byId(result, 'tools')).toBeUndefined();
  });

  it('fails the tools row for a model that cannot call tools', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: ['llama2:7b'], show: { 'llama2:7b': { capabilities: ['completion'], context: 4096 } } }));

    const result = await run({ model: 'llama2:7b' });

    expect(byId(result, 'tools')).toMatchObject({ ok: false });
    expect(byId(result, 'tools')?.fix).toMatch(/ollama pull/);
  });

  it('reports the window capped at a model limit below the setting', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: ['small'], show: { small: { capabilities: ['tools'], context: 8192 } } }));

    const result = await run({ model: 'small', contextLength: 65536 });

    // Nothing to fix: the model simply cannot take more.
    expect(byId(result, 'context')).toMatchObject({ ok: true, capped: true });
    expect(byId(result, 'context')?.detail).toContain('8,192');
    expect(byId(result, 'context')?.fix).toBeUndefined();
  });

  it('reports the window from the provider setting', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: ['qwen3:4b'], show: { 'qwen3:4b': { capabilities: ['tools'], context: 262144 } } }));

    const result = await run({ model: 'qwen3:4b', contextLength: 65536 });

    expect(byId(result, 'context')?.detail).toContain('65,536');
    expect(byId(result, 'context')?.capped).toBeUndefined();
  });

  it('reports no models pulled', async () => {
    vi.stubGlobal('fetch', fakeOllama({ models: [] }));

    const result = await run({ model: 'qwen3:4b' });

    expect(byId(result, 'models')).toMatchObject({ ok: false, fix: 'ollama pull qwen3:4b' });
    expect(result.checks).toHaveLength(2);
  });
});
