import { cookies, headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { LOCALE_COOKIE } from '@/lib/i18n/config';
import { getOfferStrings } from '@/lib/i18n/offer';
import { detectOfferLocale } from '@/lib/i18n/resolve';

import { LanguageOffer } from './index';

/**
 * Decides on the server whether there is a language to offer, so the answer does not depend on
 * client state. Any cookie at all, including the one written by declining, ends the offer for good.
 */
export async function LanguageOfferSlot() {
  const store = await cookies();
  if (store.has(LOCALE_COOKIE)) return null;

  const offered = detectOfferLocale((await headers()).get('accept-language'));
  if (!offered) return null;

  // Always English: the offer only appears while English is the active locale.
  const t = await getTranslations('languageOffer');

  return (
    <LanguageOffer locale={offered} strings={getOfferStrings(offered)} declineLabel={t('decline')} />
  );
}
