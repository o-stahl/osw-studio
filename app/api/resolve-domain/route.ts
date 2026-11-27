/**
 * Domain Resolution API
 *
 * Called by Caddy (or other reverse proxy) to map a hostname
 * to a deployment path. Returns the internal rewrite target.
 *
 * Single lookup:
 *   GET /api/resolve-domain?host=sweetcandies.com
 *   → { deploymentId, path: "/deployments/{id}" }
 *
 * Bulk list (for Caddy config generation):
 *   GET /api/resolve-domain?list=true
 *   → { domains: [{ domain, deploymentId, path }] }
 *
 * Also used by Caddy's on_demand_tls "ask" endpoint to verify
 * whether a domain should get a certificate provisioned.
 * Caddy sends ?domain= (not ?host=), so we accept both.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeploymentByDomain, getDeploymentBySlug, getAllDomainRoutes } from '@/lib/auth/system-database';
import { wwwCounterpart } from '@/lib/caddy/regenerate';
import { configuredAppUrl } from '@/lib/web/site-origin';

export async function GET(request: NextRequest) {
  // Bulk list mode — for Caddy config generation
  if (request.nextUrl.searchParams.get('list') === 'true') {
    const routes = getAllDomainRoutes();
    return NextResponse.json({
      domains: routes.map(r => ({
        domain: r.custom_domain,
        deploymentId: r.deployment_id,
        path: `/deployments/${r.deployment_id}`,
      })),
    });
  }

  // Single lookup — accept both ?host= (direct) and ?domain= (Caddy on_demand_tls ask)
  const host = request.nextUrl.searchParams.get('host')
    || request.nextUrl.searchParams.get('domain');
  if (!host) {
    return NextResponse.json({ error: 'Missing host or domain parameter' }, { status: 400 });
  }

  // Strip port if present
  const domain = host.split(':')[0].toLowerCase();

  // Try custom domain first, then its www counterpart (www.example.com is
  // served as a redirect to example.com and vice versa, so Caddy's on-demand
  // TLS ask must approve a cert for it too)
  let match = getDeploymentByDomain(domain);
  if (!match) match = getDeploymentByDomain(wwwCounterpart(domain));

  // Try subdomain slug (e.g., my-site.oswstudio.com → slug "my-site")
  if (!match) {
    const appHost = (configuredAppUrl() || '').replace(/^https?:\/\//, '').split(':')[0];
    if (appHost && domain.endsWith(`.${appHost}`)) {
      const slug = domain.slice(0, -(appHost.length + 1));
      if (slug && !slug.includes('.')) {
        match = getDeploymentBySlug(slug);
      }
    }
  }

  if (!match) {
    return NextResponse.json({ error: 'Domain not found' }, { status: 404 });
  }

  return NextResponse.json({
    deploymentId: match.deployment_id,
    path: `/deployments/${match.deployment_id}`,
  });
}
