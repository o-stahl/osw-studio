import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The proxies the instance's Caddy believes X-Forwarded-For from come from TRUSTED_PROXIES, and from
 * nowhere else: not a vendor's list in the code, and not GATEWAY_IPS, which says who may use the
 * instance API key rather than who passes visitors on.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/system-database', () => ({ getAllSlugRoutes: () => [], getAllDomainRoutes: () => [] }));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-caddy-proxies-'));
  vi.resetModules();
  vi.stubEnv('STATIC_PROXY', 'true');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.example.com');
  vi.stubEnv('CADDYFILE_PATH', path.join(dir, 'Caddyfile'));
  vi.stubEnv('GATEWAY_IPS', '203.0.113.10');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function regenerated(): Promise<string> {
  const { regenerateInstanceCaddy } = await import('@/lib/caddy/regenerate');
  await regenerateInstanceCaddy();
  return fs.readFileSync(path.join(dir, 'Caddyfile'), 'utf-8');
}

const trustedIn = (config: string) => config.match(/^\s*trusted_proxies static (.+)$/m)?.[1].trim().split(/\s+/) ?? null;

describe('TRUSTED_PROXIES', () => {
  it('lists the proxies the generated config trusts, with nothing to warn about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TRUSTED_PROXIES', '192.0.2.0/24, 2001:db8::/32,203.0.113.10');
    expect(trustedIn(await regenerated())).toEqual(['192.0.2.0/24', '2001:db8::/32', '203.0.113.10']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('trusts no proxy when unset, whatever GATEWAY_IPS holds', async () => {
    expect(trustedIn(await regenerated())).toBeNull();
  });

  it('warns about entries it leaves out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TRUSTED_PROXIES', '203.0.113.10,cloudflare,10.0.0.0/33x');
    expect(trustedIn(await regenerated())).toEqual(['203.0.113.10']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toMatch(/cloudflare.*10\.0\.0\.0\/33x|10\.0\.0\.0\/33x.*cloudflare/);
  });
});
