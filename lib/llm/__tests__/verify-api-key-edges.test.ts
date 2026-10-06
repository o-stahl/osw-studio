import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { verifyApiKey } from '../llm-client';

beforeEach(() => { apiFetch.mockReset(); });

describe('verifyApiKey, the edges', () => {
  it('reads a plain 500 as a check that could not run, not a rejected key', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(verifyApiKey('k', 'openrouter')).rejects.toThrow(/500/);
  });

  it('says an empty key is not valid without asking anyone', async () => {
    expect(await verifyApiKey('', 'openrouter')).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('reads a 4xx from the route as a rejected key', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ valid: true }), { status: 400 }));
    expect(await verifyApiKey('k', 'openrouter')).toBe(false);
  });
});
