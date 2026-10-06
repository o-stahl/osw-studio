import { describe, it, expect, beforeEach, vi } from 'vitest';
import type React from 'react';

/**
 * Who sees the offer: only a visitor with no locale cookie yet (any answer writes one), and only
 * when their browser ranks a language we have above English.
 */
const mocks = vi.hoisted(() => ({
  cookie: false,
  acceptLanguage: null as string | null,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ has: (name: string) => mocks.cookie && name === 'osw_locale' }),
  headers: async () => ({ get: (name: string) => (name === 'accept-language' ? mocks.acceptLanguage : null) }),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => `t:${key}` }));

import { LanguageOfferSlot } from '../slot';
import { LanguageOffer } from '..';
import { getOfferStrings } from '@/lib/i18n/offer';

beforeEach(() => {
  mocks.cookie = false;
  mocks.acceptLanguage = null;
});

describe('LanguageOfferSlot', () => {
  it('offers Finnish to a first visit whose browser prefers it', async () => {
    mocks.acceptLanguage = 'fi-FI,fi;q=0.9,en;q=0.8';
    const el = (await LanguageOfferSlot()) as React.ReactElement<React.ComponentProps<typeof LanguageOffer>>;
    expect(el.type).toBe(LanguageOffer);
    expect(el.props.locale).toBe('fi');
    expect(el.props.strings).toEqual(getOfferStrings('fi'));
    expect(el.props.declineLabel).toBe('t:decline');
  });

  it('asks nothing once a language has been chosen', async () => {
    mocks.cookie = true;
    mocks.acceptLanguage = 'ko-KR,ko;q=0.9';
    expect(await LanguageOfferSlot()).toBeNull();
  });

  it('asks nothing of a browser that prefers English', async () => {
    mocks.acceptLanguage = 'en-US,en;q=0.9,fi;q=0.8';
    expect(await LanguageOfferSlot()).toBeNull();
  });

  it('asks nothing without the header', async () => {
    expect(await LanguageOfferSlot()).toBeNull();
  });
});
