import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from 'jose';

/**
 * The free allowance through `/api/generate`: only where it is offered, only to OSW Studio's inference
 * server whatever the client names, never with a key the client sends: on the demo a token minted for
 * the trial session in the request's cookie, on a hosted instance the signed-in user's account token.
 * Its limits are classified for the stopped card.
 */

vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const session = vi.hoisted(() => ({ value: null as null | { userId: string } }));
const getAccountToken = vi.hoisted(() => vi.fn());
const forgetAccountToken = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session', () => ({ getSession: async () => session.value }));
vi.mock('@/lib/inference/account-token', () => ({
  getAccountToken: (...a: unknown[]) => getAccountToken(...a),
  forgetAccountToken: (...a: unknown[]) => forgetAccountToken(...a),
}));

const VISITOR_IP = '203.0.113.7';
let publicKey: CryptoKey;

type ReqOpts = { cookie?: string; ip?: string; headers?: Record<string, string> };

function makeReq(body: unknown, opts: ReqOpts = {}): NextRequest {
  const headers = new Headers({ 'x-forwarded-for': opts.ip ?? VISITOR_IP, ...opts.headers });
  return {
    json: async () => body,
    headers,
    cookies: { get: (name: string) => (opts.cookie && name === 'osws_trial' ? { name, value: opts.cookie } : undefined) },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

async function post(body: Record<string, unknown>, opts: ReqOpts = {}) {
  const { POST } = await import('../route');
  return POST(makeReq({ messages: [{ role: 'user', content: 'hi' }], stream: false, provider: 'osws', model: 'osws/agent', ...body }, opts));
}

function upstream(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof upstream>) => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), headers: new Headers(init!.headers as HeadersInit), body: JSON.parse(String(init!.body)) };
};
const ok = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };

async function asDemo() {
  delete process.env.NEXT_PUBLIC_SERVER_MODE;
  delete process.env.NEXT_PUBLIC_GATEWAY_URL;
  process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  publicKey = pair.publicKey;
  process.env.TRIAL_SIGNING_KEY = await exportPKCS8(pair.privateKey);
  process.env.TRIAL_SIGNING_KID = 'try-test';
  process.env.TURNSTILE_SITE_KEY = 'site-key';
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
}
function asHosted() {
  delete process.env.DEMO_GATEWAY_URL;
  process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
  process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://gateway.oswstudio.com';
}

/** A trial session's cookie, as the demo's trial route would set it for a visitor at `ip`. */
async function trialCookie(ip = VISITOR_IP, now = Date.now()) {
  const { trialConfig } = await import('@/lib/inference/trial/config');
  const { newTrialSession, sealSession } = await import('@/lib/inference/trial/session');
  const cfg = (await trialConfig())!;
  const s = newTrialSession(ip, cfg.blockKey, now);
  return { cookie: sealSession(s, cfg.sealKey), sub: s.sub };
}

beforeEach(() => {
  vi.resetModules();
  session.value = null;
  getAccountToken.mockReset();
  forgetAccountToken.mockReset();
  delete process.env.OSWS_INFERENCE_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['DEMO_GATEWAY_URL', 'NEXT_PUBLIC_SERVER_MODE', 'NEXT_PUBLIC_GATEWAY_URL', 'TRIAL_SIGNING_KEY', 'TRIAL_SIGNING_KID', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) delete process.env[k];
});

describe('the free allowance through /api/generate', () => {
  it('is refused where it is not offered, without a request upstream', async () => {
    const fetchMock = upstream(200, ok);
    const res = await post({ apiKey: 'some-token' });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on the demo, sends a token minted for the cookie's session, to the inference server only, whatever key, address and headers the client names", async () => {
    await asDemo();
    const { cookie, sub } = await trialCookie();
    const fetchMock = upstream(200, ok);
    const res = await post({ apiKey: 'client-key', baseUrl: 'https://elsewhere.example/v1', customHeaders: { 'X-Extra': '1' }, sessionId: 'project-123' }, { cookie });
    expect(res.status).toBe(200);
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe('https://inference.oswstudio.com/v1/chat/completions');
    expect(headers.get('x-extra')).toBeNull();
    const token = headers.get('authorization')!.replace(/^Bearer /, '');
    expect(token).not.toBe('client-key');
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'EdDSA', kid: 'try-test' });
    const { payload } = await jwtVerify(token, publicKey, { issuer: 'https://oswstudio.com', audience: 'inference.oswstudio.com', algorithms: ['EdDSA'] });
    expect(payload).toMatchObject({ pool: 'trial', sub });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(body.session_id).toBe(createHash('sha256').update('project-123').digest('hex').slice(0, 32));
    expect(JSON.stringify(body)).not.toContain('project-123');
  });

  it('takes its server address from OSWS_INFERENCE_URL, even a local one, written with or without a final slash', async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    process.env.OSWS_INFERENCE_URL = 'http://localhost:8787/v1/';
    const fetchMock = upstream(200, ok);
    expect((await post({}, { cookie })).status).toBe(200);
    expect(sent(fetchMock).url).toBe('http://localhost:8787/v1/chat/completions');
  });

  it('on the demo, asks for a new session when there is none, or it is over, altered or from another network', async () => {
    await asDemo();
    const fetchMock = upstream(200, ok);
    const { cookie } = await trialCookie();
    const expired = (await trialCookie(VISITOR_IP, Date.now() - 3 * 3_600_000)).cookie;
    const altered = cookie.slice(0, -4) + (cookie.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    for (const opts of [{}, { cookie: expired }, { cookie: altered }, { cookie, ip: '198.51.100.9' }]) {
      const res = await post({}, opts);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ code: 'trial_session' });
      // The cookie is left alone: this answer can arrive after a parallel request has started a new
      // session, and clearing it then would throw that session away.
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    // Another address in the same /24 is the same network.
    expect((await post({}, { cookie, ip: '203.0.113.200' })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on the demo, says the allowance is unavailable where the trial is not configured', async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    vi.resetModules();
    delete process.env.TRIAL_SIGNING_KID;
    const fetchMock = upstream(200, ok);
    const res = await post({}, { cookie });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on a hosted instance, sends the signed-in user's account token, never the client's", async () => {
    asHosted();
    session.value = { userId: 'osws-user-1' };
    getAccountToken.mockResolvedValue({ token: 'account-token', expiresAt: Date.now() + 3_600_000 });
    const fetchMock = upstream(200, ok);
    expect((await post({ apiKey: 'client-key' })).status).toBe(200);
    expect(getAccountToken).toHaveBeenCalledWith('osws-user-1');
    expect(sent(fetchMock).headers.get('authorization')).toBe('Bearer account-token');
  });

  it('on a hosted instance, gives a server-side run the token of the user it runs for, with no cookie', async () => {
    asHosted();
    getAccountToken.mockResolvedValue({ token: 'account-token', expiresAt: Date.now() + 3_600_000 });
    const fetchMock = upstream(200, ok);
    const { serverRunHeaders } = await import('@/lib/server-generate/run-auth');
    expect((await post({ apiKey: 'run-key' }, { headers: serverRunHeaders('osws-user-2') })).status).toBe(200);
    expect(getAccountToken).toHaveBeenCalledWith('osws-user-2');
    expect(sent(fetchMock).headers.get('authorization')).toBe('Bearer account-token');
  });

  it("on a hosted instance, names a server-side run's user only with this process's secret", async () => {
    asHosted();
    const fetchMock = upstream(200, ok);
    const { serverRunHeaders } = await import('@/lib/server-generate/run-auth');
    // The same headers with the secret guessed: a caller without a session, like any other.
    const forged = Object.fromEntries(Object.entries(serverRunHeaders('osws-user-2'))
      .map(([name, value]) => [name, value === 'osws-user-2' ? value : 'x'.repeat(value.length)]));
    expect((await post({}, { headers: forged })).status).toBe(401);
    expect(getAccountToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on a hosted instance, refuses a caller without a session, and says the allowance is unavailable when the gateway gives no token', async () => {
    asHosted();
    const fetchMock = upstream(200, ok);
    expect((await post({ apiKey: 'client-key' })).status).toBe(401);
    session.value = { userId: 'osws-user-1' };
    getAccountToken.mockResolvedValue(null);
    const res = await post({});
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the free allowance's limits", () => {
  const reset = String(Date.parse('2026-10-23T00:00:00Z'));

  it("reads a spent pool as today's allowance, and when it refills", async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    upstream(402, { error: { code: 402, message: 'The free allowance is used up for now.', metadata: { error_type: 'budget', limit_source: 'osws_pool' } } }, { 'x-ratelimit-reset': reset });
    const res = await post({}, { cookie });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'daily_limit', resetAt: Number(reset) });
    expect(body.error).toMatch(/free inference is used up/);
    expect(body.error).not.toMatch(/billing/);
  });

  it('reads the monthly cap and the pause as no allowance left, and when the cap renews', async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    const nextMonth = String(Date.parse('2026-11-01T00:00:00Z'));
    upstream(402, { error: { code: 402, message: 'x', metadata: { limit_source: 'osws_monthly' } } }, { 'x-ratelimit-reset': nextMonth });
    await expect((await post({}, { cookie })).json()).resolves.toMatchObject({ code: 'credit_exhausted', resetAt: Number(nextMonth) });
    upstream(402, { error: { code: 402, message: 'x', metadata: { limit_source: 'osws_paused' } } });
    const paused = await (await post({}, { cookie })).json();
    expect(paused).toMatchObject({ code: 'credit_exhausted' });
    expect(paused).not.toHaveProperty('resetAt');
  });

  it("ends a trial session whose own allowance is spent, so the page starts a new one", async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    upstream(402, { error: { code: 402, message: 'Your free allowance for today is used up.', metadata: { limit_source: 'osws_visitor_daily' } } });
    const res = await post({}, { cookie });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'trial_session' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('reads a token the inference server refuses as the allowance being unavailable, not as the visitor\'s doing', async () => {
    await asDemo();
    const { cookie } = await trialCookie();
    upstream(401, { error: { code: 401, message: 'The access token is not valid.', metadata: { error_type: 'invalid_token' } } });
    const res = await post({}, { cookie });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_unavailable' });
  });

  it("drops a hosted account's token the inference server refuses, so the next request asks for a new one", async () => {
    asHosted();
    session.value = { userId: 'osws-user-1' };
    getAccountToken.mockResolvedValue({ token: 'account-token', expiresAt: Date.now() + 3_600_000 });
    upstream(401, { error: { code: 401, message: 'The access token is not valid.', metadata: { error_type: 'invalid_token' } } });
    expect((await post({})).status).toBe(503);
    expect(forgetAccountToken).toHaveBeenCalledWith('osws-user-1', 'account-token');
  });
});
