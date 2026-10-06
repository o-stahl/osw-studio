// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
  vi.resetModules();
});

describe('refreshScores', () => {
  it('does not ask again within the hour after a failed refresh', async () => {
    const { refreshScores } = await import('../scores');
    apiFetch.mockResolvedValue(new Response('{}', { status: 502 }));
    await refreshScores('sk-or-x', 1_000_000);
    await refreshScores('sk-or-x', 1_000_000 + 30 * 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await refreshScores('sk-or-x', 1_000_000 + 61 * 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a fresh copy for a day and serves it', async () => {
    const { refreshScores, getScores } = await import('../scores');
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ asOf: '2026-10-04', models: { m: { agentic: 1 } } }), { status: 200 }));
    await refreshScores('sk-or-x', 2_000_000_000_000);
    expect(getScores().asOf).toBe('2026-10-04');
    await refreshScores('sk-or-x', 2_000_000_000_000 + 2 * 3600_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('asks nothing without an OpenRouter key', async () => {
    const { refreshScores } = await import('../scores');
    await refreshScores(null);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
