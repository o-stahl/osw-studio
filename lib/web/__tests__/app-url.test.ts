import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { appUrl, configuredAppUrl } from '../site-origin';

/**
 * The studio's own address. `APP_URL` is read when the server starts, so one build (a container
 * image) serves any address; `NEXT_PUBLIC_APP_URL` still works for installs that set it.
 */
afterEach(() => vi.unstubAllEnvs());

describe('the studio address', () => {
  it('takes APP_URL first, then NEXT_PUBLIC_APP_URL, then localhost', () => {
    vi.stubEnv('APP_URL', 'https://studio.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://old.example.com');
    expect(appUrl()).toBe('https://studio.example.com');
    vi.stubEnv('APP_URL', '');
    expect(appUrl()).toBe('https://old.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(appUrl()).toBe('http://localhost:3000');
    expect(configuredAppUrl()).toBeUndefined();
  });
});

const ROOT = join(__dirname, '../../..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('who reads it', () => {
  const files = ['app', 'lib', 'components'].flatMap((d) => sources(join(ROOT, d))).concat(join(ROOT, 'middleware.ts'));

  it('only site-origin reads the variables; everything else asks appUrl() or configuredAppUrl()', () => {
    const readers = files
      .filter((f) => /process\.env\.(NEXT_PUBLIC_)?APP_URL/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(readers).toEqual(['lib/web/site-origin.ts']);
  });

  it('no client module reads the address: a generic image has none at build time', () => {
    const client = files.filter((f) => /^['"]use client['"]/m.test(readFileSync(f, 'utf8')));
    expect(client.length).toBeGreaterThan(20);
    const readers = client
      .filter((f) => /APP_URL|appUrl\(|configuredAppUrl\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(readers).toEqual([]);
  });
});
