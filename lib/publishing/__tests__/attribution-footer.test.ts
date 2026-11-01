import { describe, it, expect } from 'vitest';
import { injectAttributionFooter } from '@/lib/publishing/attribution-footer';

describe('injectAttributionFooter', () => {
  it('inserts the credit just before </body>', () => {
    const out = injectAttributionFooter('<html><body><h1>Hi</h1></body></html>');
    expect(out).toContain('Built with');
    expect(out).toContain('href="https://try.oswstudio.com"');
    expect(out.indexOf('Built with')).toBeLessThan(out.indexOf('</body>'));
  });
  it('appends to the end when there is no </body>', () => {
    const out = injectAttributionFooter('<h1>Hi</h1>');
    expect(out).toContain('Built with');
    expect(out).toContain('<h1>Hi</h1>');
    expect(out.indexOf('Built with')).toBeGreaterThan(out.indexOf('<h1>Hi</h1>'));
  });
  it('does not inject twice if a marker is already present', () => {
    const once = injectAttributionFooter('<body></body>');
    const twice = injectAttributionFooter(once);
    expect(twice.match(/data-osw-credit/g)?.length).toBe(1);
  });
});
