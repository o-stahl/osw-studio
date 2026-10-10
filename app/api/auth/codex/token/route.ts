import { NextRequest, NextResponse } from 'next/server';
import { codexCookieName, codexCookieOptions, legacyCodexCookieNames } from '../cookie';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * Refreshes the Codex access token using the refresh_token stored in the
 * HttpOnly cookie. The client never sees or sends the refresh_token.
 */
export async function POST(request: NextRequest) {
  try {
    const refreshToken = request.cookies.get(codexCookieName())?.value;

    if (!refreshToken) {
      return NextResponse.json(
        { error: 'No refresh token cookie. Please re-authenticate.' },
        { status: 401 },
      );
    }

    const formBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });

    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      // If the refresh token is revoked/expired, clear the cookie
      if (res.status === 401 || res.status === 403) {
        const errResponse = NextResponse.json(
          { error: data.error_description || 'Refresh token revoked' },
          { status: 401 },
        );
        errResponse.cookies.set(codexCookieName(), '', codexCookieOptions(0));
        return errResponse;
      }
      return NextResponse.json(data, { status: res.status });
    }

    const response = NextResponse.json({
      access_token: data.access_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    });

    // If OpenAI rotated the refresh token, update the cookie
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      response.cookies.set(codexCookieName(), data.refresh_token, codexCookieOptions());
      for (const name of legacyCodexCookieNames()) response.cookies.delete(name);
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
