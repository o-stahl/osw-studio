import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { isReviewOriginAllowed, reviewAllowedOrigins } from '../origin-gate';

/**
 * Review writes do not get the analytics allowlist.
 *
 * `getAllowedOrigins` is built for a collector that every published deployment posts to, so it
 * names every slug subdomain and every custom domain. Those are attacker-authorable HTML on hosts
 * that are same-*site* with the app, which is exactly the condition under which SameSite=Lax still
 * sends the review cookie — so on a write endpoint that allowlist authorises the tenant next door
 * to forge a client's comment.
 */

const APP_URL = 'https://oswstudio.com';

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://oswstudio.com/review/dep-1/osw-api/comments', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('reviewAllowedOrigins', () => {
  it('is exactly the app origin', () => {
    expect(reviewAllowedOrigins()).toEqual([APP_URL]);
  });

  it('names no wildcard, whatever the app URL is spelled like', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://oswstudio.com/');

    const origins = reviewAllowedOrigins();
    expect(origins.some(entry => entry.includes('*'))).toBe(false);
    // Normalised, so a trailing slash in the environment does not become an origin nothing matches.
    expect(origins).toEqual([APP_URL]);
  });
});

describe('isReviewOriginAllowed', () => {
  it('accepts the app origin', () => {
    expect(isReviewOriginAllowed(requestWith({ origin: APP_URL }))).toBe(true);
  });

  it('rejects a tenant deployment on a slug subdomain', () => {
    // Same-site with the app, so the review cookie is sent; the origin check is what has to stop it.
    expect(isReviewOriginAllowed(requestWith({ origin: 'https://tenant.oswstudio.com' }))).toBe(
      false
    );
  });

  it('rejects a tenant deployment on its custom domain', () => {
    expect(isReviewOriginAllowed(requestWith({ origin: 'https://sweetcandies.com' }))).toBe(false);
  });

  it('rejects an unrelated site', () => {
    expect(isReviewOriginAllowed(requestWith({ origin: 'https://evil.example' }))).toBe(false);
    expect(isReviewOriginAllowed(requestWith({ origin: 'https://oswstudio.com.evil.net' }))).toBe(
      false
    );
  });

  it('rejects a request with no origin at all', () => {
    expect(isReviewOriginAllowed(requestWith({}))).toBe(false);
  });

  it('accepts a page inside the review copy by referer when no origin is sent', () => {
    expect(
      isReviewOriginAllowed(requestWith({ referer: `${APP_URL}/review/dep-1/index.html` }))
    ).toBe(true);
  });
});

/**
 * With sites served away from the studio, the review copy posts from the site's own origin to the
 * site's host. The studio's host acts as the team on the account session, which a same-site POST
 * from any site would carry, so there only the studio's own origin is accepted.
 */
describe('a review copy on its own site host', () => {
  const SITE = 'https://pale-plum.oswstudio.com';
  const deployment = { slug: 'pale-plum' };
  const post = (url: string, origin: string) =>
    new Request(url, { method: 'POST', headers: { origin } });

  beforeEach(() => vi.stubEnv('STATIC_PROXY', 'true'));

  it("accepts the site's origin on the site's host", () => {
    expect(isReviewOriginAllowed(post(`${SITE}/review/dep-1/osw-api/comments`, SITE), deployment)).toBe(true);
  });

  it("refuses the site's origin on the studio's host, where the account session acts as the team", () => {
    expect(isReviewOriginAllowed(post(`${APP_URL}/review/dep-1/osw-api/comments`, SITE), deployment)).toBe(false);
    expect(isReviewOriginAllowed(post(`${APP_URL}/review/dep-1/osw-api/comments`, APP_URL), deployment)).toBe(true);
  });

  it('takes a custom-domain review copy on the sites address without the proxy, where it is served', () => {
    vi.stubEnv('STATIC_PROXY', '');
    vi.stubEnv('SITES_ORIGIN', 'https://sites.example.com');
    const shared = 'https://sites.example.com';
    const withDomain = { customDomain: 'shop.example.org' };
    expect(isReviewOriginAllowed(post(`${shared}/review/dep-1/osw-api/comments`, shared), withDomain)).toBe(true);
  });

  it('refuses the shared sites address on the studio host', () => {
    vi.stubEnv('STATIC_PROXY', '');
    vi.stubEnv('SITES_ORIGIN', 'https://sites.example.com');
    const shared = 'https://sites.example.com';
    expect(isReviewOriginAllowed(post(`${APP_URL}/review/dep-1/osw-api/comments`, shared), {})).toBe(false);
    expect(isReviewOriginAllowed(post(`${shared}/review/dep-1/osw-api/comments`, shared), {})).toBe(true);
  });
});

/** Desktop: the sites port is loopback like the studio's, and only its port tells them apart. */
describe('a review copy on a loopback sites port', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:30011');
    vi.stubEnv('SITES_ORIGIN', 'http://localhost:30012');
  });
  const post = (url: string, origin: string) =>
    new Request(url, { method: 'POST', headers: { origin, host: new URL(url).host } });

  it("accepts the sites port's origin there, and not on the studio port", () => {
    expect(isReviewOriginAllowed(post('http://localhost:30012/review/d/osw-api/comments', 'http://localhost:30012'), {})).toBe(true);
    expect(isReviewOriginAllowed(post('http://localhost:30011/review/d/osw-api/comments', 'http://localhost:30012'), {})).toBe(false);
  });
});
