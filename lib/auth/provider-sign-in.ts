/**
 * Sign in to a provider instead of copying a key: OAuth authorization code with PKCE, entirely in
 * the browser. The provider sends the user back to the app with a code, the browser exchanges it
 * for a key, and the key is stored like a pasted one. Both token endpoints allow browser calls, so
 * the key never passes through this app's server.
 *
 * OpenRouter accepts any https callback and localhost on any port, with nothing registered, so it
 * works on every surface. The return lands on the app root with `?code=`, which HuggingFace's
 * sign-in also uses; HuggingFace's carries a `state`, OpenRouter's does not.
 */

type SignInProvider = 'openrouter';

/**
 * Sign-ins in flight, keyed by a nonce. Kept in localStorage rather than sessionStorage so a sign-in
 * opened in a popup, which has its own session, finds it too.
 */
const PENDING_KEY = 'osw_provider_sign_ins';
const NONCE_PARAM = 'osw_sign_in';
const PENDING_TTL_MS = 15 * 60_000;

interface PendingSignIn {
  provider: SignInProvider;
  verifier: string;
  redirectUri: string;
  /** The project open when sign-in started, restored on return. */
  returnProject: string | null;
  startedAt: number;
}

function readPending(): Record<string, PendingSignIn> {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}') as Record<string, PendingSignIn>;
    const now = Date.now();
    return Object.fromEntries(Object.entries(all).filter(([, p]) => now - p.startedAt < PENDING_TTL_MS));
  } catch {
    return {};
  }
}

function writePending(all: Record<string, PendingSignIn>): void {
  try {
    if (Object.keys(all).length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    // Without storage the return cannot be matched; it fails as a sign-in that did not finish.
  }
}

/**
 * The return's parameters, tolerating a provider that appends `?code=` to a callback that already
 * has a query, which leaves `osw_sign_in=<nonce>?code=<code>`.
 */
export function returnParams(search: URLSearchParams): URLSearchParams {
  const nonce = search.get(NONCE_PARAM);
  if (!nonce || !nonce.includes('?')) return search;
  const [clean, rest] = nonce.split('?', 2);
  const merged = new URLSearchParams(search);
  merged.set(NONCE_PARAM, clean);
  for (const [k, v] of new URLSearchParams(rest)) merged.set(k, v);
  return merged;
}

/**
 * Which pending sign-in a return belongs to. OpenRouter keeps the callback's path but drops its
 * query, so its return carries only `code` (the nonce survives only if a provider keeps it): that is
 * matched to the newest OpenRouter sign-in this browser started. A second one started alongside it
 * would then fail its code exchange, which reads as a sign-in that did not finish. A return with a
 * `state` is someone else's, such as HuggingFace's.
 */
function nonceFrom(search: URLSearchParams): string | null {
  const params = returnParams(search);
  const explicit = params.get(NONCE_PARAM);
  if (explicit) return explicit;
  if (params.has('state') || !params.has('code')) return null;
  const newest = Object.entries(readPending())
    .filter(([, p]) => p.provider === 'openrouter')
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)[0];
  return newest?.[0] ?? null;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Where the provider sends the user back: the app root, which every surface serves. */
function appRoot(): string {
  return `${window.location.origin}/`;
}

export function authorizeUrl(params: { challenge: string; nonce: string; redirectUri: string }): string {
  const callback = new URL(params.redirectUri);
  callback.searchParams.set(NONCE_PARAM, params.nonce);
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callback.toString());
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Go to the provider's sign-in page. With `popup`, it opens in a separate window and this page
 * stays as it is, so whatever was waiting on the connection (a stopped task's card that continues
 * once a provider connects) is still there when it lands. Returns false when the popup was blocked.
 *
 * The popup is opened before anything is awaited, while the click still counts as the user's.
 */
export async function startSignIn(provider: SignInProvider, options: { popup?: boolean } = {}): Promise<boolean> {
  const verifier = randomString();
  const nonce = randomString(16);
  const redirectUri = appRoot();
  writePending({
    ...readPending(),
    [nonce]: {
      provider,
      verifier,
      redirectUri,
      returnProject: options.popup ? null : new URLSearchParams(window.location.search).get('project'),
      startedAt: Date.now(),
    },
  });
  const forget = () => {
    const all = readPending();
    delete all[nonce];
    writePending(all);
  };
  const popup = options.popup ? window.open('', 'osw-sign-in', 'popup,width=520,height=720') : null;
  if (options.popup && !popup) {
    forget();
    return false;
  }
  let challenge: string;
  try {
    challenge = await codeChallenge(verifier);
  } catch (err) {
    // No crypto.subtle on an insecure origin (http on a LAN address): nothing to sign in with.
    popup?.close();
    forget();
    throw err;
  }
  const url = authorizeUrl({ challenge, nonce, redirectUri });
  if (popup) popup.location.href = url;
  else window.location.href = url;
  return true;
}

/** The sign-in this page is the return of, if it is one. */
export function pendingSignIn(search: URLSearchParams = new URLSearchParams(window.location.search)): PendingSignIn | null {
  const nonce = nonceFrom(search);
  return nonce ? readPending()[nonce] ?? null : null;
}

/**
 * The project a sign-in returning to this page started from, read before the return is finished
 * (finishing it clears the entry). The roots open it straight away, so the person lands back in
 * their project rather than on a list while the code is exchanged.
 */
export function signInReturnProject(): string | null {
  if (typeof window === 'undefined') return null;
  const search = returnParams(new URLSearchParams(window.location.search));
  if (!search.has('code') && !search.has('error')) return null;
  return pendingSignIn(search)?.returnProject ?? null;
}

export class SignInError extends Error {
  constructor(public readonly reason: 'state' | 'exchange' | 'denied') {
    super(reason);
    this.name = 'SignInError';
  }
}

/**
 * Finish the sign-in this page is the return of: trade the code for a key. Clears the entry
 * whatever happens, so a failed return cannot be replayed.
 */
export async function completeSignIn(raw: URLSearchParams): Promise<{ provider: SignInProvider; key: string; returnProject: string | null }> {
  const search = returnParams(raw);
  const nonce = nonceFrom(search);
  const all = readPending();
  const pending = nonce ? all[nonce] : undefined;
  if (nonce) {
    delete all[nonce];
    writePending(all);
  }
  if (!pending) throw new SignInError('state');
  if (search.get('error')) throw new SignInError('denied');
  const code = search.get('code');
  if (!code) throw new SignInError('exchange');

  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
  });
  const key = response.ok ? (await response.json())?.key : undefined;
  if (typeof key !== 'string' || !key) throw new SignInError('exchange');
  return { provider: 'openrouter', key, returnProject: pending.returnProject };
}

/** The return's own parameters, removed from the URL after sign-in. */
export const SIGN_IN_PARAMS = ['code', 'state', 'error', 'error_description', NONCE_PARAM];
