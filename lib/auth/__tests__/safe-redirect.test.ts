import { describe, it, expect } from 'vitest';
import { sanitizeRedirect } from '../safe-redirect';

/** The handoff sends a signed-in browser on to this path, so it must never name another host. */
describe('sanitizeRedirect', () => {
  it('keeps a path on this server, query and fragment included', () => {
    expect(sanitizeRedirect('/w/ws-1/dashboard?tab=a#top')).toBe('/w/ws-1/dashboard?tab=a#top');
  });

  it.each(['//evil.com', '/\\evil.com/x', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', 'evil.com'])(
    'refuses %j, which a URL parser reads as another host',
    (redirect) => {
      expect(sanitizeRedirect(redirect)).toBe('/');
    },
  );
});
