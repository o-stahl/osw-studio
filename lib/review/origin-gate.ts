/**
 * Where a review write may be posted from: the studio's origin (its review panel) and the origin
 * the review copy itself is served from, and nothing else.
 *
 * The analytics allowlist (`getAllowedOrigins`) must not be reused here. It names every slug
 * subdomain and custom domain; those serve tenant-authored HTML and are same-site with the app, so
 * SameSite=Lax does not withhold a review cookie from a request one of them makes. On a write
 * endpoint that would let one tenant forge comments for any visitor holding a review cookie. Only
 * the deployment's own site origin is added (`siteOriginFor`, lib/web/site-origin.ts), and only on
 * its own host: when sites are served away from the studio, its review copy is served there too.
 */

import { validateOrigin } from '@/lib/analytics/security';
import { appUrl, isSiteHost, originOf, requestHost, reviewOriginFor } from '@/lib/web/site-origin';

/**
 * Normalised through URL, so a trailing slash in `NEXT_PUBLIC_APP_URL` still matches a header.
 *
 * The site's own origin counts only on the site's host (`host`). On the studio's host the review
 * routes act as the team on the account session, which the browser also sends with a same-site
 * POST from a site on a sibling subdomain or the shared sites address.
 */
export function reviewAllowedOrigins(
  deployment?: { slug?: string | null; customDomain?: string | null } | null,
  host?: string
): string[] {
  // An unparseable app URL is kept as written: it matches no header, which refuses rather than widens.
  const origins = [originOf(appUrl()) ?? appUrl()];
  if (deployment && host && isSiteHost(host)) {
    const site = reviewOriginFor(deployment);
    if (!origins.includes(site)) origins.push(site);
  }
  return origins;
}

export function isReviewOriginAllowed(
  request: Request,
  deployment?: { slug?: string | null; customDomain?: string | null } | null
): boolean {
  const host = requestHost(request.headers) || new URL(request.url).host;
  return validateOrigin(request, reviewAllowedOrigins(deployment, host));
}
