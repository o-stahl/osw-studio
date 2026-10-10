/**
 * Codex OAuth — Interactive login and token management for ChatGPT subscription access
 *
 * The long-lived refresh_token is stored in an HttpOnly cookie (`codexCookieName`: osw_codex_rt, `__Host-` prefixed where cookies are Secure)
 * and never exposed to JavaScript. Only the short-lived access_token (~1 hour)
 * is kept in localStorage.
 */

import { translator } from '@/lib/i18n/runtime';
import { CodexAuthData } from '@/lib/llm/providers/types';
import { configManager } from '@/lib/config/storage';

export interface CodexLoginInfo {
  authorizationUrl: string;
  manualCallback: boolean;
}

/** Start the OpenAI browser PKCE login flow. */
export async function startCodexLogin(): Promise<CodexLoginInfo> {
  const res = await fetch('/api/auth/codex/connect', {
    method: 'POST',
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || translator()('settings.codexStartFailed'));
  return data;
}

/** Exchange a copied browser redirect URL when localhost callback is unavailable. */
export async function completeCodexLogin(redirectUrl: string): Promise<CodexAuthData> {
  const res = await fetch('/api/auth/codex/connect', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ redirectUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || translator()('settings.codexCompleteFailed'));
  return data;
}

/** Poll until the localhost callback creates the tokens. */
export async function pollCodexLogin(): Promise<CodexAuthData | null> {
  const res = await fetch('/api/auth/codex/connect', {
    method: 'PUT',
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 202) return null;
  if (!res.ok) throw new Error(data.error || translator()('settings.codexCompleteFailed'));
  return data;
}

/**
 * Delete the HttpOnly refresh token cookie and clear localStorage.
 */
export async function disconnectCodex(): Promise<void> {
  const res = await fetch('/api/auth/codex/disconnect', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error('Failed to clear server session');
  }
  configManager.clearCodexAuth();
}

/**
 * Check whether the server has a refresh token cookie set.
 */
export async function checkCodexStatus(): Promise<boolean> {
  const res = await fetch('/api/auth/codex/status', {
    credentials: 'same-origin',
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.hasRefreshToken;
}

/**
 * Refresh the access token using the HttpOnly cookie. The client sends no
 * token — the server reads it from the cookie automatically.
 */
export async function refreshAccessToken(): Promise<CodexAuthData> {
  const res = await fetch('/api/auth/codex/token', {
    method: 'POST',
    credentials: 'same-origin',
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Token refresh failed' }));
    throw new Error(data.error || `Token refresh failed: ${res.status}`); // i18n-ignore: a background refresh's failure, only logged
  }

  // Server returns { access_token, expires_at }
  return res.json();
}

/**
 * Ensure the stored Codex token is valid. Refreshes if expired.
 * Returns the valid access token, or throws if refresh fails.
 */
export async function ensureValidCodexToken(): Promise<string> {
  const auth = configManager.getCodexAuth();
  if (!auth) {
    throw new Error('ChatGPT session not found. Please log in via Settings.'); // i18n-ignore: stored in the stopped event and shown raw as its details
  }

  if (!configManager.isCodexTokenExpired()) {
    return auth.access_token;
  }

  // Token expired or near-expiry — refresh via HttpOnly cookie
  try {
    const refreshed = await refreshAccessToken();
    configManager.setCodexAuth(refreshed);
    return refreshed.access_token;
  } catch {
    configManager.clearCodexAuth();
    throw new Error('ChatGPT session expired. Please re-authenticate in Settings.'); // i18n-ignore: stored in the stopped event and shown raw as its details
  }
}
