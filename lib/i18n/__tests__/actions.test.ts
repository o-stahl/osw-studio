import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `setLocale` is a server action, so anything can call it with anything. A value that is not a
 * supported locale leaves the cookie alone rather than switching the person to English: a control
 * that reports an empty choice (a toggle group clicked on its active item) must not change the
 * language.
 */

const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));

import { setLocale } from '../actions';

beforeEach(() => { jar.set.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('setLocale', () => {
  it('writes a supported locale to the cookie', async () => {
    await setLocale('fi');
    expect(jar.set).toHaveBeenCalledTimes(1);
    expect(jar.set.mock.calls[0].slice(0, 2)).toEqual(['osw_locale', 'fi']);
  });

  it.each(['', 'xx', 'EN', '../en'])('leaves the cookie alone for %j', async (value) => {
    await setLocale(value as never);
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe('the locale cookie', () => {
  const options = () => jar.set.mock.calls[0][2] as Record<string, unknown>;

  it('is readable by the page, site-wide, for a year', async () => {
    await setLocale('ko');
    // HttpOnly cookies do not hold on HuggingFace Spaces, and the value is no secret.
    expect(options()).toMatchObject({ httpOnly: false, path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
  });

  it('is secure in production unless SECURE_COOKIES=false, and never in development', async () => {
    const secureWith = async (nodeEnv: string, secureCookies?: string) => {
      jar.set.mockReset();
      vi.stubEnv('NODE_ENV', nodeEnv);
      if (secureCookies === undefined) delete process.env.SECURE_COOKIES;
      else vi.stubEnv('SECURE_COOKIES', secureCookies);
      await setLocale('fi');
      return options().secure;
    };
    expect(await secureWith('production')).toBe(true);
    expect(await secureWith('production', 'true')).toBe(true);
    expect(await secureWith('production', 'false')).toBe(false);
    expect(await secureWith('development')).toBe(false);
    expect(await secureWith('development', 'true')).toBe(false);
  });
});

describe('the locale cookie in a cross-site frame', () => {
  const options = () => jar.set.mock.calls[0][2] as Record<string, unknown>;

  it('is partitioned and SameSite=None when the page is embedded over HTTPS', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setLocale('fi', { embedded: true });
    expect(options()).toMatchObject({ sameSite: 'none', secure: true, partitioned: true });
  });

  it('stays Lax and unpartitioned on a page that is not embedded', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setLocale('fi', { embedded: false });
    expect(options()).toMatchObject({ sameSite: 'lax', secure: true });
    expect(options()).not.toHaveProperty('partitioned');
  });

  it('stays Lax where the cookie cannot be Secure, since SameSite=None requires it', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    await setLocale('fi', { embedded: true });
    expect(options()).toMatchObject({ sameSite: 'lax', secure: false });
    expect(options()).not.toHaveProperty('partitioned');
  });

  it('treats anything but a literal true as not embedded', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setLocale('fi', { embedded: 'yes' } as never);
    expect(options()).toMatchObject({ sameSite: 'lax' });
  });
});
