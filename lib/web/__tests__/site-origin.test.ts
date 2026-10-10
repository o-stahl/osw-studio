import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  sitesOrigin,
  sitesMode,
  siteOriginFor,
  reviewOriginFor,
  isStudioHost,
  isRelocatedSitePath,
} from '../site-origin';

/**
 * Where a published site lives relative to the studio. Each answer here decides whether a site's
 * script shares the studio's origin (and so its session and stored keys), so a wrong one is a
 * security regression rather than a cosmetic one.
 */
afterEach(() => vi.unstubAllEnvs());

function env(vars: Record<string, string>) {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.stubEnv('SITES_ORIGIN', '');
  vi.stubEnv('STATIC_PROXY', '');
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
}

describe('sitesOrigin', () => {
  it.each([
    ['a different origin', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com', SITES_ORIGIN: 'https://sites.example.com/x' }, 'https://sites.example.com'],
    ['the studio origin itself', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com', SITES_ORIGIN: 'https://studio.example.com/' }, null],
    ['the default studio origin', { SITES_ORIGIN: 'http://localhost:3000' }, null],
    ['an unparseable value', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com', SITES_ORIGIN: 'not a url' }, null],
    ['unset', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com' }, null],
  ])('%s', (_label, vars, expected) => {
    env(vars);
    expect(sitesOrigin()).toBe(expected);
  });
});

describe('sitesMode', () => {
  it.each([
    ['proxy wins over a sites address', { STATIC_PROXY: 'true', SITES_ORIGIN: 'https://sites.example.com' }, 'proxy'],
    ['a sites address alone', { SITES_ORIGIN: 'https://sites.example.com' }, 'host'],
    ['a sites address equal to the studio', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com', SITES_ORIGIN: 'https://studio.example.com' }, 'same-origin'],
    ['nothing configured', {}, 'same-origin'],
  ])('%s', (_label, vars, expected) => {
    env({ NEXT_PUBLIC_APP_URL: 'https://studio.example.com', ...vars });
    expect(sitesMode()).toBe(expected);
  });
});

describe('siteOriginFor and reviewOriginFor', () => {
  it.each([
    ['proxy: slug subdomain keeps the app port', { STATIC_PROXY: 'true', NEXT_PUBLIC_APP_URL: 'https://studio.example.com:8443/app' }, { slug: 'shop' }, 'https://shop.studio.example.com:8443', 'https://shop.studio.example.com:8443'],
    ['proxy: custom domain first', { STATIC_PROXY: 'true', NEXT_PUBLIC_APP_URL: 'https://studio.example.com' }, { slug: 'shop', customDomain: 'shop.test' }, 'https://shop.test', 'https://shop.test'],
    ['proxy: no slug falls back to the studio', { STATIC_PROXY: 'true', NEXT_PUBLIC_APP_URL: 'https://studio.example.com/' }, {}, 'https://studio.example.com', 'https://studio.example.com'],
    ['host: the sites address, review ignores the custom domain', { SITES_ORIGIN: 'http://localhost:30012', NEXT_PUBLIC_APP_URL: 'http://localhost:30011' }, { slug: 'shop', customDomain: 'shop.test' }, 'https://shop.test', 'http://localhost:30012'],
    ['host: no custom domain', { SITES_ORIGIN: 'http://localhost:30012', NEXT_PUBLIC_APP_URL: 'http://localhost:30011' }, { slug: 'shop' }, 'http://localhost:30012', 'http://localhost:30012'],
    ['same-origin: the studio', { NEXT_PUBLIC_APP_URL: 'https://studio.example.com/base' }, { slug: 'shop', customDomain: 'shop.test' }, 'https://shop.test', 'https://studio.example.com'],
  ])('%s', (_label, vars, deployment, site, review) => {
    env(vars);
    expect(siteOriginFor(deployment)).toBe(site);
    expect(reviewOriginFor(deployment)).toBe(review);
  });
});

describe('isStudioHost', () => {
  it.each([
    ['studio.example.com', true],
    ['studio.example.com:8443', true],
    ['localhost:3000', true],
    ['127.0.0.1', true],
    ['[::1]:3000', true],
    ['[::1]', true],
    ['shop.studio.example.com', false],
    ['studio.example.com.evil.test', false],
  ])('%s → %s', (host, expected) => {
    env({ NEXT_PUBLIC_APP_URL: 'https://studio.example.com' });
    expect(isStudioHost(host)).toBe(expected);
  });
});

describe('isRelocatedSitePath', () => {
  it.each([
    ['/deployments/abc/', true],
    ['/deployments/abc/about.html', true],
    ['/review/abc', true],
    ['/review/abc/', true],
    ['/review/abc/page.html', true],
    ['/review/abc/osw-api', false],
    ['/review/abc/osw-api/comments', false],
    ['/review/', false],
    ['/reviews/abc', false],
    ['/api/deployments/abc', false],
  ])('%s → %s', (path, expected) => {
    expect(isRelocatedSitePath(path)).toBe(expected);
  });
});
