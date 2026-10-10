/**
 * Instance-level Caddy config regeneration.
 *
 * When STATIC_PROXY=true, regenerates the Caddyfile from the deployment
 * routing table and reloads Caddy. Called after publish/unpublish.
 *
 * Generates three types of server blocks:
 * 1. Main instance domain (inst-1.oswstudio.com)
 * 2. Subdomain routes (sunny-oak-river.inst-1.oswstudio.com) — wildcard cert
 * 3. Custom domain routes (sweetcandies.com) — on-demand TLS, plus a
 *    www counterpart block (www.sweetcandies.com, or the apex when the stored
 *    domain is a www name) that redirects to the stored name
 *
 * Does nothing if STATIC_PROXY is not set.
 */

import { getAllDomainRoutes, getAllSlugRoutes } from '@/lib/auth/system-database';
import path from 'path';
import { appUrl } from '@/lib/web/site-origin';

const CADDY_ADMIN_API = process.env.CADDY_ADMIN_API || 'http://localhost:2019';

export interface CaddyConfig {
  domain: string;
  publicRoot: string;
  slugRoutes: { deployment_id: string; slug: string }[];
  customDomainRoutes: { deployment_id: string; custom_domain: string }[];
}

/**
 * The www counterpart of a custom domain: `example.com` → `www.example.com`,
 * `www.example.com` → `example.com`. A non-www subdomain (`shop.example.com`)
 * gets `www.shop.example.com`; that is harmless since a cert is only issued
 * when a request for that exact name arrives and the resolver approves it.
 */
export function wwwCounterpart(domain: string): string {
  const d = domain.toLowerCase();
  return d.startsWith('www.') ? d.slice(4) : `www.${d}`;
}

export function generateCaddyfile(config: CaddyConfig): string {
  const { domain, publicRoot, slugRoutes, customDomainRoutes } = config;
  const lines: string[] = [];

  // Global options
  lines.push('{');
  lines.push('  admin localhost:2019 {');
  lines.push('    origins localhost:2019');
  lines.push('  }');
  if (customDomainRoutes.length > 0) {
    lines.push('  on_demand_tls {');
    lines.push('    ask http://localhost:3000/api/resolve-domain');
    lines.push('  }');
  }
  lines.push('}');
  lines.push('');

  // Main instance domain: the studio. Published sites are not served here; the app redirects
  // /deployments/{id}/ and /review/{id}/ to the site's own host (lib/web/site-origin.ts), so a
  // site's script never runs on the studio's origin.
  lines.push(`${domain} {`);
  lines.push('  reverse_proxy localhost:3000');
  lines.push('}');
  lines.push('');

  // Subdomain routes — specific blocks before the wildcard
  for (const route of slugRoutes) {
    lines.push(...siteBlock(`${route.slug}.${domain}`, route.deployment_id, publicRoot));
  }

  // Wildcard subdomain block: terminates TLS for any *.domain host without an
  // explicit block above and proxies it to Node, which answers a host that is
  // not the studio's only on site paths (`isSiteHost`). So an unmatched
  // subdomain gets a valid certificate and never the studio. Node serves sites
  // by path, so `/deployments/{id}/` still answers there, on that subdomain's
  // own origin, where review writes are refused (it is not the deployment's
  // origin). A deployment's subdomain serves its site once its block exists.
  if (slugRoutes.length > 0) {
    lines.push(`*.${domain} {`);
    lines.push('  tls {');
    lines.push('    dns cloudflare {env.CLOUDFLARE_API_TOKEN}');
    lines.push('  }');
    lines.push('  reverse_proxy localhost:3000');
    lines.push('}');
    lines.push('');
  }

  // Custom domain routes
  for (const route of customDomainRoutes) {
    lines.push(...siteBlock(route.custom_domain, route.deployment_id, publicRoot, ['  tls {', '    on_demand', '  }']));

    // www counterpart → permanent redirect to the stored (canonical) name
    lines.push(`${wwwCounterpart(route.custom_domain)} {`);
    lines.push('  tls {');
    lines.push('    on_demand');
    lines.push('  }');
    lines.push(`  redir https://${route.custom_domain}{uri} permanent`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The directory Caddy serves published sites from.
 *
 * Next's standalone server chdirs into `.next/standalone`, so `process.cwd() + '/public'` points
 * inside the build directory. A deploy that rebuilds by removing `.next` therefore took every
 * published site offline for the length of the build, even though their files were untouched:
 * `STATIC_PROXY=true` means Caddy reads them straight off disk, so the app being up or down makes
 * no difference to them.
 *
 * The deploy leaves `.next/standalone/public` as a symlink to the project's own `public`, so
 * resolving it gives a path that outlives any one build. Where it is a real directory, which is
 * what a plain `npm start` install has, `realpath` returns the same path and nothing changes.
 */
async function resolvedPublicRoot(): Promise<string> {
  const literal = path.join(process.cwd(), 'public');
  try {
    const { promises: fs } = await import('fs');
    return await fs.realpath(literal);
  } catch {
    // Nothing at that path yet: fall back rather than lose the whole config over it.
    return literal;
  }
}

export async function regenerateInstanceCaddy(): Promise<void> {
  if (process.env.STATIC_PROXY !== 'true') return;

  try {
    const domain = appUrl().replace(/^https?:\/\//, '');
    const publicRoot = await resolvedPublicRoot();

    const config = generateCaddyfile({
      domain,
      publicRoot,
      slugRoutes: getAllSlugRoutes(),
      customDomainRoutes: getAllDomainRoutes(),
    });

    // Persist to disk so a cold Caddy restart (which loads from the file, not the
    // admin API) picks up the current config. Best-effort — the admin reload below
    // is the primary path — but don't swallow the error: a silent failure leaves a
    // stale file that a restart would load, dropping every route not in it.
    const caddyfilePath = process.env.CADDYFILE_PATH || '/etc/caddy/Caddyfile';
    try {
      const { promises: fs } = await import('fs');
      await fs.writeFile(caddyfilePath, config, 'utf-8');
    } catch (err) {
      console.error(
        `[Caddy] Failed to persist config to ${caddyfilePath} — a Caddy restart will load a stale config until the next successful write:`,
        err instanceof Error ? err.message : err
      );
    }

    // Reload via admin API for immediate effect
    const res = await fetch(`${CADDY_ADMIN_API}/load`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/caddyfile',
        'Origin': `http://localhost:${new URL(CADDY_ADMIN_API).port || '2019'}`,
      },
      body: config,
    });

    if (!res.ok) {
      console.error(`[Caddy] Reload failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('[Caddy] Config regeneration failed:', err);
  }
}

/**
 * One published site on its own host. Its edge functions, the analytics collector and its review
 * copy are passed to the app, which answers only those paths on a site host; everything else is
 * the site's files, served at the host's root.
 */
function siteBlock(host: string, deploymentId: string, publicRoot: string, preamble: string[] = []): string[] {
  return [
    `${host} {`,
    ...preamble,
    `  @platform path /api/deployments/${deploymentId}/functions/* /api/analytics/track /api/analytics/interaction /review/${deploymentId} /review/${deploymentId}/*`,
    '  handle @platform {',
    '    reverse_proxy localhost:3000',
    '  }',
    '  handle {',
    `    root * ${publicRoot}`,
    `    rewrite * /deployments/${deploymentId}{uri}`,
    '    try_files {path} {path}.html {path}/index.html',
    '    file_server',
    '    header Cache-Control "public, max-age=3600"',
    // Public files, readable without credentials, so the studio's capture can inline them.
    '    header Access-Control-Allow-Origin "*"',
    '  }',
    '}',
    '',
  ];
}
