import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import * as accountToken from '../account-token';

const { getAccountToken, resetAccountTokens } = accountToken;

/** A hosted user's token: asked of the gateway as the instance signs its webhooks, kept until near expiry. */
const NOW = Date.parse('2026-10-22T12:00:00Z');
let issued = 0;
let failing = false;
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  if (failing) return new Response(JSON.stringify({ error: 'Invalid signature', code: 'bad_signature' }), { status: 401 });
  issued++;
  return new Response(JSON.stringify({ token: `tok-${issued}`, expiresAt: NOW + 3_600_000 }));
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetAccountTokens();
  issued = 0;
  failing = false;
  // A reset, not a clear: a test that stops early must not leave a queued answer for the next one.
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.WEBHOOK_URL = 'https://gateway.oswstudio.com/';
  process.env.WEBHOOK_SECRET = 'shared';
  process.env.INSTANCE_ID = 'inst-1';
});
afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('getAccountToken', () => {
  it('asks the gateway with a signed, timestamped request for this user', async () => {
    expect(await getAccountToken('osws-user', NOW)).toEqual({ token: 'tok-1', expiresAt: NOW + 3_600_000 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.oswstudio.com/api/inference/account-token');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-instance-id']).toBe('inst-1');
    expect(headers['x-webhook-signature']).toBe(createHmac('sha256', 'shared').update(String(init!.body)).digest('hex'));
    const body = JSON.parse(String(init!.body));
    expect(body.userId).toBe('osws-user');
    expect(typeof body.ts).toBe('number');
  });

  it('keeps the token until ten minutes before it expires, and shares one request among callers', async () => {
    await Promise.all([getAccountToken('u', NOW), getAccountToken('u', NOW)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getAccountToken('u', NOW + 49 * 60_000))!.token).toBe('tok-1');
    expect((await getAccountToken('u', NOW + 51 * 60_000))!.token).toBe('tok-2');
  });

  it('falls back on a token that still works when the gateway refuses, and gives none without one', async () => {
    await getAccountToken('u', NOW);
    failing = true;
    expect((await getAccountToken('u', NOW + 51 * 60_000))!.token).toBe('tok-1');
    // Also while the gateway is left alone for half a minute.
    expect((await getAccountToken('u', NOW + 51 * 60_000 + 20_000))!.token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getAccountToken('someone-else', NOW)).toBeNull();
    // Each refusal is logged with the gateway's code, so a wrong setting shows.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('401 bad_signature'));
  });

  it('never falls back on a token within a minute of its expiry, or past it', async () => {
    const expiresAt = NOW + 3_600_000;
    await getAccountToken('u', NOW);
    failing = true;
    expect(await getAccountToken('u', expiresAt - 59_000)).toBeNull();
    // Inside the half-minute the gateway is left alone.
    expect(await getAccountToken('u', expiresAt - 40_000)).toBeNull();
    expect(await getAccountToken('u', expiresAt + 60_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('takes no token from a gateway answer of the wrong shape', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 42, expiresAt: NOW + 3_600_000 })));
    expect(await getAccountToken('u', NOW)).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: 'tok', expiresAt: new Date(NOW + 3_600_000).toISOString() })));
    expect(await getAccountToken('u', NOW + 30_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks the gateway for a new token once the inference server refused the one it has, and keeps a newer one', async () => {
    expect((await getAccountToken('u', NOW))!.token).toBe('tok-1');
    accountToken.forgetAccountToken('u', 'tok-1');
    expect((await getAccountToken('u', NOW + 1000))!.token).toBe('tok-2');
    accountToken.forgetAccountToken('u', 'tok-1');
    expect((await getAccountToken('u', NOW + 2000))!.token).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not ask the gateway again for half a minute after it gave no token', async () => {
    failing = true;
    expect(await getAccountToken('u', NOW)).toBeNull();
    expect(await getAccountToken('u', NOW + 29_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    failing = false;
    expect((await getAccountToken('u', NOW + 30_000))!.token).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks nothing without the instance\'s gateway settings', async () => {
    delete process.env.WEBHOOK_SECRET;
    expect(await getAccountToken('u', NOW)).toBeNull();
    expect(await getAccountToken('someone-else', NOW)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // Said once, not on every request.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
