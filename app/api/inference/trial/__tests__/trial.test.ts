import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { exportPKCS8, generateKeyPair } from 'jose';

/**
 * `/api/inference/trial`, where the demo's page starts a trial session: GET says what to render, POST
 * takes a solved check and answers with the session cookie, within the day's caps.
 */

const NOW = Date.parse('2026-10-27T12:00:00Z');
let answer: Record<string, unknown>;
const siteverify = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(answer)));

async function asDemo() {
  process.env.DEMO_GATEWAY_URL = 'https://gateway.oswstudio.com';
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  process.env.TRIAL_SIGNING_KEY = await exportPKCS8(privateKey);
  process.env.TRIAL_SIGNING_KID = 'try-test';
  process.env.TURNSTILE_SITE_KEY = 'site-key';
  process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  process.env.TRIAL_DAILY_CAPS = '2,20,150';
}

async function get() {
  const { GET } = await import('../route');
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

// As the app sees a request behind Caddy: its own listening address in the URL, the visitor's Host header.
async function post(body: unknown, ip = '203.0.113.7', host = 'try.oswstudio.com') {
  const { POST } = await import('../route');
  return POST(new NextRequest('http://127.0.0.1:3000/api/inference/trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, host },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  answer = { success: true, action: 'trial', hostname: 'try.oswstudio.com', challenge_ts: new Date(NOW - 5_000).toISOString() };
  // A reset, not a clear: a test that stops early must not leave a queued answer for the next one.
  siteverify.mockReset();
  vi.stubGlobal('fetch', siteverify);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ['DEMO_GATEWAY_URL', 'TRIAL_SIGNING_KEY', 'TRIAL_SIGNING_KID', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TRIAL_DAILY_CAPS']) delete process.env[k];
});

describe('the demo trial route', () => {
  it('is not there off the demo', async () => {
    expect((await get()).status).toBe(404);
    expect((await post({ turnstileToken: 'solve' })).status).toBe(404);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('tells the page what to render, and that there is no trial where it is not configured', async () => {
    await asDemo();
    expect(await get()).toEqual({ status: 200, body: { available: true, siteKey: 'site-key', action: 'trial' } });
    vi.resetModules();
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await get()).toEqual({ status: 200, body: { available: false, siteKey: null, action: 'trial' } });
  });

  it("exchanges a passed check for a two-hour session cookie bound to the visitor's network", async () => {
    await asDemo();
    const res = await post({ turnstileToken: 'solve' });
    expect(res.status).toBe(200);
    const { expiresAt } = await res.json();
    expect(expiresAt).toBeGreaterThan(NOW + 2 * 3_600_000 - 60_000);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^osws_trial=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7200$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Cloudflare is asked about this solve, for the visitor's address.
    expect(JSON.parse(String(siteverify.mock.calls[0][1]!.body))).toEqual({ secret: 'secret-key', response: 'solve', remoteip: '203.0.113.7' });

    const { trialConfig } = await import('@/lib/inference/trial/config');
    const { blockOf, openSession } = await import('@/lib/inference/trial/session');
    const { sealKey, blockKey } = (await trialConfig())!;
    // One key per use, both derived from the signing key.
    expect(blockKey.equals(sealKey)).toBe(false);
    const session = openSession(cookie.split(';')[0].split('=')[1], sealKey);
    expect(session).toMatchObject({ exp: expiresAt, block: blockOf('203.0.113.99', blockKey) });
  });

  it('ends a session started late in the day at midnight UTC, cookie and all', async () => {
    await asDemo();
    vi.setSystemTime(Date.parse('2026-10-27T23:00:00Z'));
    answer.challenge_ts = new Date(Date.now() - 5_000).toISOString();
    const res = await post({ turnstileToken: 'solve' });
    await expect(res.json()).resolves.toEqual({ expiresAt: Date.parse('2026-10-28T00:00:00Z') });
    expect(res.headers.get('set-cookie')).toMatch(/; Max-Age=3600$/);
  });

  it("refuses a failed check, or one solved for another site, without spending the network's sessions", async () => {
    await asDemo();
    // A solve for another host is logged: on the real site it means the widget's hostnames are wrong.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer.success = false;
    expect((await post({ turnstileToken: 'solve' })).status).toBe(403);
    answer.success = true; answer.hostname = 'elsewhere.example';
    const res = await post({ turnstileToken: 'solve' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: 'bot_check_failed' });
    expect(res.headers.get('set-cookie')).toBeNull();
    answer.hostname = 'try.oswstudio.com';
    expect((await post({ turnstileToken: 'solve' }, '203.0.113.7', 'other.example')).status).toBe(403);
    expect((await post({ turnstileToken: 'solve' }, '203.0.113.7', 'try.oswstudio.com:443')).status).toBe(200);
    expect((await post({ turnstileToken: 'solve' })).status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("stops a network at its sessions for the day, and says when it can have more", async () => {
    await asDemo();
    expect((await post({ turnstileToken: 'a' })).status).toBe(200);
    expect((await post({ turnstileToken: 'b' })).status).toBe(200);
    const res = await post({ turnstileToken: 'c' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'trial_limit' });
    expect(body.resetAt).toBe(Date.parse(new Date(NOW).toISOString().slice(0, 10) + 'T00:00:00Z') + 86_400_000);
    expect((await post({ turnstileToken: 'd' }, '198.51.100.9')).status).toBe(200);
  });

  it('refuses a network with no sessions left before asking Cloudflare', async () => {
    await asDemo();
    process.env.TRIAL_DAILY_CAPS = '1,20,150';
    expect((await post({ turnstileToken: 'a' })).status).toBe(200);
    siteverify.mockClear();
    const res = await post({ turnstileToken: 'b' });
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toMatchObject({ code: 'trial_limit' });
    expect(siteverify).not.toHaveBeenCalled();
  });

  it('stops asking Cloudflare for an address after ten failed checks in a day', async () => {
    await asDemo();
    answer.success = false;
    for (let i = 0; i < 10; i++) expect((await post({ turnstileToken: `x${i}` })).status).toBe(403);
    expect(siteverify).toHaveBeenCalledTimes(10);
    const res = await post({ turnstileToken: 'x10' });
    expect(res.status).toBe(429);
    expect(siteverify).toHaveBeenCalledTimes(10);
    // Another network is not held to it.
    answer.success = true;
    expect((await post({ turnstileToken: 'y' }, '198.51.100.9')).status).toBe(200);
  });

  it("does not hold Cloudflare's outages against an address", async () => {
    await asDemo();
    // More than the ten failed checks an address may have in a day.
    for (let i = 0; i < 12; i++) {
      siteverify.mockRejectedValueOnce(new Error('down'));
      expect((await post({ turnstileToken: `x${i}` })).status).toBe(503);
    }
    expect((await post({ turnstileToken: 'solve' })).status).toBe(200);
  });

  it('starts one session for two solves sent at once when the network has one left', async () => {
    await asDemo();
    process.env.TRIAL_DAILY_CAPS = '1,20,150';
    const answers = await Promise.all([post({ turnstileToken: 'a' }), post({ turnstileToken: 'b' })]);
    // Both were past the room check when Cloudflare answered, so counting the session is what stops one.
    expect(siteverify).toHaveBeenCalledTimes(2);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 429]);
    await expect(answers.find((res) => res.status === 429)!.json()).resolves.toMatchObject({ code: 'trial_limit' });
  });

  it('refuses a solve longer than 2048 characters without asking Cloudflare', async () => {
    await asDemo();
    expect((await post({ turnstileToken: 'x'.repeat(2049) })).status).toBe(400);
    expect(siteverify).not.toHaveBeenCalled();
    expect((await post({ turnstileToken: 'x'.repeat(2048) })).status).toBe(200);
  });

  it('asks for a solve, and says the trial is unavailable when Cloudflare or the configuration is missing', async () => {
    await asDemo();
    expect((await post({})).status).toBe(400);
    siteverify.mockRejectedValueOnce(new Error('down'));
    const res = await post({ turnstileToken: 'solve' });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'model_unavailable' });
    vi.resetModules();
    delete process.env.TRIAL_SIGNING_KID;
    expect((await post({ turnstileToken: 'solve' })).status).toBe(503);
  });
});
