import { NextResponse } from 'next/server';
import { codexCookieName, codexLoginCookieName, codexCookieOptions, legacyCodexCookieNames } from '../cookie';

/**
 * Deletes the HttpOnly refresh token cookie.
 */
export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(codexCookieName(), '', codexCookieOptions(0));
  response.cookies.set(codexLoginCookieName(), '', codexCookieOptions(0));
  for (const name of legacyCodexCookieNames()) response.cookies.delete(name);
  return response;
}
