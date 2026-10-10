import { NextRequest, NextResponse } from 'next/server';
import { mcpEnabled } from '@/lib/mcp/auth';
import { getMcpClient } from '@/lib/mcp/store';
import { pendingMcpCookieName, pendingMcpCookieOptions, pendingAuthorizationIsWellFormed } from '@/lib/mcp/pending';

/**
 * Holding an authorization request across the gateway login.
 *
 * On a hosted instance the consent screen cannot simply bounce a signed-out visitor to
 * `/admin/login?next=...`: middleware sends `/admin/login` on to the gateway, which has no notion of
 * a destination — its login always lands on `/account`, and the handoff it builds afterwards names
 * `/w/{id}/dashboard`. The authorization request was dropped there, so the client sat at its
 * redirect URI waiting for a callback that never came, which looks like a hang rather than an error.
 *
 * Rather than teach the gateway to carry a destination — a path on an instance it only picks later,
 * which it would then have to validate against the user's own instances — the request is held here,
 * in a short-lived cookie on the instance's own origin. It survives the round trip because the
 * browser comes back to this same host, and `middleware.ts` spends it on the way in.
 *
 * The cookie holds only the query the client itself sent, and it is spent on the consent screen,
 * which re-validates `client_id` and `redirect_uri` before anything is shown. So the worst a crafted
 * link achieves is a consent screen the visitor must still approve — the same as sending them to
 * `/mcp/authorize` directly.
 */
export async function GET(request: NextRequest) {
  if (!mcpEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (!gatewayUrl) {
    // No external login to bounce through: the instance's own login page carries `next` itself.
    return NextResponse.redirect(new URL('/admin/login', request.url));
  }

  const query = request.nextUrl.search.replace(/^\?/, '');
  const clientId = request.nextUrl.searchParams.get('client_id') ?? '';

  // An unregistered client is refused before anything is stored, so a stray link cannot park a
  // cookie that redirects the visitor on their next page view.
  if (!pendingAuthorizationIsWellFormed(query) || !getMcpClient(clientId)) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const response = NextResponse.redirect(`${gatewayUrl.replace(/\/$/, '')}/login`);
  response.cookies.set(pendingMcpCookieName(), query, pendingMcpCookieOptions());
  return response;
}
