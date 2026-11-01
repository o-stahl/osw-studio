// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import en from '@/messages/en.json';

/**
 * The page's part of a trial session: ask the server what to render, run the check, hand the solve to
 * the server (which sets the cookie). Nothing is kept on the page, and concurrent callers share one check.
 */

const turnstile = vi.hoisted(() => ({ solve: vi.fn() }));
vi.mock('../turnstile', () => ({ solveTurnstile: (...a: unknown[]) => turnstile.solve(...a) }));

type Reply = { status: number; body: unknown } | Error;
let setupReply: Reply;
let startReply: Reply;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const reply = init?.method === 'POST' ? startReply : setupReply;
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), { status: reply.status });
});

async function load() {
  // Modules are fresh for each test: English goes to the runtime the module under test reads.
  const { registerEnglishTranslator } = await import('@/lib/i18n/__tests__/test-helpers');
  registerEnglishTranslator();
  return import('../trial-check');
}

beforeEach(() => {
  vi.resetModules();
  turnstile.solve.mockReset();
  turnstile.solve.mockResolvedValue('solve-1');
  fetchMock.mockClear();
  setupReply = { status: 200, body: { available: true, siteKey: 'site-key', action: 'trial' } };
  startReply = { status: 200, body: { expiresAt: Date.now() + 7_200_000 } };
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('startTrialSession', () => {
  it('runs the check with the site key and action the server gives, and hands the solve to the server', async () => {
    // Not the page's fallback action, so it can only have come from the server.
    setupReply = { status: 200, body: { available: true, siteKey: 'site-key', action: 'trial-start' } };
    const { startTrialSession } = await load();
    await startTrialSession();
    expect(turnstile.solve).toHaveBeenCalledWith('site-key', 'trial-start', en.allowance.checking, { signal: expect.any(AbortSignal) });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/inference/trial');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(init!.body))).toEqual({ turnstileToken: 'solve-1' });
    expect(localStorage.length).toBe(0);
  });

  it('shares one check among callers at the same time', async () => {
    const { startTrialSession } = await load();
    await Promise.all([startTrialSession(), startTrialSession(), startTrialSession()]);
    expect(turnstile.solve).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets a caller stop waiting at once, and keeps the check going for the others', async () => {
    let solved!: (token: string) => void;
    turnstile.solve.mockImplementation(() => new Promise((resolve) => { solved = resolve; }));
    const { startTrialSession } = await load();
    const leaving = new AbortController();
    const first = startTrialSession(leaving.signal);
    const second = startTrialSession();
    await vi.waitFor(() => expect(turnstile.solve).toHaveBeenCalled());
    leaving.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const { signal } = turnstile.solve.mock.calls[0][3] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);
    solved('solve-1');
    await expect(second).resolves.toBeUndefined();
  });

  it('calls the check off when its last caller stops waiting, and starts afresh for the next', async () => {
    turnstile.solve.mockImplementation(() => new Promise(() => {}));
    const { startTrialSession } = await load();
    const stop = new AbortController();
    const waiting = startTrialSession(stop.signal);
    await vi.waitFor(() => expect(turnstile.solve).toHaveBeenCalled());
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect((turnstile.solve.mock.calls[0][3] as { signal: AbortSignal }).signal.aborted).toBe(true);

    turnstile.solve.mockResolvedValue('solve-2');
    await startTrialSession();
    expect(turnstile.solve).toHaveBeenCalledTimes(2);
  });

  it('counts the sessions it started, and only those', async () => {
    const { startTrialSession, trialSessionsStarted } = await load();
    expect(trialSessionsStarted()).toBe(0);
    await startTrialSession();
    expect(trialSessionsStarted()).toBe(1);
    startReply = { status: 429, body: { code: 'trial_limit', resetAt: 1_800_000_000_000 } };
    await expect(startTrialSession()).rejects.toMatchObject({ failure: 'trial_limit' });
    expect(trialSessionsStarted()).toBe(1);
  });

  it('refuses a caller that has already stopped waiting, without starting a check', async () => {
    const { startTrialSession } = await load();
    const stop = new AbortController();
    stop.abort();
    await expect(startTrialSession(stop.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(turnstile.solve).not.toHaveBeenCalled();
  });

  it('runs no check where the server has no trial', async () => {
    setupReply = { status: 200, body: { available: false, siteKey: null, action: 'trial' } };
    const { startTrialSession, TrialCheckError } = await load();
    const err = await startTrialSession().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TrialCheckError);
    expect(err.failure).toBe('unavailable');
    expect(turnstile.solve).not.toHaveBeenCalled();
  });

  it.each([
    ['the network has had its sessions', { status: 429, body: { code: 'trial_limit', resetAt: 1_800_000_000_000 } }, 'trial_limit', 1_800_000_000_000],
    ['the server refuses the solve', { status: 403, body: { code: 'bot_check_failed' } }, 'check_failed', undefined],
    ['the server cannot run it now', { status: 503, body: { code: 'model_unavailable' } }, 'unavailable', undefined],
    ['nothing answers', new TypeError('Failed to fetch'), 'unavailable', undefined],
  ])('fails as %s', async (_what, reply, failure, resetAt) => {
    startReply = reply as Reply;
    const { startTrialSession } = await load();
    const err = await startTrialSession().then(() => null, (e) => e);
    expect(err.failure).toBe(failure);
    expect(err.resetAt).toBe(resetAt);
  });

  it('fails as a failed check when the widget gives no solve', async () => {
    turnstile.solve.mockRejectedValue(new Error('Turnstile failed'));
    const { startTrialSession } = await load();
    const err = await startTrialSession().then(() => null, (e) => e);
    expect(err.failure).toBe('check_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
