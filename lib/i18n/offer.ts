import offers from '@/messages/offer.json';

import type { OfferLocale } from './config';

export interface OfferStrings {
  message: string;
  accept: string;
  note: string;
}

/**
 * The offer is shown before its language is active, so its strings cannot come from `t()` and are
 * read straight from here instead. English is absent by type, not by convention: nothing offers a
 * visitor the language the app already renders in. Adding a locale without offer strings, or with
 * an incomplete set, fails tsc here.
 */
const offerStrings: Record<OfferLocale, OfferStrings> = offers;

export function getOfferStrings(locale: OfferLocale): OfferStrings {
  return offerStrings[locale];
}
