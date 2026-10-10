import { describe, it, expect, afterEach, vi } from 'vitest';
import { isSiteHost } from '../site-origin';

/** Which requests arrive on the sites address, as the browser and proxies write the Host header. */
afterEach(() => vi.unstubAllEnvs());

describe('isSiteHost with a sites address', () => {
  it('matches the address with or without its default port, and nothing else', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://studio.example.com');
    vi.stubEnv('SITES_ORIGIN', 'https://sites.example.com');
    expect(isSiteHost('sites.example.com')).toBe(true);
    expect(isSiteHost('sites.example.com:443')).toBe(true);
    expect(isSiteHost('sites.example.com:8443')).toBe(false);
    expect(isSiteHost('studio.example.com')).toBe(false);
  });

  it('takes any loopback name for a loopback sites port (desktop)', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:30011');
    vi.stubEnv('SITES_ORIGIN', 'http://localhost:30012');
    expect(isSiteHost('127.0.0.1:30012')).toBe(true);
    expect(isSiteHost('[::1]:30012')).toBe(true);
    expect(isSiteHost('localhost:30011')).toBe(false);
    expect(isSiteHost('evil.test:30012')).toBe(false);
  });
});
