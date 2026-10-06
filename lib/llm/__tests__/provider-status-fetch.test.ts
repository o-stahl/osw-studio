import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { fetchProviderStatus, parseOpenRouterKey } from '../provider-status';

const NONE = { quota: { kind: 'none' } };

beforeEach(() => { apiFetch.mockReset(); });

describe('fetchProviderStatus', () => {
  it('asks the route with the provider and key, and returns its answer', async () => {
    const answer = { quota: { kind: 'balance', remaining: 3, unit: 'pollen' } };
    apiFetch.mockResolvedValue(new Response(JSON.stringify(answer)));
    expect(await fetchProviderStatus('pollinations', 'sk_x')).toEqual(answer);
    expect(apiFetch).toHaveBeenCalledWith('/api/provider-status', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ provider: 'pollinations', apiKey: 'sk_x' }),
    }));
  });

  it('asks nothing for a provider that publishes no status', async () => {
    expect(await fetchProviderStatus('openai', 'sk-x')).toEqual(NONE);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('asks nothing without a key', async () => {
    expect(await fetchProviderStatus('openrouter', '')).toEqual(NONE);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('reads a refused request as no status, not as its error body', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }));
    expect(await fetchProviderStatus('openrouter', 'sk-or-x')).toEqual(NONE);
  });

  it('never throws, even when the route cannot be reached', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await fetchProviderStatus('openrouter', 'sk-or-x')).toEqual(NONE);
  });
});

describe('parseOpenRouterKey remaining', () => {
  it('never goes below zero when the count ran past the limit', () => {
    const status = parseOpenRouterKey({ data: { free_model_daily_requests: { used: 60, limit: 50 } } });
    expect(status.quota).toMatchObject({ kind: 'daily', remaining: 0 });
  });
});
