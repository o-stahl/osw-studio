import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/llm/providers/registry', () => ({
  getProvider: (id: string) => ({ usesOAuth: id === 'huggingface' || id === 'openai-codex' }),
  getModelContextLength: () => 128000,
}));

import { isTerminalApiError } from '../multi-agent-orchestrator';
import { ProviderApiError } from '../provider-adapter';

const err = (category: string, provider: string, status = 400) => new ProviderApiError('m', status, 't', category, provider, 'model');

/**
 * Which stopped tasks offer a plain Continue, resending the same request on the same model. That
 * only helps when the same request can succeed later, so the rule is about whether anything can
 * change in between.
 */
describe('isTerminalApiError', () => {
  it('offers no resend when the provider will refuse the same request every time', () => {
    for (const c of ['tool_not_supported', 'invalid_request', 'context_too_long', 'blocked', 'model_refused']) {
      expect(isTerminalApiError(err(c, 'openai')), c).toBe(true);
    }
  });

  it('offers a resend after a transient failure', () => {
    for (const c of ['server_error', 'rate_limited', 'midstream_error', 'unknown']) {
      expect(isTerminalApiError(err(c, 'openai')), c).toBe(false);
    }
  });

  it('offers no resend for an expired OAuth sign-in, which the adapter has just cleared', () => {
    expect(isTerminalApiError(err('auth_expired', 'huggingface'))).toBe(true);
  });

  it('offers a resend for a refused pasted key, which the user can replace first', () => {
    expect(isTerminalApiError(err('auth_expired', 'openai'))).toBe(false);
  });

  it('offers a resend when HuggingFace free credits are gone, for after they renew', () => {
    expect(isTerminalApiError(err('credit_exhausted', 'huggingface'))).toBe(false);
  });

  it('offers no resend for a missing model, but does when OpenRouter only has no provider for it now', () => {
    expect(isTerminalApiError(err('model_not_found', 'openrouter', 404))).toBe(true);
    expect(isTerminalApiError(err('model_not_found', 'openrouter', 503))).toBe(false);
  });

  it('offers a resend for a spent daily allowance, for after it resets', () => {
    expect(isTerminalApiError(err('daily_limit', 'openrouter'))).toBe(false);
  });

  it('offers a resend when a paid provider is out of credit, which a top-up fixes', () => {
    expect(isTerminalApiError(err('credit_exhausted', 'openrouter'))).toBe(false);
  });
});
