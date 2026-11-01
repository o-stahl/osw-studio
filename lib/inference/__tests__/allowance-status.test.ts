// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ALLOWANCE_STATUS_EVENT, allowanceStatus, allowanceUsable, checkAllowance, resetAllowanceStatus } from '../allowance-status';

/**
 * The free allowance's connection status: what the app server's check says, counted as connected
 * until it first answers, checked again every minute while it fails, and announced so that
 * readiness and the connect options read it again.
 */

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function listen(event: string) {
  const seen: unknown[] = [];
  const on = (e: Event) => seen.push((e as CustomEvent).detail);
  window.addEventListener(event, on);
  return { seen, stop: () => window.removeEventListener(event, on) };
}

// The demo, as the page says it (lib/demo.ts reads <html data-demo-gateway> in the browser).
beforeEach(() => {
  resetAllowanceStatus();
  document.documentElement.dataset.demoGateway = 'https://gateway.oswstudio.com';
});
afterEach(() => {
  resetAllowanceStatus();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete document.documentElement.dataset.demoGateway;
});

describe('the free allowance status', () => {
  it('is never checked, and not usable, where the allowance is not offered', async () => {
    delete document.documentElement.dataset.demoGateway;
    const fetchMock = answer(200, { available: true });
    await checkAllowance({ force: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(allowanceUsable()).toBe(false);
  });

  it('counts as connected until the first check answers', () => {
    expect(allowanceStatus()).toEqual({ state: 'unknown', checking: false });
    expect(allowanceUsable()).toBe(true);
  });

  it('asks the app server and is connected when it says available', async () => {
    const fetchMock = answer(200, { available: true });
    const pending = checkAllowance();
    expect(allowanceStatus()).toEqual({ state: 'unknown', checking: true });
    await expect(pending).resolves.toBe('available');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/inference/status');
    expect(allowanceStatus()).toEqual({ state: 'available', checking: false });
    expect(allowanceUsable()).toBe(true);
  });

  it('is not connected when the check says unavailable, fails, or does not answer', async () => {
    answer(200, { available: false, reason: 'server' });
    await expect(checkAllowance()).resolves.toBe('unavailable');
    expect(allowanceUsable()).toBe(false);

    answer(503, { available: true });
    await expect(checkAllowance({ force: true })).resolves.toBe('unavailable');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(checkAllowance({ force: true })).resolves.toBe('unavailable');
    expect(allowanceUsable()).toBe(false);
  });

  it('announces each change, and asks for model config to be read again only when connectedness changes', async () => {
    const status = listen(ALLOWANCE_STATUS_EVENT);
    const config = listen('modelConfigChanged');

    answer(200, { available: true });
    await checkAllowance();
    expect(status.seen).toEqual([{ state: 'unknown', checking: true }, { state: 'available', checking: false }]);
    // Unknown already counted as connected.
    expect(config.seen).toHaveLength(0);

    answer(200, { available: false });
    await checkAllowance({ force: true });
    expect(config.seen).toHaveLength(1);

    answer(200, { available: true });
    await checkAllowance({ force: true });
    expect(config.seen).toHaveLength(2);
    status.stop();
    config.stop();
  });

  it('shares one check among concurrent callers', async () => {
    const fetchMock = answer(200, { available: true });
    const [a, b] = await Promise.all([checkAllowance(), checkAllowance({ force: true })]);
    expect([a, b]).toEqual(['available', 'available']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a recent answer, and checks again when forced or once it is old', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fetchMock = answer(200, { available: true });
    await checkAllowance();
    await checkAllowance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await checkAllowance({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60_000);
    await checkAllowance();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps a recent unavailable answer for a minute too', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fetchMock = answer(200, { available: false });
    await checkAllowance();
    await vi.advanceTimersByTimeAsync(59_000);
    await expect(checkAllowance()).resolves.toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a check that gets no answer in twenty seconds, and checks again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const timers: Array<{ ms: number; stop: AbortController }> = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const stop = new AbortController();
      timers.push({ ms, stop });
      return stop.signal;
    });
    // A server that never answers: only the request's signal ends it.
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = checkAllowance();
    expect(timers.map(({ ms }) => ms)).toEqual([20_000]);
    timers[0].stop.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(pending).resolves.toBe('unavailable');
    expect(allowanceStatus()).toEqual({ state: 'unavailable', checking: false });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    timeout.mockRestore();
  });

  it('checks again every minute while unavailable, and stops once it passes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fetchMock = answer(200, { available: false });
    await checkAllowance();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ available: true }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(allowanceStatus().state).toBe('available');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('replaces a pending retry when a check is forced, so it still checks only once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fetchMock = answer(200, { available: false });
    await checkAllowance();
    await vi.advanceTimersByTimeAsync(30_000);
    await checkAllowance({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The first check's retry was due here.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
