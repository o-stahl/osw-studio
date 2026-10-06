import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { verifyApiKey, validateApiKey } from '../llm-client';

beforeEach(() => { apiFetch.mockReset(); });

describe('verifyApiKey', () => {
  it('returns what the provider said about the key', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ valid: true })));
    expect(await verifyApiKey('k', 'openrouter')).toBe(true);
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ valid: false })));
    expect(await verifyApiKey('k', 'openrouter')).toBe(false);
  });

  it('throws when the route could not ask the provider', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 502 }));
    await expect(verifyApiKey('k', 'openrouter')).rejects.toThrow(/502/);
  });

  it('throws when the route could not be reached', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(verifyApiKey('k', 'openrouter')).rejects.toThrow('Failed to fetch');
  });

  it('reads a check that could not run as not valid in validateApiKey', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 502 }));
    expect(await validateApiKey('k', 'openrouter')).toBe(false);
  });
});
