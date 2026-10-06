import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The request's locale and messages: the cookie when it names a supported locale, English otherwise,
 * with English filled in under the active locale; and a missing key shown as its path.
 */

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'osw_locale' && jar.value !== undefined ? { value: jar.value } : undefined) }),
}));
// `getRequestConfig` only registers the callback; hand the callback back so it can be called.
vi.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));

import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import requestConfig from '../request';

type Config = {
  locale: string;
  messages: typeof en;
  getMessageFallback: (info: { namespace?: string; key: string }) => string;
};
const load = () => (requestConfig as unknown as () => Promise<Config>)();

beforeEach(() => { jar.value = undefined; });

describe('the request config', () => {
  it('serves English without a cookie, or with one naming no supported locale', async () => {
    for (const value of [undefined, 'xx', '../fi']) {
      jar.value = value;
      const config = await load();
      expect(config.locale).toBe('en');
      expect(config.messages).toBe(en);
    }
  });

  it('serves the cookie\'s locale with English underneath it', async () => {
    jar.value = 'fi';
    const config = await load();
    expect(config.locale).toBe('fi');
    expect(config.messages.styles.askAgent).toBe(fi.styles.askAgent);
    expect(config.messages.styles.askAgent).not.toBe(en.styles.askAgent);
    // Every English key is present, whatever fi.json leaves out.
    expect(Object.keys(config.messages).sort()).toEqual(expect.arrayContaining(Object.keys(en)));
  });

  it('shows a missing key as its path', async () => {
    const config = await load();
    expect(config.getMessageFallback({ namespace: 'styles', key: 'nope' })).toBe('styles.nope');
    expect(config.getMessageFallback({ key: 'nope' })).toBe('nope');
  });
});
