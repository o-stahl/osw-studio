/**
 * Where published sites are served, relative to the studio.
 *
 * A published site runs code the studio does not control (agent output, imported templates, third
 * party scripts, other tenants), so it must not share the studio's origin: on the same origin its
 * script can call the studio's API with the visitor's session and read the keys the studio keeps
 * in `localStorage`. Three ways an install can be set up:
 *
 * - `proxy` (`STATIC_PROXY=true`, the generated Caddyfile): each site on its own host, a slug
 *   subdomain of the app host or a custom domain.
 * - `host` (`SITES_ORIGIN`; the desktop app sets it to a second local port): every site under
 *   `/deployments/{id}/` on one origin that is not the studio's.
 * - `same-origin`: neither configured; sites are served on the studio's origin. Shown as a warning
 *   in the deployments view and in the docs.
 *
 * In the first two, the studio host redirects site documents to where they live and a site host
 * answers only what a site needs (`isSitePath`). Edge-safe: no Node or database imports, since
 * middleware uses it.
 */

export type SitesMode = 'proxy' | 'host' | 'same-origin';

const DEFAULT_APP_URL = 'http://localhost:3000';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL;
}

/** The origin of a URL, or null for one that does not parse. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The configured origin for sites, when it is a real, different origin from the studio's. */
export function sitesOrigin(): string | null {
  const origin = originOf(process.env.SITES_ORIGIN);
  if (!origin || origin === originOf(appUrl())) return null;
  return origin;
}

export function sitesMode(): SitesMode {
  if (process.env.STATIC_PROXY === 'true') return 'proxy';
  if (sitesOrigin()) return 'host';
  return 'same-origin';
}

/** The app host without scheme or port, as the slug subdomains hang off it. */
function appHostname(): string {
  try {
    return new URL(appUrl()).hostname;
  } catch {
    return '';
  }
}

/** The origin a deployment's site is served from. */
export function siteOriginFor(deployment: { slug?: string | null; customDomain?: string | null }): string {
  if (deployment.customDomain) return `https://${deployment.customDomain}`;
  const mode = sitesMode();
  if (mode === 'proxy' && deployment.slug) return `https://${deployment.slug}.${appHostname()}`;
  const sites = mode === 'host' ? sitesOrigin() : null;
  if (sites) return sites;
  return originOf(appUrl()) ?? appUrl();
}

/**
 * The host a request was addressed to: the Host header, which Caddy and the desktop forwarder pass
 * through unchanged. Not X-Forwarded-Host, which a page can set itself on a same-origin request
 * (a DNS-rebinding page is same-origin with the server it rebinds to).
 */
export function requestHost(headers: Headers): string {
  return (headers.get('host') || '').trim().toLowerCase();
}

/**
 * Whether a request arrived on a host that serves sites rather than the studio.
 *
 * With a sites address, that address. With the proxy, any host that is not the studio's: a slug
 * subdomain or a custom domain, from which the generated Caddyfile forwards only site paths.
 */
export function isSiteHost(host: string): boolean {
  if (!host) return false;
  const mode = sitesMode();
  // The sites address is matched with its port: on desktop it differs from the studio's only there,
  // and any loopback name for that port is the same server, so it is the sites host too.
  if (mode === 'host') {
    const sites = sitesOrigin();
    if (!sites) return false;
    const url = new URL(sites);
    if (url.host === host) return true;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const match = host.match(/^(.*?)(?::(\d+))?$/)!;
    return LOOPBACK.has(url.hostname) && LOOPBACK.has(match[1]) && (match[2] || '80') === port;
  }
  if (mode === 'proxy') return !isStudioHost(host);
  return false;
}

/**
 * The studio's own host: the app's host name or loopback (which Caddy's own requests and the
 * server itself use). Site documents asked for here are redirected to where they live. A host that
 * is neither this nor a site host (an operator's own custom-domain proxy without STATIC_PROXY) is
 * neither redirected nor limited to site paths, so it cannot loop or lock the studio out.
 */
export function isStudioHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '');
  return name === appHostname() || LOOPBACK.has(name);
}

/** What a site host answers: the sites themselves, their review copies, functions and analytics. */
export function isSitePath(pathname: string): boolean {
  return pathname.startsWith('/deployments/')
    || pathname.startsWith('/review/')
    || /^\/api\/deployments\/[^/]+\/functions\//.test(pathname)
    || pathname === '/api/analytics/track'
    || pathname === '/api/analytics/interaction';
}

/**
 * Whether a studio-host request is for a site document that now lives elsewhere: the site itself,
 * or its review copy. The review API under `/review/{id}/osw-api/` stays on the studio host, where
 * the studio's review panel calls it.
 */
export function isRelocatedSitePath(pathname: string): boolean {
  if (pathname.startsWith('/deployments/')) return true;
  return /^\/review\/[^/]+(\/|$)/.test(pathname) && !/^\/review\/[^/]+\/osw-api(\/|$)/.test(pathname);
}
