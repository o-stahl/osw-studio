import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyTrialCheck } from '../check';

/** The check a trial session is bought with: solved, for the trial action, on this site, recently. */
const NOW = Date.parse('2026-10-22T12:00:00Z');
const expected = { hostname: 'try.oswstudio.com', remoteIp: '203.0.113.7' };
let answer: Record<string, unknown>;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(answer)));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  answer = { success: true, action: 'trial', hostname: 'try.oswstudio.com', challenge_ts: new Date(NOW - 20_000).toISOString() };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('verifyTrialCheck', () => {
  it("passes a fresh solve of the trial action on this site, sending the visitor's address", async () => {
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(JSON.parse(String(init!.body))).toEqual({ secret: 'secret', response: 'tok', remoteip: '203.0.113.7' });
  });

  it('refuses a failed solve, another action, another host, and an old solve', async () => {
    answer.success = false;
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'failed' });
    answer.success = true; answer.action = 'login';
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'action' });
    answer.action = 'trial'; answer.hostname = 'example.com';
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'hostname' });
    answer.hostname = 'try.oswstudio.com'; answer.challenge_ts = new Date(NOW - 301_000).toISOString();
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses an answer that leaves out the hostname or the solve time, or gives a time it cannot read', async () => {
    delete answer.hostname;
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'hostname' });
    answer.hostname = 'try.oswstudio.com';
    delete answer.challenge_ts;
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'stale' });
    answer.challenge_ts = 'just now';
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('matches the hostname in any case', async () => {
    answer.hostname = 'Try.OSWStudio.com';
    expect(await verifyTrialCheck('secret', 'tok', { ...expected, hostname: 'TRY.oswstudio.com' }, NOW)).toEqual({ ok: true });
  });

  it('logs a refusal that comes from the settings, never one that comes from the visitor', async () => {
    answer = { success: false, 'error-codes': ['invalid-input-response'] };
    await verifyTrialCheck('secret', 'tok', expected, NOW);
    answer = { success: false, 'error-codes': ['timeout-or-duplicate'] };
    await verifyTrialCheck('secret', 'tok', expected, NOW);
    expect(warn).not.toHaveBeenCalled();

    answer = { success: false, 'error-codes': ['invalid-input-secret'] };
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'failed' });
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('invalid-input-secret'));

    answer = { success: true, action: 'trial', hostname: 'example.com', challenge_ts: new Date(NOW).toISOString() };
    await verifyTrialCheck('secret', 'tok', expected, NOW);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('example.com'));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('says so when Cloudflare cannot be reached, and sends no address it does not have', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await verifyTrialCheck('secret', 'tok', expected, NOW)).toEqual({ ok: false, reason: 'unreachable' });
    await verifyTrialCheck('secret', 'tok', { hostname: 'try.oswstudio.com', remoteIp: null }, NOW);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ secret: 'secret', response: 'tok' });
  });
});
