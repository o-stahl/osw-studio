import { describe, it, expect } from 'vitest';
import { classifyProviderError, parseRetryAfter } from '../provider-errors';

describe('classifyProviderError, the edges', () => {
  it('reads a 403 as an auth failure, like a 401', () => {
    expect(classifyProviderError({ status: 403, provider: 'openai', message: 'forbidden' }).code).toBe('auth');
  });

  it('reads a 503 as an unavailable model only on OpenRouter', () => {
    expect(classifyProviderError({ status: 503, provider: 'openrouter', message: 'x' }).code).toBe('model_unavailable');
    expect(classifyProviderError({ status: 503, provider: 'openai', message: 'x' }).code).toBeUndefined();
  });

  it('reads "too long" as a conversation that does not fit', () => {
    expect(classifyProviderError({ status: 400, provider: 'anthropic', message: 'prompt is too long: 210000 tokens' }).code).toBe('context_too_long');
  });
});

describe('parseRetryAfter, the edges', () => {
  it('reads a date already past as no wait, never a negative one', () => {
    const now = Date.UTC(2026, 9, 3, 12, 0);
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });
});
