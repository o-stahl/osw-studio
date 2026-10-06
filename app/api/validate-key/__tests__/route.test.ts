import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A rejected key and a check that could not be made are different answers. The paste field tells
 * the person to fix their key for one and to try again for the other.
 */

import { POST } from '../route';

const call = (body: unknown) =>
  POST(new NextRequest('http://localhost:3000/api/validate-key', { method: 'POST', body: JSON.stringify(body) }));

afterEach(() => vi.unstubAllGlobals());

describe('/api/validate-key', () => {
  it('answers valid: false when the provider rejects the key', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    const response = await call({ apiKey: 'sk-or-x', provider: 'openrouter' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: false });
  });

  it('answers 502 when the provider cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const response = await call({ apiKey: 'sk-or-x', provider: 'openrouter' });
    expect(response.status).toBe(502);
  });

  it('answers 400 for a request without a key', async () => {
    // Refused before any provider is asked: a regression here must not reach the network.
    const fetchMock = vi.fn(async () => { throw new Error('fetch must not be called'); });
    vi.stubGlobal('fetch', fetchMock);
    expect((await call({ provider: 'openrouter' })).status).toBe(400);
    const broken = await POST(new NextRequest('http://localhost:3000/api/validate-key', { method: 'POST', body: '{' }));
    expect(broken.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api/validate-key — Pollinations and Vercel', () => {
  const answering = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const authOf = (fetchMock: ReturnType<typeof answering>) =>
    ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization;

  it('accepts a Pollinations key only when its account endpoint says valid: true', async () => {
    const fetchMock = answering(200, { valid: true });
    expect(await (await call({ apiKey: 'sk_pol', provider: 'pollinations' })).json()).toEqual({ valid: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gen.pollinations.ai/account/key');
    expect(authOf(fetchMock)).toBe('Bearer sk_pol');
  });

  it('refuses a Pollinations key the account endpoint answers 200 with valid: false', async () => {
    answering(200, { valid: false });
    expect(await (await call({ apiKey: 'sk_pol', provider: 'pollinations' })).json()).toEqual({ valid: false });
  });

  it('checks a Vercel key against its credits endpoint with the key', async () => {
    const fetchMock = answering(200, { balance: '5.00' });
    expect(await (await call({ apiKey: 'vck_x', provider: 'vercel' })).json()).toEqual({ valid: true });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://ai-gateway.vercel.sh/v1/credits');
    expect(authOf(fetchMock)).toBe('Bearer vck_x');
  });

  it('refuses a Vercel key the credits endpoint rejects', async () => {
    answering(401, { error: 'unauthorized' });
    expect(await (await call({ apiKey: 'vck_x', provider: 'vercel' })).json()).toEqual({ valid: false });
  });
});
