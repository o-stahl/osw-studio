// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { authorizeUrl, codeChallenge, completeSignIn, pendingSignIn, returnParams, signInReturnProject, startSignIn, SIGN_IN_PARAMS } from '../provider-sign-in';

const PENDING_KEY = 'osw_provider_sign_ins';
const realCrypto = globalThis.crypto;
const pending = (nonce: string, provider: 'openrouter', startedAt = Date.now()) =>
  localStorage.setItem(PENDING_KEY, JSON.stringify({
    [nonce]: { provider, verifier: 'v'.repeat(43), redirectUri: 'https://app.test/', returnProject: 'p1', startedAt },
  }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('codeChallenge', () => {
  it('is the RFC 7636 S256 challenge', async () => {
    // The example pair from RFC 7636 appendix B.
    expect(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('authorizeUrl', () => {
  it('sends OpenRouter a callback carrying the nonce, nothing registered', () => {
    const url = new URL(authorizeUrl({ challenge: 'c', nonce: 'n1', redirectUri: 'http://localhost:30011/' }));
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(url.searchParams.get('callback_url')).toBe('http://localhost:30011/?osw_sign_in=n1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('returnParams', () => {
  it('recovers the code when a provider appended a second "?"', () => {
    const params = returnParams(new URLSearchParams('osw_sign_in=n1?code=abc'));
    expect(params.get('osw_sign_in')).toBe('n1');
    expect(params.get('code')).toBe('abc');
  });
});

describe('pendingSignIn', () => {
  it('recognises only its own returns, so HuggingFace keeps its ?code=', () => {
    pending('n1', 'openrouter');
    expect(pendingSignIn(new URLSearchParams('code=x&osw_sign_in=n1'))?.provider).toBe('openrouter');
    expect(pendingSignIn(new URLSearchParams('code=x&state=hf-state'))).toBeNull();
  });

  it('matches OpenRouter\'s bare ?code= to the newest OpenRouter sign-in, as it drops the callback query', () => {
    // Only the newest-first ordering can be checked here: the provider filter cannot bite until a
    // second `SignInProvider` exists, so there is no other provider to leave out.
    const entry = (provider: string, startedAt: number, returnProject: string) =>
      ({ provider, verifier: 'v'.repeat(43), redirectUri: 'https://app.test/', returnProject, startedAt });
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      older: entry('openrouter', Date.now() - 60_000, 'older'),
      newer: entry('openrouter', Date.now() - 1_000, 'newer'),
    }));
    expect(pendingSignIn(new URLSearchParams('code=x'))?.returnProject).toBe('newer');
  });


  it('forgets a sign-in started too long ago', () => {
    pending('n1', 'openrouter', Date.now() - 60 * 60_000);
    expect(pendingSignIn(new URLSearchParams('code=x&osw_sign_in=n1'))).toBeNull();
  });
});

describe('completeSignIn', () => {
  it('trades an OpenRouter code for its key with the stored verifier, once', async () => {
    pending('n1', 'openrouter');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await completeSignIn(new URLSearchParams('code=xyz&osw_sign_in=n1'));
    expect(result).toEqual({ provider: 'openrouter', key: 'sk-or-v1-abc', returnProject: 'p1' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ code: 'xyz', code_verifier: 'v'.repeat(43), code_challenge_method: 'S256' });
    await expect(completeSignIn(new URLSearchParams('code=xyz&osw_sign_in=n1'))).rejects.toMatchObject({ reason: 'state' });
  });

  it('leaves a return with someone else\'s state alone, such as HuggingFace\'s', async () => {
    pending('n1', 'openrouter');
    vi.stubGlobal('fetch', vi.fn());
    await expect(completeSignIn(new URLSearchParams('code=xyz&state=other'))).rejects.toMatchObject({ reason: 'state' });
  });

  it('claims no bare ?code= when no sign-in is pending, and exchanges nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeSignIn(new URLSearchParams('code=x'))).rejects.toMatchObject({ reason: 'state' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a cancelled sign-in as denied, without exchanging anything', async () => {
    pending('n1', 'openrouter');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeSignIn(new URLSearchParams('error=access_denied&osw_sign_in=n1'))).rejects.toMatchObject({ reason: 'denied' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('completeSignIn, failed exchanges', () => {
  it('refuses a key from a response that is not ok', async () => {
    pending('n1', 'openrouter');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 401 })));
    await expect(completeSignIn(new URLSearchParams('code=xyz&osw_sign_in=n1'))).rejects.toMatchObject({ reason: 'exchange' });
  });

  it('exchanges nothing for a return that carries no code', async () => {
    pending('n1', 'openrouter');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeSignIn(new URLSearchParams('osw_sign_in=n1'))).rejects.toMatchObject({ reason: 'exchange' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('startSignIn', () => {
  const stored = () => JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Record<string, {
    provider: string; verifier: string; redirectUri: string; returnProject: string | null;
  }> | null;
  const fakePopup = () => ({ location: { href: '' }, close: vi.fn() });

  it('opens the sign-in in a popup, and keeps no project to return to there', async () => {
    window.history.replaceState(null, '', '/?project=p1');
    const popup = fakePopup();
    const open = vi.fn(() => popup);
    vi.stubGlobal('open', open);

    await expect(startSignIn('openrouter', { popup: true })).resolves.toBe(true);

    expect(open).toHaveBeenCalledTimes(1);
    const entries = Object.entries(stored() ?? {});
    expect(entries).toHaveLength(1);
    const [nonce, entry] = entries[0];
    expect(entry).toMatchObject({ provider: 'openrouter', redirectUri: `${window.location.origin}/`, returnProject: null });

    const url = new URL(popup.location.href);
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
    expect(new URL(url.searchParams.get('callback_url')!).searchParams.get('osw_sign_in')).toBe(nonce);
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallenge(entry.verifier));
  });

  it('remembers the open project when the sign-in leaves this page', async () => {
    window.history.replaceState(null, '', '/?project=p1');
    // Navigating away is not implemented in jsdom; only the stored entry is checked.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(startSignIn('openrouter')).resolves.toBe(true);
    errors.mockRestore();
    expect(Object.values(stored() ?? {})[0]?.returnProject).toBe('p1');
  });

  it('forgets the sign-in and reports false when the popup is blocked', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    await expect(startSignIn('openrouter', { popup: true })).resolves.toBe(false);
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('forgets the sign-in and closes the popup when there is no crypto.subtle to sign in with', async () => {
    const popup = fakePopup();
    vi.stubGlobal('open', vi.fn(() => popup));
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => realCrypto.getRandomValues(b), subtle: undefined });
    await expect(startSignIn('openrouter', { popup: true })).rejects.toThrow();
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.href).toBe('');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('SIGN_IN_PARAMS', () => {
  it('names every parameter a return leaves in the address, the nonce included', () => {
    expect(SIGN_IN_PARAMS).toEqual(expect.arrayContaining(['code', 'state', 'error', 'error_description', 'osw_sign_in']));
  });
});

describe('signInReturnProject', () => {
  const at = (search: string) => window.history.replaceState(null, '', `/${search}`);
  const entry = (provider: string, startedAt: number, returnProject: string) =>
    ({ provider, verifier: 'v'.repeat(43), redirectUri: 'https://app.test/', returnProject, startedAt });

  it('gives the project a returning sign-in started from', () => {
    pending('n1', 'openrouter');
    at('?code=xyz&osw_sign_in=n1');
    expect(signInReturnProject()).toBe('p1');
  });

  it('gives the newest OpenRouter sign-in\'s project for a bare ?code= return', () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      older: entry('openrouter', Date.now() - 60_000, 'older'),
      newer: entry('openrouter', Date.now() - 1_000, 'newer'),
    }));
    at('?code=xyz');
    expect(signInReturnProject()).toBe('newer');
  });

  it('gives nothing when the page is not a sign-in return', () => {
    pending('n1', 'openrouter');
    at('?project=p1');
    expect(signInReturnProject()).toBeNull();
    // The nonce alone is the callback before the provider has answered, not a return.
    at('?osw_sign_in=n1');
    expect(signInReturnProject()).toBeNull();
  });

  it('gives nothing when no sign-in is pending, or the pending one has expired', () => {
    at('?code=xyz&osw_sign_in=n1');
    expect(signInReturnProject()).toBeNull();
    pending('n1', 'openrouter', Date.now() - 60 * 60_000);
    expect(signInReturnProject()).toBeNull();
  });
});
