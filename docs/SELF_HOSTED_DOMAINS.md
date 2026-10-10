# Self-Hosted Domain Routing

Guide for OSW Studio operators running their own instances.

## Deployment Serving

Published deployments are served by Node.js route handlers by default, under `/deployments/{id}/`. For better performance and for isolation, set `STATIC_PROXY=true` in `.env` and use Caddy with the generated Caddyfile ([requirements](SERVER_MODE.md#setting-up-subdomains)): each deployment is served from its own subdomain (`{slug}.{your instance domain}`) or custom domain, straight from disk. Only the deployment's own edge functions, `/api/analytics/track`, `/api/analytics/interaction` and its review copy (`/review/{id}/`) are passed to Node.js from those hosts.

The studio's own domain does not serve deployments in this set-up: `/deployments/{id}/` and `/review/{id}/` there redirect to the deployment's subdomain or custom domain, so a site's scripts never run on the studio's origin. Without `STATIC_PROXY`, set `SITES_ORIGIN` to serve every deployment from a separate address instead; see [Where Published Sites Are Served](SERVER_MODE.md#where-published-sites-are-served).

When `STATIC_PROXY=true`, publishing or deleting a deployment with a custom domain automatically regenerates the proxy config and reloads it.

## Custom Domains

Users can set a custom domain in Deployment Settings and publish. The instance exposes a domain resolution API for proxy integration:

```
GET /api/resolve-domain?host=sweetcandies.com     → { deploymentId, path }
GET /api/resolve-domain?domain=sweetcandies.com   → 200 or 404 (for on-demand TLS verification)
GET /api/resolve-domain?list=true                  → { domains: [...] } (all registered domains)
```

### User Setup

1. Enter their domain in Deployment Settings
2. Publish the deployment
3. Add a DNS A record pointing to your server's IP
4. Wait for DNS propagation and SSL provisioning

### Notes

- Deployments published with a custom domain use root-relative asset paths. With `STATIC_PROXY` or `SITES_ORIGIN`, `/deployments/{id}/` on the studio's address redirects to the domain; without either, open the site on its domain, since the assets do not load under the path. Without `STATIC_PROXY`, the deployment's review copy stays on the sites address (or the studio's), since only the generated Caddyfile serves `/review/` on a custom domain.
- The domain is registered in the routing table on publish. If a domain is removed and republished, the routing entry is cleared.
