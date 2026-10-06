// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bundled from '../bundled-scores.json';

const apiFetch = vi.fn();
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const fresh = () => new Response(JSON.stringify({ asOf: '2026-10-04', models: { m: { agentic: 1 } } }), { status: 200 });

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe('refreshScores, the edges', () => {
  it('lets a second caller wait for the refresh already running', async () => {
    const { refreshScores, getScores } = await import('../scores');
    let release: (r: Response) => void = () => {};
    apiFetch.mockReturnValue(new Promise<Response>((r) => { release = r; }));
    const first = refreshScores('sk-or-x', 2_000_000_000_000);
    const second = refreshScores('sk-or-x', 2_000_000_000_000);
    release(fresh());
    await second;
    expect(getScores().asOf).toBe('2026-10-04');
    await first;
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('sends the user\'s own key to the scores route', async () => {
    const { refreshScores } = await import('../scores');
    apiFetch.mockResolvedValue(fresh());
    await refreshScores('sk-or-x', 2_000_000_000_000);
    expect(apiFetch).toHaveBeenCalledWith('/api/model-scores', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ apiKey: 'sk-or-x' }),
    }));
  });

  it('keeps the bundled figures when the refresh comes back empty', async () => {
    const { refreshScores, getScores } = await import('../scores');
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ asOf: '2026-10-04', models: {} }), { status: 200 }));
    await refreshScores('sk-or-x', 2_000_000_000_000);
    expect(getScores().asOf).toBe(bundled.asOf);
    expect(localStorage.getItem('osw-model-scores')).toBeNull();
  });

  it('still waits an hour after a failure in a browser with no storage', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { refreshScores } = await import('../scores');
    apiFetch.mockResolvedValue(new Response('{}', { status: 502 }));
    await refreshScores('sk-or-x', 1_000_000);
    await refreshScores('sk-or-x', 1_000_000 + 30 * 60_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('getScores', () => {
  it('ignores a stored copy of the wrong shape', async () => {
    localStorage.setItem('osw-model-scores', JSON.stringify({ fetchedAt: Date.now(), snapshot: { asOf: 'broken' } }));
    const { getScores } = await import('../scores');
    expect(getScores().asOf).toBe(bundled.asOf);
  });
});
