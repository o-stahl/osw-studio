/**
 * Refuse an API request that a browser sent from a page other than the studio's own.
 *
 * The API authenticates with the session cookie, and a browser attaches it to requests other pages
 * make: a cross-site form post, and with `SameSite=Lax` any fetch from a same-site page, such as a
 * published site on a sibling subdomain. Project code in a sandboxed frame or worker
 * (`lib/sandbox`) runs on an opaque origin and is refused here too. Two headers say where a request
 * came from:
 *
 * - `Sec-Fetch-Site`, which browsers send to HTTPS and localhost addresses and no page can set,
 *   decides when present: `same-origin`, or `none` (the user typed the address or opened a
 *   bookmark), passes; anything else is refused.
 * - Otherwise `Origin`, which browsers send on writes and cross-origin reads (over plain HTTP, and
 *   from browsers too old for `Sec-Fetch-Site`): one naming another host, or `null` (an opaque
 *   origin), is refused.
 *
 * A request with neither passes: it did not come from a browser page (a server, a CLI, an MCP
 * client, the gateway calling an instance), or it is a same-origin read over plain HTTP.
 *
 * Every `/api/` route is covered unless listed in `CROSS_ORIGIN_ROUTES`, so a new route is protected
 * without anyone remembering to add it. Kept free of Node-only imports: middleware runs it.
 */

/** API routes other pages reach by design, each with the reason. */
const CROSS_ORIGIN_ROUTES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^\/api\/deployments\/[^/]+\/functions\//, why: 'published sites call their functions, from custom domains too' },
  { pattern: /^\/api\/analytics\/(track|interaction)$/, why: 'published sites report pageviews and interactions' },
  { pattern: /^\/api\/mcp$/, why: 'the MCP endpoint itself, authenticated by bearer token' },
  { pattern: /^\/api\/mcp\/oauth\/(token|register|revoke)$/, why: 'OAuth endpoints MCP clients call, some from their own web origin' },
  { pattern: /^\/api\/mcp\/oauth\/hold$/, why: 'the consent page redirects here on a navigation an MCP client started from its own site' },
  { pattern: /^\/api\/mcp\/files\/[^/]+$/, why: 'one-time transfer URLs, authenticated by the token in the path' },
  { pattern: /^\/api\/auth\/handoff$/, why: 'the gateway sends the browser here after login, authenticated by the token in the query' },
];

/** `Sec-Fetch-Site` values of the studio's own pages and of the user's own navigation. */
const OWN_FETCH_SITES = new Set(['same-origin', 'none']);

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The hosts this app is reached at. `Host` is what a direct request carries; a reverse proxy that
 * rewrites it to the upstream usually passes the public one as `X-Forwarded-Host`, and where it
 * passes neither, `NEXT_PUBLIC_APP_URL` or `ALLOWED_ORIGINS` names it. `SPACE_HOST` is the
 * HuggingFace Space's public host. The scheme is not compared: the desktop app is plain http.
 */
function ownHosts(headers: Headers): Set<string> {
  const hosts = [
    headers.get('host'),
    headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
    process.env.SPACE_HOST,
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.ALLOWED_ORIGINS ?? '').split(','),
  ];
  return new Set(hosts.map((h) => hostOf(h?.trim())).filter((h): h is string => Boolean(h)));
}

/** Whether to refuse this request: a covered API route, reached from a page that is not the studio's. */
export function isForeignApiRequest(pathname: string, headers: Headers): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (CROSS_ORIGIN_ROUTES.some((r) => r.pattern.test(pathname))) return false;
  const site = headers.get('sec-fetch-site');
  if (site !== null) return !OWN_FETCH_SITES.has(site.toLowerCase());
  const origin = headers.get('origin');
  if (origin === null) return false;
  // `null` is a sandboxed frame or a privacy-redirected request: not this app's own page.
  const host = origin === 'null' ? null : hostOf(origin);
  return !host || !ownHosts(headers).has(host);
}
