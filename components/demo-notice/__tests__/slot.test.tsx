import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type React from 'react';

/**
 * Who sees the demo notice: visitors to the hosted demo, while it offers the hosted service's accounts,
 * who have not dismissed it, and not while the language offer is still waiting for its answer (the two
 * share the top of the page).
 */
const mocks = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  acceptLanguage: 'en-US,en;q=0.9' as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    has: (name: string) => name in mocks.cookies,
    get: (name: string) => (name in mocks.cookies ? { name, value: mocks.cookies[name] } : undefined),
  }),
  headers: async () => ({ get: (name: string) => (name === 'accept-language' ? mocks.acceptLanguage : null) }),
}));

import { DemoNoticeSlot } from '../slot';
import { DemoNotice } from '..';

beforeEach(() => {
  mocks.cookies = {};
  mocks.acceptLanguage = 'en-US,en;q=0.9';
  vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
  vi.stubEnv('DEMO_ACCOUNT_LINKS', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('DemoNoticeSlot', () => {
  it('shows on the hosted demo, pointing at its gateway', async () => {
    const el = (await DemoNoticeSlot()) as React.ReactElement<React.ComponentProps<typeof DemoNotice>>;
    expect(el.type).toBe(DemoNotice);
    expect(el.props).toEqual({ signInUrl: 'https://gateway.example.com/login', signUpUrl: 'https://gateway.example.com/register' });
  });

  it('shows nothing on the demo while it offers no accounts', async () => {
    vi.stubEnv('DEMO_ACCOUNT_LINKS', '');
    expect(await DemoNoticeSlot()).toBeNull();
  });

  it('shows nothing anywhere else', async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    expect(await DemoNoticeSlot()).toBeNull();
  });

  it('shows nothing once dismissed', async () => {
    mocks.cookies = { osws_demo_notice: 'dismissed' };
    expect(await DemoNoticeSlot()).toBeNull();
  });

  it('waits while the language offer is up, and shows once it is answered', async () => {
    mocks.acceptLanguage = 'fi-FI,fi;q=0.9,en;q=0.8';
    expect(await DemoNoticeSlot()).toBeNull();
    mocks.cookies = { osw_locale: 'en' };
    expect(await DemoNoticeSlot()).not.toBeNull();
  });
});
