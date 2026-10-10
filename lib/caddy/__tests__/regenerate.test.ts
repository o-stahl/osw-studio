import { describe, it, expect } from 'vitest';
import { generateCaddyfile, wwwCounterpart, CaddyConfig } from '../regenerate';

const BASE_CONFIG: CaddyConfig = {
  domain: 'inst-1.oswstudio.com',
  publicRoot: '/opt/osw-studio/.next/standalone/public',
  slugRoutes: [],
  customDomainRoutes: [],
};

describe('generateCaddyfile', () => {
  it('generates base config with main domain only', () => {
    const result = generateCaddyfile(BASE_CONFIG);

    expect(result).toContain('inst-1.oswstudio.com {');
    // The studio's block only proxies: published sites are never served on its origin.
    expect(result).not.toContain('/deployments/');
    expect(result).not.toContain('file_server');
    expect(result).toContain('reverse_proxy localhost:3000');
    expect(result).toContain('admin localhost:2019');
    // No wildcard block without slugs
    expect(result).not.toContain('*.inst-1.oswstudio.com');
    // No on_demand_tls without custom domains
    expect(result).not.toContain('on_demand_tls');
  });

  it('generates subdomain blocks for slug routes', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      slugRoutes: [
        { deployment_id: 'abc123', slug: 'sunny-oak-river' },
        { deployment_id: 'def456', slug: 'calm-pine-stone' },
      ],
    });

    // Specific subdomain blocks
    expect(result).toContain('sunny-oak-river.inst-1.oswstudio.com {');
    expect(result).toContain('rewrite * /deployments/abc123{uri}');
    expect(result).toContain('calm-pine-stone.inst-1.oswstudio.com {');
    expect(result).toContain('rewrite * /deployments/def456{uri}');

    // Wildcard fallback with DNS challenge
    expect(result).toContain('*.inst-1.oswstudio.com {');
    expect(result).toContain('dns cloudflare {env.CLOUDFLARE_API_TOKEN}');

    // Subdomain blocks should come BEFORE the wildcard
    const sunnyPos = result.indexOf('sunny-oak-river.inst-1.oswstudio.com');
    const wildcardPos = result.indexOf('*.inst-1.oswstudio.com');
    expect(sunnyPos).toBeLessThan(wildcardPos);
  });

  it('generates custom domain blocks with on-demand TLS', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      customDomainRoutes: [
        { deployment_id: 'xyz789', custom_domain: 'sweetcandies.com' },
      ],
    });

    expect(result).toContain('sweetcandies.com {');
    expect(result).toContain('tls {');
    expect(result).toContain('on_demand');
    expect(result).toContain('rewrite * /deployments/xyz789{uri}');

    // Global on_demand_tls ask endpoint
    expect(result).toContain('on_demand_tls {');
    expect(result).toContain('ask http://localhost:3000/api/resolve-domain');
  });

  it('generates complete config with slugs and custom domains', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      slugRoutes: [
        { deployment_id: 'abc123', slug: 'sunny-oak-river' },
      ],
      customDomainRoutes: [
        { deployment_id: 'xyz789', custom_domain: 'sweetcandies.com' },
      ],
    });

    // All three block types present
    expect(result).toContain('inst-1.oswstudio.com {');
    expect(result).toContain('sunny-oak-river.inst-1.oswstudio.com {');
    expect(result).toContain('*.inst-1.oswstudio.com {');
    expect(result).toContain('sweetcandies.com {');

    // Correct ordering: main → slugs → wildcard → custom domains
    const mainPos = result.indexOf('inst-1.oswstudio.com {');
    const slugPos = result.indexOf('sunny-oak-river.inst-1.oswstudio.com {');
    const wildcardPos = result.indexOf('*.inst-1.oswstudio.com {');
    const customPos = result.indexOf('sweetcandies.com {');
    expect(mainPos).toBeLessThan(slugPos);
    expect(slugPos).toBeLessThan(wildcardPos);
    expect(wildcardPos).toBeLessThan(customPos);
  });

  it('uses correct public root path in all blocks', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      publicRoot: '/custom/path/public',
      slugRoutes: [{ deployment_id: 'abc', slug: 'test' }],
    });

    const rootMatches = result.match(/root \* \/custom\/path\/public/g) || [];
    // The subdomain block only; the studio's block serves no files
    expect(rootMatches.length).toBe(1);
  });

  it('includes try_files for clean URLs in all serving blocks', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      slugRoutes: [{ deployment_id: 'abc', slug: 'test' }],
      customDomainRoutes: [{ deployment_id: 'xyz', custom_domain: 'example.com' }],
    });

    const tryFilesMatches = result.match(/try_files \{path\} \{path\}\.html \{path\}\/index\.html/g) || [];
    // Subdomain + custom domain = 2 (the studio and the www redirect blocks serve nothing)
    expect(tryFilesMatches.length).toBe(2);
  });

  it('adds a www redirect block for an apex custom domain', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      customDomainRoutes: [{ deployment_id: 'xyz', custom_domain: 'sweetcandies.com' }],
    });

    expect(result).toContain('www.sweetcandies.com {');
    expect(result).toContain('redir https://sweetcandies.com{uri} permanent');
    // Redirect block has on-demand TLS but does not serve files
    const wwwBlock = result.slice(result.indexOf('www.sweetcandies.com {'));
    expect(wwwBlock).toContain('on_demand');
    expect(wwwBlock).not.toContain('file_server');
    // Stored domain still serves the deployment
    expect(result).toContain('rewrite * /deployments/xyz{uri}');
  });

  it('adds an apex redirect block for a www custom domain', () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      customDomainRoutes: [{ deployment_id: 'xyz', custom_domain: 'www.sweetcandies.com' }],
    });

    expect(result).toContain('\nsweetcandies.com {');
    expect(result).toContain('redir https://www.sweetcandies.com{uri} permanent');
  });

});

describe('wwwCounterpart', () => {
  it('maps apex to www and back', () => {
    expect(wwwCounterpart('example.com')).toBe('www.example.com');
    expect(wwwCounterpart('www.example.com')).toBe('example.com');
    expect(wwwCounterpart('WWW.Example.com')).toBe('example.com');
  });

  it('handles multi-label TLDs and subdomains by prefix only', () => {
    expect(wwwCounterpart('example.co.uk')).toBe('www.example.co.uk');
    expect(wwwCounterpart('shop.example.com')).toBe('www.shop.example.com');
  });

  it("passes a site's own functions, analytics and review copy to the app, and nothing else", () => {
    const result = generateCaddyfile({
      ...BASE_CONFIG,
      slugRoutes: [{ deployment_id: 'abc', slug: 'sunny' }],
      customDomainRoutes: [{ deployment_id: 'xyz', custom_domain: 'example.com' }],
    });
    for (const [host, id] of [['sunny.inst-1.oswstudio.com', 'abc'], ['example.com', 'xyz']]) {
      const block = result.split(`\n${host} {`)[1].split('\n}\n')[0];
      // Each path on its own, in any order, and no path besides them.
      const matcher = block.match(/^\s*@platform path (.+)$/m);
      expect(matcher, host).not.toBeNull();
      expect(matcher![1].trim().split(/\s+/).sort(), host).toEqual([
        `/api/deployments/${id}/functions/*`,
        '/api/analytics/track',
        '/api/analytics/interaction',
        `/review/${id}`,
        `/review/${id}/*`,
      ].sort());
      // The platform paths are matched before the static handler rewrites everything into the site.
      expect(block.indexOf('handle @platform'), host).toBeLessThan(block.indexOf(`rewrite * /deployments/${id}{uri}`));
    }
  });
});
