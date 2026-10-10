import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where Caddy is told to serve published sites from.
 *
 * Next's standalone server chdirs into `.next/standalone`, so a root built from `process.cwd()`
 * lands inside the build directory. The deploy rebuilds by removing `.next`, which took every
 * published site offline for the length of the build: `STATIC_PROXY=true` means Caddy reads them
 * off disk, so stopping or starting the app makes no difference to them. Resolving the symlink the
 * deploy leaves behind gives a path that outlives the build.
 */

vi.mock('server-only', () => ({}));
// One site, since only a site block names a root: the studio's own block only proxies.
const mocks = vi.hoisted(() => ({ slugs: vi.fn(() => [{ deployment_id: 'd1', slug: 'sunny-oak' }]), domains: vi.fn(() => []) }));
vi.mock('@/lib/auth/system-database', () => ({
  getAllSlugRoutes: mocks.slugs,
  getAllDomainRoutes: mocks.domains,
}));

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-caddy-'));
  cwd = process.cwd();
  vi.resetModules();
  vi.stubEnv('STATIC_PROXY', 'true');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://inst-1.example.com');
  vi.stubEnv('CADDYFILE_PATH', path.join(dir, 'Caddyfile'));
  // The admin reload is not what this is about.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The roots Caddy is configured with, whole lines, so a longer path cannot satisfy a prefix. */
function rootsIn(config: string): string[] {
  return config.split('\n').map(l => l.trim()).filter(l => l.startsWith('root * '));
}

async function run(): Promise<string> {
  const { regenerateInstanceCaddy } = await import('@/lib/caddy/regenerate');
  await regenerateInstanceCaddy();
  return fs.readFileSync(path.join(dir, 'Caddyfile'), 'utf-8');
}

describe('the root Caddy serves published sites from', () => {
  it('resolves the deploy symlink, so it survives the build directory being removed', async () => {
    // The shape update-server.sh leaves: a real public/ beside the build, linked into standalone.
    const real = path.join(dir, 'public');
    const standalone = path.join(dir, '.next', 'standalone');
    fs.mkdirSync(path.join(real, 'deployments'), { recursive: true });
    fs.mkdirSync(standalone, { recursive: true });
    fs.symlinkSync(real, path.join(standalone, 'public'));
    process.chdir(standalone);

    const config = await run();

    expect(rootsIn(config)).not.toHaveLength(0);
    expect([...new Set(rootsIn(config))]).toEqual([`root * ${fs.realpathSync(real)}`]);
    expect(config).not.toContain(path.join(standalone, 'public'));
  });

  it('uses the directory itself when there is no symlink', async () => {
    const root = path.join(dir, 'app');
    fs.mkdirSync(path.join(root, 'public'), { recursive: true });
    process.chdir(root);

    const config = await run();

    expect([...new Set(rootsIn(config))]).toEqual([`root * ${fs.realpathSync(path.join(root, 'public'))}`]);
  });

  it('falls back to the literal path rather than writing no config at all', async () => {
    const root = path.join(dir, 'empty');
    fs.mkdirSync(root, { recursive: true });
    process.chdir(root);
    // chdir resolves symlinks (on macOS /var is one), so the literal the code builds is from cwd.
    const expected = path.join(process.cwd(), 'public');

    const config = await run();

    expect([...new Set(rootsIn(config))]).toEqual([`root * ${expected}`]);
    expect(config).toContain('inst-1.example.com');
  });
});
