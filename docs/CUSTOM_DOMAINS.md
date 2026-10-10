# Custom Domains

## Setup (2 steps)

1. In OSW Studio, go to Deployment Settings and enter your domain (e.g., `sweetcandies.com`)
2. In your DNS provider, add an A record pointing to your OSW Studio server's IP address

That's it. The server handles SSL certificates automatically via Let's Encrypt.

### www and non-www

Enter the name you want as the canonical address, either `sweetcandies.com` or `www.sweetcandies.com`. The other form redirects to it, with its own certificate, as long as its DNS also points at the server:

- `sweetcandies.com` (root) cannot hold a CNAME at most registrars. Use an A record to the server IP, or ALIAS/CNAME flattening if your DNS provider offers it.
- `www.sweetcandies.com` can be a CNAME to your deployment's subdomain address, or an A record to the server IP.

## How It Works

When you publish a deployment with a custom domain:

1. OSW Studio registers the domain in its routing table
2. The reverse proxy (Caddy) intercepts requests to your domain
3. Caddy provisions an SSL certificate automatically (on-demand TLS)
4. Requests are routed to your deployment's static files
5. The deployment's own edge functions, the analytics collector and its review copy are passed to OSW Studio; other `/api/` paths are not served on your domain

When the install serves sites away from the studio (`STATIC_PROXY`, as on hosted instances, or `SITES_ORIGIN`), a link to `/deployments/{id}/` on the studio's address redirects to your domain. See [Where Published Sites Are Served](?doc=server-mode).

## What OSW Studio Handles

- Domain registration in the routing table
- Root-relative asset paths when a custom domain is set
- SEO meta tags, sitemaps, and canonical URLs using your domain
- Analytics origin validation for your domain

## What OSW Studio Does Not Handle

- DNS configuration (you add the A record)
- SSL certificates (Caddy handles this automatically)
- Domain purchase or registration

## For Self-Hosted Instances

Your OSW Studio instance needs a reverse proxy with TLS support. See `docs/SELF_HOSTED_DOMAINS.md` for API endpoints and proxy requirements.

## For Hosted Instances (oswstudio.com)

Custom domains are handled automatically by the platform. Just add your DNS A record.

## Troubleshooting

**Site not loading after adding DNS**
- DNS propagation can take up to 48 hours (usually minutes)
- Verify your A record: `dig sweetcandies.com` should show the server IP
- The first request may take a few seconds while the SSL certificate is provisioned

**SSL certificate not working**
- Ensure your DNS A record points directly to the server IP (not through a proxy)
- If only the www (or only the non-www) form fails, check that that name also resolves to the server; each form needs its own DNS record
- Caddy needs port 80 and 443 open for Let's Encrypt HTTP-01 challenges

**Assets loading from wrong path**
- Republish your deployment after setting the custom domain
- The asset path rewriting only takes effect on publish
