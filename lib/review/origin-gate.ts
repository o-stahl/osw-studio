/**
 * Where a review write may be posted from: the studio's origin (its review panel) and the origin
 * the review copy itself is served from, and nothing else.
 *
 * The analytics allowlist (`getAllowedOrigins`) must not be reused here. It names every slug
 * subdomain and custom domain; those serve tenant-authored HTML and are same-site with the app, so
 * SameSite=Lax does not withhold a review cookie from a request one of them makes. On a write
 * endpoint that would let one tenant forge comments for any visitor holding a review cookie. Only
 * the deployment's own site origin is added (`siteOriginFor`, lib/web/site-origin.ts): when sites
 * are served away from the studio, its review copy is served there too.
 */

import { validateOrigin } from '@/lib/analytics/security';
import { appUrl, siteOriginFor, sitesMode } from '@/lib/web/site-origin';

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    // An unparseable entry matches nothing, which refuses everything rather than widening the gate.
    return url;
  }
}

/** Normalised through URL, so a trailing slash in `NEXT_PUBLIC_APP_URL` still matches a header. */
export function reviewAllowedOrigins(deployment?: { slug?: string | null; customDomain?: string | null } | null): string[] {
  const origins = [originOf(appUrl())];
  if (deployment && sitesMode() !== 'same-origin') {
    const site = siteOriginFor(deployment);
    if (!origins.includes(site)) origins.push(site);
  }
  return origins;
}

export function isReviewOriginAllowed(
  request: Request,
  deployment?: { slug?: string | null; customDomain?: string | null } | null
): boolean {
  return validateOrigin(request, reviewAllowedOrigins(deployment));
}
