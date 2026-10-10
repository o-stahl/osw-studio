export type BackendStatus = {
  backendDown: boolean;
  authExpired: boolean;
};

type Listener = (status: BackendStatus) => void;

const state: BackendStatus = { backendDown: false, authExpired: false };
const listeners = new Set<Listener>();

function notify() {
  const snapshot = { ...state };
  listeners.forEach((l) => l(snapshot));
}

export function markBackendDown(): void {
  if (!state.backendDown) {
    state.backendDown = true;
    notify();
  }
}

export function markBackendUp(): void {
  if (state.backendDown) {
    state.backendDown = false;
    notify();
  }
}

export function markAuthExpired(): void {
  if (!state.authExpired) {
    state.authExpired = true;
    notify();
  }
}

export function clearAuthExpired(): void {
  if (state.authExpired) {
    state.authExpired = false;
    notify();
  }
}

export function getBackendStatus(): BackendStatus {
  return { ...state };
}

export function subscribeBackendStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Auth-gated paths that return 401 when the session cookie is missing or expired.
// Matches middleware.ts.
function isAuthGatedPath(url: string): boolean {
  try {
    const path = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname;
    return path.startsWith('/api/w/') || path.startsWith('/api/admin/');
  } catch {
    return false;
  }
}

// Wraps fetch() for calls to our own Next.js API routes.
// Flips the "backend down" banner on when the server is unreachable (network
// error or 5xx) and off when a request succeeds. A 401 from an auth-gated
// route flips the "auth expired" banner on; a 2xx from one flips it off.
//
// `relaysUpstream`: the route answers 502 for a server it was asked to reach (the mail test's SMTP
// server), so a 502 says nothing either way about this backend.
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: { relaysUpstream?: boolean },
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  try {
    const res = await fetch(input, init);
    if (res.status === 502 && opts?.relaysUpstream) {
      // Neither up nor down: a proxy in front of a stopped backend answers 502 too.
    } else if (res.status >= 500) {
      markBackendDown();
    } else {
      markBackendUp();
    }
    if (isAuthGatedPath(url)) {
      if (res.status === 401) {
        markAuthExpired();
      } else if (res.ok) {
        clearAuthExpired();
      }
    }
    return res;
  } catch (err) {
    // Ignore user-initiated aborts — not a backend failure
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      markBackendDown();
    }
    throw err;
  }
}
