/**
 * Whether cookies are Secure: in production, unless `SECURE_COOKIES=false` (plain HTTP before a
 * certificate, or local testing). No imports, so middleware, server actions and modules the browser
 * also loads can share it.
 */
export function secureCookies(): boolean {
  return process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production';
}
