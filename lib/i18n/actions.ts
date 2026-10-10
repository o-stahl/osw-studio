'use server';

import { cookies } from 'next/headers';

import { secureCookies } from '@/lib/auth/secure-cookies';
import { LOCALE_COOKIE, isLocale, type Locale } from './config';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The only writer of the locale cookie. Callers refresh the router afterwards rather than having
 * this revalidate, so client state (the open project, editor contents) survives the switch.
 */
export async function setLocale(locale: Locale, options?: { embedded?: boolean }): Promise<void> {
  // Anything can call a server action; a value that is not a supported locale changes nothing.
  if (!isLocale(locale)) return;

  const secure = secureCookies();
  // In a cross-site frame (a HuggingFace Space inside huggingface.co) the browser neither stores nor
  // sends a Lax cookie. A partitioned one is kept for that embedding site only, which is where the
  // frame's other storage lives too. It needs Secure, so plain HTTP keeps Lax.
  const framed = options?.embedded === true && secure;

  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    // Not HttpOnly: the value is no secret, and HttpOnly cookies do not hold on HuggingFace Spaces.
    httpOnly: false,
    secure,
    ...(framed ? { sameSite: 'none' as const, partitioned: true } : { sameSite: 'lax' as const }),
  });
}
