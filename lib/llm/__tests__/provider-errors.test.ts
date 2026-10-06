import { describe, it, expect } from 'vitest';
import { classifyProviderError, classifyGeminiError, parseRetryAfter, parseResetHeader } from '../provider-errors';

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe('classifyProviderError', () => {
  it('reads an OpenRouter shared upstream pool as one busy model', () => {
    // The body OpenRouter returned for a busy free model, 2026-10-03.
    const result = classifyProviderError({
      status: 429,
      provider: 'openrouter',
      message: '[ModelRun] Provider returned error (qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly)',
      metadata: { provider_name: 'ModelRun', limit_source: 'upstream_provider_shared_pool' },
    });
    expect(result.code).toBe('model_busy');
  });

  it('reads the shared-pool metadata as a busy model whatever the message says', () => {
    const result = classifyProviderError({
      status: 429,
      provider: 'openrouter',
      message: 'Provider returned error',
      metadata: { provider_name: 'ModelRun', limit_source: 'upstream_provider_shared_pool' },
    });
    expect(result.code).toBe('model_busy');
  });

  it('reads the upstream wording as a busy model when a relayed error carries no metadata', () => {
    const result = classifyProviderError({
      status: 429,
      provider: 'openrouter',
      message: 'qwen/qwen3.8-27b:free is temporarily rate-limited upstream. Please retry shortly',
    });
    expect(result.code).toBe('model_busy');
  });

  it('reads the free-models-per-day limit as the daily allowance, with its reset time', () => {
    const result = classifyProviderError({
      status: 429,
      provider: 'openrouter',
      message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
      headers: headers({ 'x-ratelimit-reset': '1791158400000' }),
    });
    expect(result).toEqual({ code: 'daily_limit', resetAt: 1791158400000 });
  });

  it('does not read "rate-limited" as spent credit because it contains "limit"', () => {
    const result = classifyProviderError({ status: 429, provider: 'groq', message: 'You are being rate-limited. Retry after 2s' });
    expect(result.code).toBe('rate_limited');
  });

  it('reads rate wording as a wait even when the message also mentions quota', () => {
    const result = classifyProviderError({ status: 429, provider: 'groq', message: 'Rate limit reached for your quota. Retry after 2s' });
    expect(result.code).toBe('rate_limited');
  });

  it('reads credit wording on a 429 as exhausted credit', () => {
    const result = classifyProviderError({ status: 429, provider: 'sambanova', message: 'Insufficient balance on this account' });
    expect(result.code).toBe('credit_exhausted');
  });

  it('reads 402 as exhausted credit whatever the wording', () => {
    expect(classifyProviderError({ status: 402, provider: 'huggingface', message: 'You have exceeded your monthly included credits' }).code)
      .toBe('credit_exhausted');
  });

  it('treats a Vercel 429 as that model being limited, since its free tier limits per model', () => {
    expect(classifyProviderError({ status: 429, provider: 'vercel', message: 'Rate limit exceeded' }).code).toBe('model_busy');
  });

  it('carries Retry-After as milliseconds', () => {
    const result = classifyProviderError({ status: 429, provider: 'groq', message: 'Too many requests', headers: headers({ 'retry-after': '7' }) });
    expect(result).toEqual({ code: 'rate_limited', retryAfterMs: 7000 });
  });

  it('reads OpenRouter "no endpoints" and 503 as an unavailable model', () => {
    expect(classifyProviderError({ status: 404, provider: 'openrouter', message: 'No endpoints found for x/y:free.' }).code).toBe('model_unavailable');
    expect(classifyProviderError({ status: 503, provider: 'openrouter', message: 'No instances available' }).code).toBe('model_unavailable');
  });

  it('separates auth, overload, context and tool errors', () => {
    expect(classifyProviderError({ status: 401, provider: 'openai', message: 'bad key' }).code).toBe('auth');
    expect(classifyProviderError({ status: 529, provider: 'anthropic', message: 'Overloaded' }).code).toBe('overloaded');
    expect(classifyProviderError({ status: 400, provider: 'openai', message: 'maximum context length exceeded' }).code).toBe('context_too_long');
    expect(classifyProviderError({ status: 400, provider: 'groq', message: 'model does not support tools' }).code).toBe('tool_unsupported');
  });

  it('leaves an unrecognised error without a code', () => {
    expect(classifyProviderError({ status: 500, provider: 'openai', message: 'boom' })).toEqual({});
  });
});

describe('classifyGeminiError', () => {
  const quota = (quotaId: string, retryDelay?: string) => [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
    ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
  ];

  it('treats a per-day quota as that model being spent, not the account', () => {
    expect(classifyGeminiError(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier')).code).toBe('model_busy');
  });

  it('treats a per-minute quota as a wait, with the delay Gemini gives', () => {
    expect(classifyGeminiError(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '12s')))
      .toEqual({ code: 'rate_limited', retryAfterMs: 12000 });
  });

  it('has nothing to say without quota details', () => {
    expect(classifyGeminiError(429, [])).toEqual({});
    expect(classifyGeminiError(400, quota('x'))).toEqual({});
  });
});

describe('header parsing', () => {
  it('reads Retry-After seconds and dates, and ignores junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('scales a seconds-epoch reset up to milliseconds', () => {
    expect(parseResetHeader('1791158400')).toBe(1791158400000);
    expect(parseResetHeader('1791158400000')).toBe(1791158400000);
    expect(parseResetHeader('0')).toBeUndefined();
  });
});
