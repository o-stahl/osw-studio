import { NextRequest, NextResponse } from 'next/server';
import { codexCookieName } from '../cookie';

/**
 * Returns whether the HttpOnly refresh token cookie exists.
 * Used by the client for mount-time reconciliation.
 */
export async function GET(request: NextRequest) {
  const hasRefreshToken = !!request.cookies.get(codexCookieName())?.value;
  return NextResponse.json({ hasRefreshToken });
}
