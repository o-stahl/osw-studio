/**
 * Refuse a write to the API that a browser sent from another site's page (SEC-4).
 *
 * The API authenticates with the session cookie, and a browser attaches it to a cross-site form
 * post or fetch. Browsers send `Origin` on every POST, PUT, PATCH and DELETE, so one naming another
 * site is refused. A request with no `Origin` did not come from a browser page (a server, a CLI, an
 * MCP client) and passes. Reads change nothing and pass.
 *
 * Every `/api/` route is covered unless listed in `CROSS_ORIGIN_ROUTES`, so a new route is protected
 * without anyone remembering to add it. Kept free of Node-only imports: middleware runs it.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** API routes other origins call by design, each with the reason. */
export const CROSS_ORIGIN_ROUTES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^\/api\/deployments\/[^/]+\/functions\//, why: 'published sites call their functions, from custom domains too' },
  { pattern: /^\/api\/analytics\/(track|interaction)$/, why: 'published sites report pageviews and interactions' },
  { pattern: /^\/api\/mcp$/, why: 'the MCP endpoint itself, authenticated by bearer token' },
  { pattern: /^\/api\/mcp\/oauth\/(token|register|revoke)$/, why: 'OAuth endpoints MCP clients call, some from their own web origin' },
  { pattern: /^\/api\/mcp\/files\/[^/]+$/, why: 'one-time transfer URLs, authenticated by the token in the path' },
];

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

/** Whether to refuse this request: a write to a covered API route from another origin. */
export function isCrossOriginWrite(method: string, pathname: string, headers: Headers): boolean {
  if (!WRITE_METHODS.has(method.toUpperCase())) return false;
  if (!pathname.startsWith('/api/')) return false;
  if (CROSS_ORIGIN_ROUTES.some((r) => r.pattern.test(pathname))) return false;
  const origin = headers.get('origin');
  if (origin === null) return false;
  // `null` is a sandboxed frame or a privacy-redirected request: not this app's own page.
  const host = origin === 'null' ? null : hostOf(origin);
  return !host || !ownHosts(headers).has(host);
}
