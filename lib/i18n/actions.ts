'use server';

import { cookies } from 'next/headers';

import { LOCALE_COOKIE, isLocale, type Locale } from './config';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The only writer of the locale cookie. Callers refresh the router afterwards rather than having
 * this revalidate, so client state (the open project, editor contents) survives the switch.
 */
export async function setLocale(locale: Locale): Promise<void> {
  // Anything can call a server action; a value that is not a supported locale changes nothing.
  if (!isLocale(locale)) return;

  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
    // Not HttpOnly: the value is no secret, and HttpOnly cookies do not hold on HuggingFace Spaces.
    httpOnly: false,
    secure: process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production',
  });
}
