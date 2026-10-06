/**
 * HuggingFace Auth — Client-side PKCE OAuth via @huggingface/hub
 *
 * Supports two auth methods:
 * 1. OAuth "Sign in with HuggingFace" — client-side PKCE, no server routes needed
 * 2. API key paste — available everywhere
 *
 * Both methods store tokens in localStorage via configManager.
 */

import { oauthLoginUrl, oauthHandleRedirectIfPresent } from '@huggingface/hub';
import { configManager } from '@/lib/config/storage';

export interface HFCapabilities {
  oauthAvailable: boolean;
  clientId: string | null;
  scopes: string;
  codexAvailable: boolean;
}

let capabilities: Promise<HFCapabilities> | null = null;

/**
 * Check if OAuth is available (only on HF Spaces with OAUTH_CLIENT_ID set)
 * and whether Codex auth is supported (not on HF Spaces — cookies blocked).
 */
export function checkHFCapabilities(): Promise<HFCapabilities> {
  // The answer cannot change while the page is open, and several panels ask for it.
  capabilities ??= (async () => {
    const res = await fetch('/api/auth/hf/capabilities', {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      capabilities = null; // only an answer is kept; a failed request may be asked again
      return { oauthAvailable: false, clientId: null, scopes: 'openid profile', codexAvailable: true };
    }
    return res.json() as Promise<HFCapabilities>;
  })().catch((err) => {
    capabilities = null;
    throw err;
  });
  return capabilities;
}

/**
 * Redirect to HF OAuth login using client-side PKCE.
 * The @huggingface/hub library handles code verifier generation and storage.
 */
export async function loginHF(clientId: string, scopes: string): Promise<void> {
  const url = await oauthLoginUrl({
    clientId,
    scopes,
    // Redirect to the app root; the open project is restored post-OAuth from the
    // sessionStorage stash (hf_oauth_return_project) so we don't vary the
    // registered redirect_uri that HF validates against.
    redirectUrl: window.location.origin + '/',
  });
  window.location.href = url;
}

/**
 * Handle OAuth redirect if present.
 * Call on page load — returns OAuthResult if we just came back from HF auth, false otherwise.
 */
export { oauthHandleRedirectIfPresent };

export const PUBLISH_SCOPE = 'contribute-repos';

/**
 * Whether the stored HF connection is allowed to create/push Spaces.
 * - OAuth tokens record their granted `scopes`; they must include the publish scope, otherwise the
 *   caller should prompt a re-consent (the scopes are known, and it's missing).
 * - Pasted tokens record no `scopes`; we can't introspect them, so we assume the token carries the
 *   needed permission and let a 403 at publish time surface if it doesn't.
 */
export function hasPublishScope(): boolean {
  const auth = configManager.getHFAuth();
  if (!auth?.access_token) return false;
  if (!auth.scopes) return true;
  return auth.scopes.split(/\s+/).includes(PUBLISH_SCOPE);
}
