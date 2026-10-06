import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * The live allowance on the caller's key: forwarded to a fixed host per provider, parsed there,
 * and `{ quota: { kind: 'none' } }` whenever there is nothing to say.
 */

vi.mock('@/lib/llm/provider-status', () => ({
  parseOpenRouterKey: (body: unknown) => ({ parsed: 'openrouter', body }),
  parsePollinationsBalance: (body: unknown) => ({ parsed: 'pollinations', body }),
}));

import { POST } from '../route';

const NONE = { quota: { kind: 'none' } };
const req = (body: unknown, broken = false) =>
  ({ json: async () => { if (broken) throw new SyntaxError('bad'); return body; } }) as unknown as NextRequest;

function upstream(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const headersOf = (fetchMock: ReturnType<typeof upstream>) => (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

afterEach(() => vi.unstubAllGlobals());

describe('/api/provider-status', () => {
  it('reads OpenRouter\'s key endpoint with the key and attribution', async () => {
    const fetchMock = upstream(200, { data: { limit: 50 } });
    const res = await POST(req({ provider: 'openrouter', apiKey: 'sk-or-x' }));
    expect(await res.json()).toEqual({ parsed: 'openrouter', body: { data: { limit: 50 } } });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/key');
    expect(headersOf(fetchMock)).toMatchObject({ Authorization: 'Bearer sk-or-x', 'X-Title': 'OSW Studio' });
  });

  it('reads Pollinations\' balance endpoint with the key', async () => {
    const fetchMock = upstream(200, { balance: 3 });
    const res = await POST(req({ provider: 'pollinations', apiKey: 'sk_pol' }));
    expect(await res.json()).toEqual({ parsed: 'pollinations', body: { balance: 3 } });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://gen.pollinations.ai/account/balance');
    expect(headersOf(fetchMock).Authorization).toBe('Bearer sk_pol');
  });

  it.each(['openrouter', 'pollinations'])('answers none when %s refuses', async (provider) => {
    upstream(401, { error: 'no' });
    expect(await (await POST(req({ provider, apiKey: 'k' }))).json()).toEqual(NONE);
  });

  it('answers none when the provider cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await (await POST(req({ provider: 'openrouter', apiKey: 'k' }))).json()).toEqual(NONE);
  });

  it('asks no one for an unknown provider, a missing key or broken JSON', async () => {
    const fetchMock = upstream(200, {});
    expect(await (await POST(req({ provider: 'anthropic', apiKey: 'k' }))).json()).toEqual(NONE);
    expect(await (await POST(req({ provider: 'openrouter' }))).json()).toEqual(NONE);
    expect(await (await POST(req({ provider: 'openrouter', apiKey: 42 }))).json()).toEqual(NONE);
    expect(await (await POST(req(null, true))).json()).toEqual(NONE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
