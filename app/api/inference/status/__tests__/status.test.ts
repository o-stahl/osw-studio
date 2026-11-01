import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';

/**
 * `/api/inference/status`, the free allowance's status check: on the demo, that this server can run the
 * trial and the inference server answers; on a hosted instance, that the signed-in user's token is issued
 * and accepted. Answers are kept for half a minute and shared by concurrent callers.
 */

const session = vi.hoisted(() => ({ value: null as null | { userId: string } }));
const getAccountToken = vi.hoisted(() => vi.fn());
const forgetAccountToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getSession: async () => session.value }));
vi.mock('@/lib/inference/account-token', () => ({
  getAccountToken: (...a: unknown[]) => getAccountToken(...a),
  forgetAccountToken: (...a: unknown[]) => forgetAccountToken(...a),
}));

type Reply = { status: number; body?: unknown } | Error;

/** Answers each upstream request by the first route whose fragment its URL contains. */
function upstream(routes: Record<string, Reply>) {
  const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const hit = Object.entries(routes).find(([fragment]) => String(url).includes(fragment));
    if (!hit) throw new Error(`unexpected request to ${String(url)}`);
    const reply = hit[1];
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const urls = (fetchMock: ReturnType<typeof upstream>) => fetchMock.mock.calls.map(([url]) => String(url)).sort();

async function get() {
  const { GET } = await import('../route');
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

/** The demo, with its trial configured (lib/inference/trial/config.ts). */
async function asDemo() {
  process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  process.env.TRIAL_SIGNING_KEY = await exportPKCS8(privateKey);
  process.env.TRIAL_SIGNING_KID = 'try-test';
  process.env.TURNSTILE_SITE_KEY = 'site-key';
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
}
function asHosted() {
  process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
  process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://gateway.oswstudio.com';
}

const healthy = { status: 200, body: 'ok' };

beforeEach(() => {
  vi.resetModules();
  session.value = null;
  getAccountToken.mockReset();
  forgetAccountToken.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const k of ['DEMO_GATEWAY_URL', 'NEXT_PUBLIC_SERVER_MODE', 'NEXT_PUBLIC_GATEWAY_URL', 'OSWS_INFERENCE_URL', 'TRIAL_SIGNING_KEY', 'TRIAL_SIGNING_KID', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TRIAL_DAILY_CAPS']) delete process.env[k];
});

describe('the free allowance status check', () => {
  it('is not offered on a git clone or a self-hosted server, and asks nothing upstream', async () => {
    const fetchMock = upstream({});
    expect(await get()).toEqual({ status: 404, body: { available: false } });
    process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
    expect((await get()).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('on the demo', () => {
    beforeEach(asDemo);

    it('is available when this server can run the trial and the inference server answers', async () => {
      const fetchMock = upstream({ '/healthz': healthy });
      expect(await get()).toEqual({ status: 200, body: { available: true } });
      // The health check sits at the server's root, not under the API's /v1. Nothing goes to the gateway.
      expect(urls(fetchMock)).toEqual(['https://inference.oswstudio.com/healthz']);
    });

    it('checks the inference server named by OSWS_INFERENCE_URL', async () => {
      process.env.OSWS_INFERENCE_URL = 'http://127.0.0.1:8790/v1';
      const fetchMock = upstream({ '/healthz': healthy });
      await get();
      expect(urls(fetchMock)).toEqual(['http://127.0.0.1:8790/healthz']);
    });

    it("is unavailable once the day's trial sessions are all taken", async () => {
      process.env.TRIAL_DAILY_CAPS = '3,20,1';
      upstream({ '/healthz': healthy });
      const { reserveTrialSession } = await import('@/lib/inference/trial/caps');
      expect(reserveTrialSession('203.0.113.7').ok).toBe(true);
      expect((await get()).body).toEqual({ available: false, reason: 'limit' });
    });

    it('is unavailable when the trial is not configured here', async () => {
      delete process.env.TURNSTILE_SECRET_KEY;
      upstream({ '/healthz': healthy });
      expect((await get()).body).toEqual({ available: false, reason: 'config' });
    });

    it('is unavailable when the inference server does not answer', async () => {
      upstream({ '/healthz': { status: 502 } });
      expect((await get()).body).toEqual({ available: false, reason: 'server' });

      vi.resetModules();
      upstream({ '/healthz': new TypeError('fetch failed') });
      expect((await get()).body).toEqual({ available: false, reason: 'server' });
    });

    it('keeps an answer for half a minute, for every visitor', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const fetchMock = upstream({ '/healthz': healthy });
      await get();
      await get();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      await get();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('makes one check for requests that arrive together', async () => {
      const fetchMock = upstream({ '/healthz': healthy });
      const { GET } = await import('../route');
      await Promise.all([GET(), GET(), GET()]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('on a hosted instance', () => {
    beforeEach(asHosted);

    it('needs a signed-in user', async () => {
      const fetchMock = upstream({});
      expect(await get()).toEqual({ status: 401, body: { available: false } });
      expect(getAccountToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is available when the user's token is issued and the inference server accepts it", async () => {
      session.value = { userId: 'u1' };
      getAccountToken.mockResolvedValue({ token: 'acct-token', expiresAt: Date.now() + 3_600_000 });
      const fetchMock = upstream({ '/v1/models': { status: 200, body: { data: [] } } });
      expect(await get()).toEqual({ status: 200, body: { available: true } });
      expect(getAccountToken).toHaveBeenCalledWith('u1');
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://inference.oswstudio.com/v1/models');
      expect(new Headers(init!.headers).get('authorization')).toBe('Bearer acct-token');
    });

    it('is unavailable when the gateway issues no token, without asking the inference server', async () => {
      session.value = { userId: 'u1' };
      getAccountToken.mockResolvedValue(null);
      const fetchMock = upstream({});
      expect((await get()).body).toEqual({ available: false, reason: 'gateway' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('tells a refused token from an inference server that does not answer', async () => {
      session.value = { userId: 'u1' };
      getAccountToken.mockResolvedValue({ token: 'acct-token', expiresAt: Date.now() + 3_600_000 });
      upstream({ '/v1/models': { status: 401, body: { error: { message: 'The access token is not valid.' } } } });
      expect((await get()).body).toEqual({ available: false, reason: 'token' });
      // The refused token is dropped, so the next check asks the gateway for a new one.
      expect(forgetAccountToken).toHaveBeenCalledWith('u1', 'acct-token');

      vi.resetModules();
      upstream({ '/v1/models': { status: 500 } });
      expect((await get()).body).toEqual({ available: false, reason: 'server' });

      vi.resetModules();
      upstream({ '/v1/models': new TypeError('fetch failed') });
      expect((await get()).body).toEqual({ available: false, reason: 'server' });
      expect(forgetAccountToken).toHaveBeenCalledTimes(1);
    });

    it("keeps each user's answer apart", async () => {
      getAccountToken.mockImplementation(async (userId: string) => (userId === 'u1' ? { token: 't1', expiresAt: Date.now() + 3_600_000 } : null));
      upstream({ '/v1/models': { status: 200, body: { data: [] } } });
      session.value = { userId: 'u1' };
      expect((await get()).body).toEqual({ available: true });
      session.value = { userId: 'u2' };
      expect((await get()).body).toEqual({ available: false, reason: 'gateway' });
    });
  });
});
