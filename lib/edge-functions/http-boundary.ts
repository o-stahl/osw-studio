/**
 * What crosses between a visitor's request and function code, in each direction.
 *
 * Functions are written by whoever can edit a project, and they run on the app's own origin, so the
 * visitor's browser sends them the app's cookies: the admin session (`osw_session`), the ChatGPT
 * refresh token (`osw_codex_rt`) and the rest. Every cookie the app and the gateway set is named
 * `osw_…`, so that prefix is the boundary: those never reach function code and a function cannot set
 * one. A site's own cookies (the Blog template's `blog_session`) pass both ways.
 */

const REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'origin',
  'referer',
  'user-agent',
  'x-requested-with',
]);

/**
 * Response headers a function may set. Anything that changes how the browser treats the app's origin
 * (CSP, CORS, HSTS, `refresh`) is left out.
 */
const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-disposition',
  'content-language',
  'cache-control',
  'expires',
  'vary',
  'location',
  'etag',
  'last-modified',
]);

/**
 * `x-` headers with a meaning to something other than the browser: a front proxy serving a file
 * from disk (`x-accel-redirect`, `x-sendfile`), Next.js routing (`x-middleware-*`, `x-nextjs-*`), and
 * the gateway's credential for this instance.
 */
const RESERVED_X_HEADER = /^x-(accel-|sendfile$|lighttpd-send-file$|middleware-|nextjs-|instance-api-key$)/;

function isOpenXHeader(name: string): boolean {
  return name.startsWith('x-') && !RESERVED_X_HEADER.test(name);
}

/** `__Host-` and `__Secure-` are part of a cookie's name but not of what it is. */
function isAppCookie(name: string): boolean {
  return name.trim().replace(/^__(host|secure)-/i, '').toLowerCase().startsWith('osw_');
}

/** The visitor's cookie header with every app cookie removed (empty when nothing is left). */
function siteCookies(header: string): string {
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !isAppCookie(pair.split('=', 1)[0]))
    .join('; ');
}

/**
 * A `Set-Cookie` value a function may send, or null for one it may not. `Domain` is removed so the
 * cookie stays on this host rather than being planted on every subdomain of it.
 */
function siteSetCookie(value: string): string | null {
  const [pair, ...attributes] = value.split(';');
  const name = pair.split('=', 1)[0].trim();
  // A nameless cookie (`=osw_session=x`) comes back from the browser as `osw_session=x`.
  if (!pair.includes('=') || !name || isAppCookie(name)) return null;
  const kept = attributes.filter((a) => a.trim().split('=', 1)[0].trim().toLowerCase() !== 'domain');
  return [pair.trim(), ...kept.map((a) => a.trim())].filter(Boolean).join('; ');
}

/** The headers function code sees, from the visitor's request. */
export function functionRequestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    // `x-` headers are only ever set by the caller on purpose, such as an API key for the function.
    if (REQUEST_HEADERS.has(name) || isOpenXHeader(name)) out[name] = value;
  });
  const cookie = headers.get('cookie');
  const kept = cookie ? siteCookies(cookie) : '';
  if (kept) out.cookie = kept;
  return out;
}

/** The headers sent back to the visitor, from what the function returned. */
export function functionResponseHeaders(headers: Record<string, string>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === 'set-cookie') {
      const cookie = siteSetCookie(value);
      if (cookie) out.append('set-cookie', cookie);
    } else if (RESPONSE_HEADERS.has(name) || isOpenXHeader(name)) {
      out.set(name, value);
    }
  }
  return out;
}
