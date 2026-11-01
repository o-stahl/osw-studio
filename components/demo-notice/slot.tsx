import { cookies, headers } from 'next/headers';

import { DEMO_NOTICE_COOKIE, demoAccountUrl } from '@/lib/demo';
import { LOCALE_COOKIE } from '@/lib/i18n/config';
import { detectOfferLocale } from '@/lib/i18n/resolve';

import { DemoNotice } from './index';

/**
 * Decides on the server whether the demo notice shows: only on a demo that offers accounts
 * (`DEMO_ACCOUNT_LINKS`), until dismissed, and not while the language offer is waiting for its answer.
 * The two share the top of the page; the offer goes first, and answering it refreshes the page, which
 * brings the notice.
 */
export async function DemoNoticeSlot() {
  const signInUrl = demoAccountUrl('login');
  const signUpUrl = demoAccountUrl('register');
  if (!signInUrl || !signUpUrl) return null;

  const store = await cookies();
  if (store.get(DEMO_NOTICE_COOKIE)?.value === 'dismissed') return null;
  if (!store.has(LOCALE_COOKIE) && detectOfferLocale((await headers()).get('accept-language'))) return null;

  return <DemoNotice signInUrl={signInUrl} signUpUrl={signUpUrl} />;
}
