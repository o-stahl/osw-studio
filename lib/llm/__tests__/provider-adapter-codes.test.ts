import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OswsProviderAdapter, ProviderApiError, type ProviderAdapterConfig } from '../provider-adapter';
import type { Message } from '../core/types';

vi.mock('@/lib/api/backend-status', () => ({ apiFetch: vi.fn() }));
vi.mock('../models-dev', () => ({ ensureModelsDevPricing: vi.fn(async () => {}) }));
vi.mock('../models-api', () => ({ fetchAvailableModels: vi.fn(async () => []) }));
vi.mock('../pricing-cache', () => ({
  registerOpenRouterPricingFromApi: vi.fn(),
  registerPricingFromProviderModels: vi.fn(),
}));

import { apiFetch } from '@/lib/api/backend-status';

const messages: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
];

let onEvent: ReturnType<typeof vi.fn>;

function adapter(provider = 'openrouter'): OswsProviderAdapter {
  onEvent = vi.fn();
  const config: ProviderAdapterConfig = {
    getProviderConfig: () => ({ provider, apiKey: 'k', model: 'm', baseUrl: undefined }),
    getApiUrl: () => 'http://localhost/api/generate',
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => ({}),
    getCachedModels: () => null,
    progress: { onEvent },
  };
  return new OswsProviderAdapter(config);
}

/** A fresh error response on every fetch; `Retry-After: 0` keeps the retry loop instant. */
function respondWith(status: number, body: unknown) {
  vi.mocked(apiFetch).mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Retry-After': '0' } }));
}

function sse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function failure(provider = 'openrouter'): Promise<ProviderApiError> {
  const err = await adapter(provider).call({ messages }).then(() => null, (e) => e);
  expect(err).toBeInstanceOf(ProviderApiError);
  return err as ProviderApiError;
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the code /api/generate attaches to an error', () => {
  // On a 400 with wording no keyword matches, the fallback would say `invalid_request`; each code
  // must instead become its own category.
  it.each([
    ['rate_limited', 'rate_limited'],
    ['model_busy', 'model_busy'],
    ['daily_limit', 'daily_limit'],
    ['credit_exhausted', 'credit_exhausted'],
    ['auth', 'auth_expired'],
    ['model_unavailable', 'model_not_found'],
    ['overloaded', 'server_error'],
    ['tool_unsupported', 'tool_not_supported'],
    ['context_too_long', 'context_too_long'],
  ])('reads %s as the %s category, whatever the wording', async (code, category) => {
    respondWith(400, { error: 'something went wrong', code });
    expect((await failure()).errorCategory).toBe(category);
  });

  it('falls back to the wording only when there is no code', async () => {
    respondWith(400, { error: 'something went wrong' });
    expect((await failure()).errorCategory).toBe('invalid_request');
  });

  it('carries the timing the body gives into the error', async () => {
    respondWith(400, { error: 'spent', code: 'daily_limit', retryAfterMs: 5000, resetAt: 1_800_000_000_000 });
    expect((await failure()).timing).toEqual({ retryAfterMs: 5000, resetAt: 1_800_000_000_000 });
  });
});

describe('a 429 without a code, read from its wording', () => {
  it('is a wait when it says rate limit, even with "exceeded" in it', async () => {
    respondWith(429, { error: 'Rate limit exceeded' });
    expect((await failure('custom')).errorCategory).toBe('rate_limited');
  });

  it('is a wait when it says temporarily, even with "quota" in it', async () => {
    respondWith(429, { error: 'Quota temporarily unavailable' });
    expect((await failure('custom')).errorCategory).toBe('rate_limited');
  });

  it('is spent credit when it says so with no rate wording', async () => {
    respondWith(429, { error: 'Monthly quota exceeded' });
    expect((await failure('custom')).errorCategory).toBe('credit_exhausted');
  });
});

describe('retrying a 429', () => {
  it.each(['daily_limit', 'credit_exhausted', 'model_busy'])('does not wait on %s: one request, no retry', async (code) => {
    respondWith(429, { error: 'no', code });
    await failure();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith('retry', expect.anything());
  });

  it('still retries a plain rate limit, naming the provider in the retry event', async () => {
    respondWith(429, { error: 'slow down', code: 'rate_limited' });
    await failure();
    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(onEvent).toHaveBeenCalledWith('retry', expect.objectContaining({ provider: 'openrouter', attempt: 1 }));
  });
});

describe('an error relayed inside the stream', () => {
  it('reads a 429 that names the upstream limit as a busy model', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => sse([
      { error: { code: 429, message: 'qwen/qwen3:free is temporarily rate-limited upstream. Please retry shortly.' } },
    ]));
    const err = await failure();
    expect(err.status).toBe(429);
    expect(err.errorCategory).toBe('model_busy');
  });

  it("reads a relayed 403 by OpenRouter's metadata: a refusal of what was sent is not the model refusing the app", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => sse([
      { error: { code: 403, message: 'Provider returned error', metadata: { error_type: 'refusal' } }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] },
    ]));
    expect((await failure()).errorCategory).toBe('blocked');
    vi.mocked(apiFetch).mockImplementation(async () => sse([
      { error: { code: 403, message: 'm:free is only available on agentic harnesses.' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] },
    ]));
    expect((await failure()).errorCategory).toBe('model_refused');
  });

  it('leaves any other relayed error as a midstream error', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => sse([{ error: { code: 500, message: 'upstream exploded' } }]));
    expect((await failure()).errorCategory).toBe('midstream_error');
  });
});
