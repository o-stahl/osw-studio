import { describe, it, expect } from 'vitest';
import { pageForCapture } from '../deployment-thumbnail';

/**
 * A published page is captured from its built HTML in a sandboxed shell (SEC-6): its assets load
 * from the site's own URL through a `<base>`, which has to come before anything that names a URL,
 * and the bridge that answers the capture request comes with it.
 */
describe('pageForCapture', () => {
  const url = 'https://sunny.inst-1.oswstudio.com/about.html';

  it('puts the base and the bridge first in the head', () => {
    const out = pageForCapture('<html><head><link rel="stylesheet" href="/s.css"></head><body></body></html>', url);
    const head = out.slice(out.indexOf('<head>') + 6);
    expect(head.startsWith(`<base href="${url}">`)).toBe(true);
    expect(head.indexOf('data-osw-bridge')).toBeLessThan(head.indexOf('<link'));
  });

  it('adds a head where the page has none', () => {
    expect(pageForCapture('<html><body>x</body></html>', url)).toMatch(/^<html><head><base href=/);
    expect(pageForCapture('<p>x</p>', url)).toMatch(/^<base href=/);
  });

  it('cannot be broken out of by the URL', () => {
    expect(pageForCapture('<head></head>', 'https://x.test/"><script>bad()</script>')).not.toContain('"><script>bad');
  });
});
