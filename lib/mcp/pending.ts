/**
 * The held authorization request that survives a gateway login.
 *
 * Kept apart from the rest of lib/mcp because `middleware.ts` reads it on the Edge runtime, which
 * cannot load the store (SQLite) or anything importing `server-only`.
 */

/** Ten minutes: long enough to sign in, short enough that an abandoned attempt expires unnoticed. */
export const PENDING_MCP_MAX_AGE = 10 * 60;

const secure = () => process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production';

/**
 * `__Host-` wherever cookies are Secure, like the session cookie, so a site on a sibling subdomain
 * cannot park an authorization for the studio to resume. A request held under the old name at
 * upgrade is not resumed; the connector asks again.
 */
export function pendingMcpCookieName(): string {
  return secure() ? '__Host-osw_mcp_pending' : 'osw_mcp_pending';
}

/**
 * Lax, not Strict: the browser arrives back as a top-level navigation from the gateway, and Strict
 * would withhold the cookie on exactly that request. `maxAge: 0` clears it, which a `__Host-` cookie
 * only allows with these same attributes.
 */
export function pendingMcpCookieOptions(maxAge = PENDING_MCP_MAX_AGE) {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, maxAge, path: '/' };
}

/** Cap before a cookie starts being dropped by the browser rather than by us. */
const MAX_LENGTH = 2048;

/**
 * Whether a held value still looks like the authorization query it was stored as.
 *
 * Bounded and required to name a client, so a stray link cannot park an oversized cookie or one
 * that is not an authorization request. It deliberately says nothing about where the value could
 * send the browser: it is spent by assigning to `URL.search`, which cannot reach the path or the
 * host and encodes a fragment, so the redirect lands on the consent screen whatever the value holds.
 * Rejecting path-like values as well looked safer and was not — it refused a client that sends an
 * unencoded `redirect_uri`, killing the sign-in round trip with no message.
 *
 * Control characters still go, because the value travels through a cookie and a redirect header.
 */
export function pendingAuthorizationIsWellFormed(value: string): boolean {
  if (!value || value.length > MAX_LENGTH) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  return /(^|&)client_id=[^&]+/.test(value);
}
