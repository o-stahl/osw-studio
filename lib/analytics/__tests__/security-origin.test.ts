import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getAllowedOrigins, validateOrigin } from '../security';

/**
 * Origin validation is the only thing standing between the analytics collectors and anyone who can
 * point a browser at them, and — since review mode reuses it — between a review copy's write
 * endpoints and a page the visitor did not open.
 *
 * The cases below are grouped by what the header actually is. A browser only ever puts an origin in
 * `Origin`: scheme, host and port, never a path. `Referer` carries a full URL, so the allowlist's
 * path entries can only ever match through it. Conflating the two is what let
 * `https://oswstudio.com.evil.net` pass a check written for `https://oswstudio.com`.
 */

const APP_URL = 'https://oswstudio.com';
const DEPLOYMENT = 'dep-123';

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://oswstudio.com/api/analytics/track', {
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

describe('validateOrigin — Origin header', () => {
  it('rejects a domain that merely starts with an allowed one', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    // Both are registrable by anyone. A prefix match reads them as the app's own origin.
    expect(validateOrigin(requestWith({ origin: 'https://oswstudio.com.evil.net' }), allowed)).toBe(
      false
    );
    expect(validateOrigin(requestWith({ origin: 'https://oswstudio.com-evil.net' }), allowed)).toBe(
      false
    );
  });

  it('rejects an allowed host reached over a different scheme or port', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(validateOrigin(requestWith({ origin: 'http://oswstudio.com' }), allowed)).toBe(false);
    expect(validateOrigin(requestWith({ origin: 'https://oswstudio.com:8443' }), allowed)).toBe(
      false
    );
  });

  it('accepts the app origin itself', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(validateOrigin(requestWith({ origin: APP_URL }), allowed)).toBe(true);
  });

  it('accepts a deployment on a slug subdomain', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(
      validateOrigin(requestWith({ origin: 'https://sunny-oak.oswstudio.com' }), allowed)
    ).toBe(true);
  });

  it('rejects a subdomain of a lookalike of the app host', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    // The wildcard entry is `https://*.oswstudio.com`; `evil-oswstudio.com` is a different domain
    // that happens to end in the same characters once the leading dot is dropped.
    expect(
      validateOrigin(requestWith({ origin: 'https://x.evil-oswstudio.com' }), allowed)
    ).toBe(false);
  });

  it('accepts a configured custom domain', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT, 'sweetcandies.com');

    expect(validateOrigin(requestWith({ origin: 'https://sweetcandies.com' }), allowed)).toBe(true);
    expect(validateOrigin(requestWith({ origin: 'http://sweetcandies.com' }), allowed)).toBe(true);
  });

  it('rejects a lookalike of a configured custom domain', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT, 'sweetcandies.com');

    expect(
      validateOrigin(requestWith({ origin: 'https://sweetcandies.com.evil.net' }), allowed)
    ).toBe(false);
  });

  it('rejects a request carrying neither header', () => {
    expect(validateOrigin(requestWith({}), getAllowedOrigins(DEPLOYMENT))).toBe(false);
  });
});

describe('validateOrigin — Referer fallback', () => {
  it('accepts a page under the deployment path', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(
      validateOrigin(
        requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}/index.html` }),
        allowed
      )
    ).toBe(true);
  });

  it('accepts the deployment path with no trailing segment', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(
      validateOrigin(requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}` }), allowed)
    ).toBe(true);
    expect(
      validateOrigin(requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}/` }), allowed)
    ).toBe(true);
    expect(
      validateOrigin(requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}?x=1` }), allowed)
    ).toBe(true);
  });

  it('rejects a lookalike host in the referer', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(
      validateOrigin(requestWith({ referer: 'https://oswstudio.com.evil.net/page' }), allowed)
    ).toBe(false);
    expect(
      validateOrigin(requestWith({ referer: 'https://oswstudio.com-evil.net/page' }), allowed)
    ).toBe(false);
  });

  it('matches a path entry only at a segment boundary', () => {
    // The path entry alone, not the whole analytics allowlist: that also names the bare app URL,
    // which covers every path on the origin, so the boundary rule would be invisible through it.
    const pathEntry = [`${APP_URL}/deployments/${DEPLOYMENT}`];

    expect(
      validateOrigin(
        requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}/index.html` }),
        pathEntry
      )
    ).toBe(true);
    // A different deployment whose id starts with this one's must not borrow its allowance.
    expect(
      validateOrigin(
        requestWith({ referer: `${APP_URL}/deployments/${DEPLOYMENT}-other/index.html` }),
        pathEntry
      )
    ).toBe(false);
  });

  it('accepts a page on a slug subdomain', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(
      validateOrigin(requestWith({ referer: 'https://sunny-oak.oswstudio.com/about' }), allowed)
    ).toBe(true);
  });

  it('is used only when Origin is absent, never to rescue a rejected Origin', () => {
    const allowed = getAllowedOrigins(DEPLOYMENT);

    // A cross-site page can put anything in a fetch's referrer policy, but the browser sets Origin
    // itself. If a present Origin is refused, a friendly Referer must not overturn it.
    expect(
      validateOrigin(
        requestWith({
          origin: 'https://evil.example',
          referer: `${APP_URL}/deployments/${DEPLOYMENT}/index.html`,
        }),
        allowed
      )
    ).toBe(false);
  });
});

describe('validateOrigin — localhost development', () => {
  it('accepts the loopback origins the dev allowlist names', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(validateOrigin(requestWith({ origin: 'http://localhost:3000' }), allowed)).toBe(true);
    expect(validateOrigin(requestWith({ origin: 'http://127.0.0.1:3000' }), allowed)).toBe(true);
  });

  it('does not add a wildcard for a localhost app URL', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');

    expect(getAllowedOrigins(DEPLOYMENT).some(entry => entry.includes('*'))).toBe(false);
  });
});

describe('validateOrigin — a sites address', () => {
  // Sites served on their own origin (SITES_ORIGIN, the desktop's second port) post their analytics
  // from there; without it on the list every pageview from such a site is refused.
  it('accepts the sites address the deployment is served from', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:30011');
    vi.stubEnv('SITES_ORIGIN', 'http://localhost:30012');
    const allowed = getAllowedOrigins(DEPLOYMENT);

    expect(validateOrigin(requestWith({ origin: 'http://localhost:30012' }), allowed)).toBe(true);
    expect(
      validateOrigin(requestWith({ referer: `http://localhost:30012/deployments/${DEPLOYMENT}/` }), allowed)
    ).toBe(true);
    // Control: another port on the same host is a different origin.
    expect(validateOrigin(requestWith({ origin: 'http://localhost:30013' }), allowed)).toBe(false);
  });

  it('adds nothing when the sites address is the app itself', () => {
    const without = getAllowedOrigins(DEPLOYMENT);
    vi.stubEnv('SITES_ORIGIN', `${APP_URL}/`);

    expect(getAllowedOrigins(DEPLOYMENT)).toEqual(without);
  });
});
