import { describe, it, expect } from 'vitest';
import { getProvider, getDefaultModel } from '../registry';

describe('the gateway providers', () => {
  it.each(['pollinations', 'vercel'] as const)('%s points at an OpenAI-compatible /v1 base', (id) => {
    // The generate route appends /chat/completions to this.
    expect(getProvider(id).baseUrl).toMatch(/^https:\/\/[^/]+\/v1$/);
  });

  it.each(['pollinations', 'vercel'] as const)('%s has a default model to start on', (id) => {
    expect(getDefaultModel(id)).not.toBe('');
  });
});
