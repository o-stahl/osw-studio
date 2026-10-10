/**
 * Where a site document now lives, as a redirect. Temporary, since the target follows the
 * deployment's slug and custom domain, which can change; a browser keeps a permanent one.
 *
 * Middleware sends here the studio-host requests for a published site (`/deployments/{id}/...`) or
 * its review copy (`/review/{id}/...`) when sites are served elsewhere (`lib/web/site-origin.ts`).
 * Old links keep working; the document is never served on the studio's origin. A route rather than
 * middleware because the target depends on the deployment's slug or custom domain.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveDeploymentByIdOrSlug } from '@/lib/vfs/adapters/deployment-adapter';
import { appUrl, reviewOriginFor, siteOriginFor, sitesMode } from '@/lib/web/site-origin';

const NOT_FOUND = () => new NextResponse('Not found', { status: 404 });
const PREFIX = '/api/site-location';

// The original path arrives as this route's own path (`/api/site-location/deployments/{id}/...`):
// a query parameter added by a middleware rewrite does not reliably reach the handler. Depending on
// how the rewrite is surfaced, the URL here is the rewritten one or the original; both are accepted.
export async function GET(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const original = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname;
  const url = new URL(`${original}${search}`, 'http://placeholder');
  const match = url.pathname.match(/^\/(deployments|review)\/([^/]+)(\/.*)?$/);
  if (!match || sitesMode() === 'same-origin') return NOT_FOUND();
  const [, kind, id, rest = '/'] = match;

  let resolved: Awaited<ReturnType<typeof resolveDeploymentByIdOrSlug>>;
  try {
    resolved = await resolveDeploymentByIdOrSlug(id);
  } catch {
    return NOT_FOUND();
  }
  if (!resolved) return NOT_FOUND();
  const { deployment } = resolved;
  const origin = kind === 'review' ? reviewOriginFor(deployment) : siteOriginFor(deployment);
  // Never back to the studio itself: a deployment with no host of its own has nowhere else to go.
  if (origin === new URL(request.url).origin || origin === new URL(appUrl()).origin) return NOT_FOUND();
  // A site on its own host (custom domain, or a slug with the proxy) is served at the root; on a
  // sites address it keeps its /deployments/{id}/ path. A review copy keeps its /review/{id}/ path.
  const atRoot = !!deployment.customDomain || (sitesMode() === 'proxy' && !!deployment.slug);
  const path = kind === 'review'
    ? `/review/${deployment.id}${rest}`
    : atRoot ? rest : `/deployments/${deployment.id}${rest}`;
  return NextResponse.redirect(`${origin}${path}${url.search}`, 307);
}

export const HEAD = GET;
