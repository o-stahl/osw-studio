import { describe, it, expect } from 'vitest';
import { config } from '../middleware';

/**
 * Which paths reach the middleware at all.
 *
 * A preview iframe sends every asset reference the VFS interceptor misses to this app, and a
 * project referencing files it does not contain turns those into a stream of requests that can only
 * 404. Running each one through the session check costs a JWT verification, so static-asset
 * extensions are excluded from the matcher.
 *
 * These assertions are on the pattern, not on Next's routing: they catch an extension being dropped
 * from the list or the negative lookahead being broken. That the pattern is applied to the pathname
 * rather than the full URL, so a query string does not defeat the `$` anchor, was verified against a
 * running server instead.
 */

const matcher = new RegExp(`^${config.matcher[0]}$`);
const reachesMiddleware = (pathname: string) => matcher.test(pathname);

const WS = '/w/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

describe('the middleware matcher', () => {
  it('still guards the workspace pages and APIs', () => {
    for (const path of [`${WS}/projects`, `${WS}/deployments`, `/api/w/x/sync/status`, '/admin/users']) {
      expect(reachesMiddleware(path)).toBe(true);
    }
  });

  it('skips the asset types a preview miss produces', () => {
    // Scripts and stylesheets are the ones that were costing a session check; a webpack chunk
    // loader retrying a missing one sent thousands.
    for (const extension of ['js', 'mjs', 'cjs', 'css', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'ico', 'avif']) {
      expect(reachesMiddleware(`${WS}/wp-content/plugins/x/a.bundle.min.${extension}`)).toBe(false);
    }
  });

  it('still skips the image types it always did', () => {
    for (const extension of ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp']) {
      expect(reachesMiddleware(`${WS}/img/logo.${extension}`)).toBe(false);
    }
  });

  it('does not exclude a path merely containing an extension name', () => {
    // The lookahead is anchored, so a directory called `js` or a page called `css` is not an asset.
    expect(reachesMiddleware(`${WS}/js/settings`)).toBe(true);
    expect(reachesMiddleware(`${WS}/projects/my.css.project`)).toBe(true);
  });

  it('never skips an API path, whatever it ends in', () => {
    // A route whose last segment is a value can be sent one ending in `.js`; skipping it would skip
    // the cross-origin write check, which is the only one that route has.
    for (const path of ['/api/w/x/sync/projects/evil.js', '/api/admin/users/x.css', '/api/w/x/deployments/d.png']) {
      expect(reachesMiddleware(path)).toBe(true);
    }
  });

  it('keeps excluding the build output', () => {
    expect(reachesMiddleware('/_next/static/chunks/main.js')).toBe(false);
  });

  it('never skips a published site or review copy, so the studio host can send it to its own host', () => {
    // An .svg skipped here would be served on the studio's origin, where opening it runs its script.
    for (const path of ['/deployments/abc/index.html', '/deployments/abc/logo.svg', '/deployments/abc/app.js', '/review/abc/x.svg']) {
      expect(reachesMiddleware(path), path).toBe(true);
    }
  });
});
