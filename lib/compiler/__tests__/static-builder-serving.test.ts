import { describe, it, expect } from 'vitest';
import {
  resolveDeploymentServing,
  replaceAssetPathsWithDeploymentPrefix,
} from '../deployment-paths';

const APP = 'https://inst-1.oswstudio.com';
const ID = 'abc123';

describe('resolveDeploymentServing (issue #14)', () => {
  it('serves at root for a custom domain regardless of proxy/slug', () => {
    const r = resolveDeploymentServing(
      { customDomain: 'sweets.com', slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: false, appUrl: APP }
    );
    expect(r.servedAtRoot).toBe(true);
    expect(r.baseUrl).toBe('https://sweets.com');
  });

  it('serves at the subdomain root when the static proxy is on and a slug exists', () => {
    const r = resolveDeploymentServing(
      { slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: true, appUrl: APP }
    );
    expect(r.servedAtRoot).toBe(true);
    expect(r.baseUrl).toBe('https://fine-bird-flame.inst-1.oswstudio.com');
  });

  it('serves under /deployments/{id}/ when a slug exists but the proxy is OFF (the #14 regression case)', () => {
    const r = resolveDeploymentServing(
      { slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: false, appUrl: APP }
    );
    expect(r.servedAtRoot).toBe(false);
    expect(r.baseUrl).toBe(`${APP}/deployments/${ID}`);
  });

  it('serves under /deployments/{id}/ when the proxy is on but there is no slug', () => {
    const r = resolveDeploymentServing(
      {},
      ID,
      { staticProxyEnabled: true, appUrl: APP }
    );
    expect(r.servedAtRoot).toBe(false);
    expect(r.baseUrl).toBe(`${APP}/deployments/${ID}`);
  });

  it('serves under /deployments/{id}/ with neither proxy nor slug', () => {
    const r = resolveDeploymentServing({}, ID, { staticProxyEnabled: false, appUrl: APP });
    expect(r.servedAtRoot).toBe(false);
    expect(r.baseUrl).toBe(`${APP}/deployments/${ID}`);
  });
});

describe('resolveDeploymentServing with a sites address', () => {
  const SITES = 'https://sites.oswstudio.com';

  it('serves under /deployments/{id}/ on the sites address rather than the app', () => {
    const r = resolveDeploymentServing(
      { slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: false, appUrl: APP, sitesOrigin: SITES }
    );
    expect(r.servedAtRoot).toBe(false);
    expect(r.baseUrl).toBe(`${SITES}/deployments/${ID}`);
  });

  it('leaves a slug with the static proxy on its subdomain', () => {
    const r = resolveDeploymentServing(
      { slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: true, appUrl: APP, sitesOrigin: SITES }
    );
    expect(r.servedAtRoot).toBe(true);
    expect(r.baseUrl).toBe('https://fine-bird-flame.inst-1.oswstudio.com');
  });

  it('leaves a custom domain at its root', () => {
    const r = resolveDeploymentServing(
      { customDomain: 'sweets.com', slug: 'fine-bird-flame' },
      ID,
      { staticProxyEnabled: false, appUrl: APP, sitesOrigin: SITES }
    );
    expect(r.servedAtRoot).toBe(true);
    expect(r.baseUrl).toBe('https://sweets.com');
  });
});

describe('servedAtRoot flips asset path style (issue #14)', () => {
  const html = '<link href="/styles/style.css"><script src="/scripts/main.js"></script>';

  it('prefixes asset paths with /deployments/{id} when NOT served at root', () => {
    const out = replaceAssetPathsWithDeploymentPrefix(html, new Map(), ID, false);
    expect(out).toContain(`href="/deployments/${ID}/styles/style.css"`);
    expect(out).toContain(`src="/deployments/${ID}/scripts/main.js"`);
  });

  it('keeps asset paths root-relative when served at root', () => {
    const out = replaceAssetPathsWithDeploymentPrefix(html, new Map(), ID, true);
    expect(out).toContain('href="/styles/style.css"');
    expect(out).toContain('src="/scripts/main.js"');
    expect(out).not.toContain('/deployments/');
  });
});
