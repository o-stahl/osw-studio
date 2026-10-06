import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

import { LOCALE_COOKIE, defaultLocale } from '@/lib/i18n/config';
import { deepMerge } from '@/lib/i18n/merge';
import { resolveLocale } from '@/lib/i18n/resolve';
import en from '../messages/en.json';

export default getRequestConfig(async () => {
  const locale = resolveLocale((await cookies()).get(LOCALE_COOKIE)?.value);

  // A relative specifier keeps the generated context to messages/, so adding a locale means adding
  // a JSON file and nothing else.
  const messages =
    locale === defaultLocale
      ? en
      : deepMerge(en, (await import(`../messages/${locale}.json`)).default);

  return {
    locale,
    messages,
    onError(error) {
      // English is merged in underneath, so a miss here means the key is absent from en.json too.
      if (process.env.NODE_ENV === 'development') console.warn(error.message);
    },
    getMessageFallback({ namespace, key }) {
      return namespace ? `${namespace}.${key}` : key;
    },
  };
});
