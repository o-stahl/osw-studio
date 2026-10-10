import { secureCookies } from '@/lib/auth/secure-cookies';

/**
 * The ChatGPT sign-in cookies: the refresh token, and the state of a sign-in in progress.
 *
 * `__Host-` wherever cookies are Secure, like the session cookie (`sessionCookieName`): the browser
 * then takes them only from the studio's exact host, so a published site on a sibling subdomain
 * cannot plant a refresh token of its own choosing for the studio. Plain HTTP keeps the old names.
 */
const LEGACY_CODEX_COOKIE_NAME = 'osw_codex_rt';
const LEGACY_CODEX_LOGIN_COOKIE_NAME = 'osw_codex_login';
export const CODEX_COOKIE_MAX_AGE = 90 * 24 * 60 * 60; // 90 days
export const CODEX_LOGIN_COOKIE_MAX_AGE = 10 * 60;

const prefixed = (name: string) => (secureCookies() ? `__Host-${name}` : name);

export function codexCookieName(): string {
  return prefixed(LEGACY_CODEX_COOKIE_NAME);
}

export function codexLoginCookieName(): string {
  return prefixed(LEGACY_CODEX_LOGIN_COOKIE_NAME);
}

/** The pre-prefix names, cleared wherever these cookies are written so they stop being sent. */
export function legacyCodexCookieNames(): string[] {
  return secureCookies() ? [LEGACY_CODEX_COOKIE_NAME, LEGACY_CODEX_LOGIN_COOKIE_NAME] : [];
}

export function codexCookieOptions(maxAge = CODEX_COOKIE_MAX_AGE) {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax' as const,
    maxAge,
    path: '/',
  };
}
