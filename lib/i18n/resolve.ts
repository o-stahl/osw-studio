import { defaultLocale, isLocale, type Locale, type OfferLocale } from './config';

/** The active locale is the cookie when it holds a supported value, otherwise English. */
export function resolveLocale(cookieValue: string | undefined): Locale {
  return isLocale(cookieValue) ? cookieValue : defaultLocale;
}

/**
 * The locale to offer a first-time visitor, or null to stay silent. Walks Accept-Language in
 * q-value order and stops at English: a visitor who ranks English above Finnish is already being
 * served their preference, so there is nothing to offer.
 */
export function detectOfferLocale(acceptLanguage: string | null | undefined): OfferLocale | null {
  if (!acceptLanguage) return null;

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      // A q parameter that is present but unreadable makes the whole tag untrustworthy, so it is
      // dropped rather than silently treated as q=1, which would offer a switch off a broken header.
      const q = params.find((param) => /^\s*q=/i.test(param));
      const quality = q === undefined ? 1 : Number.parseFloat(q.trim().slice(2));
      return { tag: tag.trim().toLowerCase(), quality };
    })
    .filter((entry) => entry.tag !== '' && Number.isFinite(entry.quality) && entry.quality > 0)
    // The sort is stable, so equal q-values keep header order, which is what the spec's ordering
    // examples assume. A `*` wildcard falls through below: it is neither English nor a locale.
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const primary = tag.split('-')[0];
    if (primary === defaultLocale) return null;
    if (isLocale(primary)) return primary as OfferLocale;
  }

  return null;
}
