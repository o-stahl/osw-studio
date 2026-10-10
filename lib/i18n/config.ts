export const locales = ['en', 'ko', 'fi'] as const;

export type Locale = (typeof locales)[number];

// Annotating this `Locale` would widen it, and `Exclude<Locale, typeof defaultLocale>` would then
// collapse to never. `satisfies` checks it is a real locale while keeping the literal type.
export const defaultLocale = 'en' satisfies Locale;

/** Every locale that can be offered: English is what the app already renders in. */
export type OfferLocale = Exclude<Locale, typeof defaultLocale>;

export const LOCALE_COOKIE = 'osw_locale';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (locales as readonly string[]).includes(value);
}

/**
 * Shown in the selector and the first-visit offer, so each name is written in its own language: a
 * reader looking for their language cannot be expected to recognise its English name.
 */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  ko: '한국어',
  fi: 'Suomi',
};
