import { describe, it, expect } from 'vitest';

import { detectOfferLocale, resolveLocale } from '../resolve';

describe('resolveLocale', () => {
  it('passes a supported locale through', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('ko')).toBe('ko');
    expect(resolveLocale('fi')).toBe('fi');
  });

  it('falls back to English for anything else', () => {
    for (const value of [undefined, '', 'fr', 'KO', 'ko-KR', 'en-US', '../../etc/passwd', '{}']) {
      expect(resolveLocale(value)).toBe('en');
    }
  });
});

describe('detectOfferLocale', () => {
  it('offers the first supported non-English language', () => {
    expect(detectOfferLocale('ko-KR,ko;q=0.9,en;q=0.8')).toBe('ko');
    expect(detectOfferLocale('ko-KR')).toBe('ko');
  });

  /**
   * The spec fixed `fi,sv` as a null case, which was only true while Finnish was unsupported.
   * Shipping Finnish inverts it, so the unsupported-language case moved to tags we do not carry.
   */
  it('offers Finnish, and nothing for languages we do not carry', () => {
    expect(detectOfferLocale('fi,sv')).toBe('fi');
    expect(detectOfferLocale('sv,da')).toBe(null);
  });

  it('stays silent once it reaches English, whatever follows', () => {
    expect(detectOfferLocale('en-US,ko;q=0.5')).toBe(null);
    expect(detectOfferLocale('en')).toBe(null);
  });

  it('reads q-values rather than header order', () => {
    expect(detectOfferLocale('en;q=0.3,ko;q=0.9')).toBe('ko');
    // Equal weights keep the order the browser sent.
    expect(detectOfferLocale('fi,ko')).toBe('fi');
    expect(detectOfferLocale('ko,fi')).toBe('ko');
  });

  it('is case insensitive, as Accept-Language is', () => {
    expect(detectOfferLocale('KO-kr')).toBe('ko');
  });

  it('gives nothing for empty, wildcard or malformed headers', () => {
    for (const header of [null, undefined, '', '   ', '*', 'ko;q=abc', 'ko;q=0', ';;;', ',']) {
      expect(detectOfferLocale(header)).toBe(null);
    }
  });
});
