import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * The route attaches the provider error's class (`code`, and the timing when the provider gave
 * one) to its error body, which is what the client decides on; and an unresolved "Free models"
 * id goes to OpenRouter's own free router.
 */

vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function makeReq(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers(), signal: new AbortController().signal } as unknown as NextRequest;
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route');
  return POST(makeReq({ messages: [{ role: 'user', content: 'hi' }], stream: false, ...body }));
}

function upstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/generate — "Free models" left unresolved', () => {
  it('sends OpenRouter\'s free router instead of the placeholder id', async () => {
    const fetchMock = upstream(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'osw/free-models' });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe('openrouter/free');
  });
});

describe('POST /api/generate — error class on the error body', () => {
  it('marks an authentication failure', async () => {
    upstream(401, { error: { message: 'No auth credentials found' } });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'auth', error: expect.stringMatching(/authentication failed/) });
  });

  it('passes on what the provider said beside the key hint', async () => {
    upstream(401, { error: { message: 'User not found.' } });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b' });
    await expect(res.json()).resolves.toMatchObject({ code: 'auth', error: expect.stringContaining('User not found.') });
  });

  it('marks an OpenRouter 403 as a refused request and passes on its reason, not a key hint', async () => {
    // OpenRouter's documented moderation body: a 403 whose metadata names the reasons.
    upstream(403, { error: { message: 'm requires moderation on OpenAI. Your input was flagged for "harassment"', metadata: { reasons: ['harassment'], flagged_input: 'x', provider_name: 'OpenAI', model_slug: 'm' } } });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'blocked' });
    expect(body.error).toContain('Your input was flagged');
    expect(body.error).toContain('(harassment)');
    expect(body.error).not.toMatch(/authentication failed|API key/);
  });

  it('marks spent OpenRouter credit, with the reset the provider gave', async () => {
    upstream(402, { error: { message: 'Insufficient credits' } }, { 'X-RateLimit-Reset': '1900000000000' });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b' });
    await expect(res.json()).resolves.toMatchObject({ code: 'credit_exhausted', resetAt: 1900000000000, error: expect.stringMatching(/credit limit/) });
  });

  it('reads OpenRouter\'s limit source from the error metadata: a shared pool is one busy model', async () => {
    upstream(429, { error: { message: 'Rate limit exceeded', metadata: { limit_source: 'upstream_provider_shared_pool' } } }, { 'Retry-After': '7' });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b:free' });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_busy', retryAfterMs: 7000 });
  });

  it('classifies an error that reaches the generic message', async () => {
    upstream(400, { error: { message: 'Prompt is too long for this model' } });
    const res = await post({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'a/b' });
    await expect(res.json()).resolves.toMatchObject({ code: 'context_too_long', error: expect.stringMatching(/API error: Prompt is too long/) });
  });

  it('classifies a Gemini quota by its QuotaFailure details', async () => {
    upstream(429, { error: { message: 'Quota exceeded', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    ] } });
    const res = await post({ provider: 'gemini', apiKey: 'AIza-x', model: 'gemini-3.8-flash' });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_busy', error: 'Google Gemini API error: Quota exceeded' });
  });

  it('falls back to the general classification for a Gemini error without details', async () => {
    upstream(403, { error: { message: 'API key not valid' } });
    const res = await post({ provider: 'gemini', apiKey: 'AIza-x', model: 'gemini-3.8-flash' });
    await expect(res.json()).resolves.toMatchObject({ code: 'auth', error: 'Google Gemini API error: API key not valid' });
  });
});
