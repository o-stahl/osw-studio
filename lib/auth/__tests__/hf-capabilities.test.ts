import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Whether HuggingFace sign-in is offered cannot change while the page is open, and several panels
 * ask. One answer is kept for the page; a failure is not, so the next panel to ask tries again.
 */

vi.mock('@huggingface/hub', () => ({ oauthLoginUrl: vi.fn(), oauthHandleRedirectIfPresent: vi.fn() }));
vi.mock('@/lib/config/storage', () => ({ configManager: {} }));

const ANSWER = { oauthAvailable: true, clientId: 'cid', scopes: 'openid profile', codexAvailable: false };
const FALLBACK = { oauthAvailable: false, clientId: null, scopes: 'openid profile', codexAvailable: true, spaceId: null };

async function load() {
  vi.resetModules();
  return (await import('../hf-auth')).checkHFCapabilities;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('checkHFCapabilities', () => {
  it('asks the server once, however many callers', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(ANSWER), { status: 200 }));
    const check = await load();
    const [a, b] = await Promise.all([check(), check()]);
    expect(await check()).toEqual(ANSWER);
    expect(a).toEqual(ANSWER);
    expect(b).toEqual(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/hf/capabilities', { credentials: 'same-origin' });
  });

  it('answers a failed response with the fallback, and asks again next time', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response('', { status: 500 }))
      .mockImplementation(async () => new Response(JSON.stringify(ANSWER), { status: 200 }));
    const check = await load();
    expect(await check()).toEqual(FALLBACK);
    expect(await check()).toEqual(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows a network failure, and asks again next time', async () => {
    fetchMock
      .mockImplementationOnce(async () => { throw new TypeError('network'); })
      .mockImplementation(async () => new Response(JSON.stringify(ANSWER), { status: 200 }));
    const check = await load();
    await expect(check()).rejects.toThrow('network');
    expect(await check()).toEqual(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
