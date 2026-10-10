import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deploymentPublicUrl, withPublicUrl } from '@/lib/api/deployment-url';

/**
 * Why this exists.
 *
 * `resolveDeploymentServing` was already covered exhaustively by static-builder-serving.test.ts,
 * including the case where a slug exists but the proxy is off. It still shipped a broken URL,
 * because the deployment card and the publish settings tab never called it: both built
 * `https://${slug}.${hostname}` by hand, and publish assigns a slug unconditionally. On a local
 * install that is `https://some-slug.localhost`, which resolves to nothing.
 *
 * So these do not re-test the resolver. They pin the thing that was actually missing: the value the
 * API hands the UI, for the environments the UI runs in.
 */

const ORIGINAL = {
  proxy: process.env.STATIC_PROXY,
  url: process.env.NEXT_PUBLIC_APP_URL,
  sites: process.env.SITES_ORIGIN,
};

function setOrDelete(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function env(proxy: string | undefined, appUrl: string | undefined, sitesOrigin?: string) {
  setOrDelete('STATIC_PROXY', proxy);
  setOrDelete('NEXT_PUBLIC_APP_URL', appUrl);
  setOrDelete('SITES_ORIGIN', sitesOrigin);
}

beforeEach(() => env(undefined, undefined));
afterEach(() => env(ORIGINAL.proxy, ORIGINAL.url, ORIGINAL.sites));

const deployment = { id: 'dep-1', slug: 'wide-reef-bend' };

describe('the URL the API gives the UI', () => {
  it('is the id path on a local install, even though publish assigned a slug', () => {
    // The reported bug: a published local deployment offered https://wide-reef-bend.localhost.
    expect(deploymentPublicUrl(deployment)).toBe('http://localhost:3000/deployments/dep-1');
  });

  it('keeps the port, which a subdomain URL silently dropped', () => {
    env(undefined, 'http://localhost:4000');
    expect(deploymentPublicUrl(deployment)).toBe('http://localhost:4000/deployments/dep-1');
  });

  it('stays on http when the instance is served over http', () => {
    // The hand-rolled version hardcoded https, so a plain-http install got an unreachable URL.
    env(undefined, 'http://box.local:8080');
    expect(deploymentPublicUrl(deployment)).toMatch(/^http:\/\//);
  });

  it('is the slug subdomain only once the static proxy is actually routing them', () => {
    env('true', 'https://oswstudio.com');
    expect(deploymentPublicUrl(deployment)).toBe('https://wide-reef-bend.oswstudio.com');
  });

  it('is the id path when the proxy is on but publish assigned no slug', () => {
    env('true', 'https://oswstudio.com');
    expect(deploymentPublicUrl({ id: 'dep-2' })).toBe('https://oswstudio.com/deployments/dep-2');
  });

  it('prefers a custom domain wherever it is running', () => {
    expect(deploymentPublicUrl({ ...deployment, customDomain: 'shop.example' }))
      .toBe('https://shop.example');
  });
});

describe('the URL the API gives the UI with a sites address', () => {
  it('is the id path on the sites address, not on the studio', () => {
    env(undefined, 'http://localhost:30011', 'http://localhost:30012');
    expect(deploymentPublicUrl(deployment)).toBe('http://localhost:30012/deployments/dep-1');
  });

  it('is the slug subdomain when the static proxy is on as well', () => {
    env('true', 'https://oswstudio.com', 'https://sites.oswstudio.com');
    expect(deploymentPublicUrl(deployment)).toBe('https://wide-reef-bend.oswstudio.com');
  });

  it('is the custom domain over either', () => {
    env(undefined, 'http://localhost:30011', 'http://localhost:30012');
    expect(deploymentPublicUrl({ ...deployment, customDomain: 'shop.example' })).toBe('https://shop.example');
  });

  it('stays on the studio when the sites address is the studio itself', () => {
    env(undefined, 'http://localhost:3000', 'http://localhost:3000/');
    expect(deploymentPublicUrl(deployment)).toBe('http://localhost:3000/deployments/dep-1');
  });
});

describe('withPublicUrl', () => {
  it('adds the field without disturbing the deployment', () => {
    const out = withPublicUrl({ ...deployment, name: 'Shop', enabled: true });
    expect(out.name).toBe('Shop');
    expect(out.enabled).toBe(true);
    expect(out.publicUrl).toBe('http://localhost:3000/deployments/dep-1');
  });
});
