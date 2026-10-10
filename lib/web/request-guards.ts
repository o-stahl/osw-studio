import { NextRequest, NextResponse } from 'next/server';
import { getIdentifier } from '@/lib/analytics/rate-limiter';
import { checkRateLimit } from '@/lib/web/rate-limit';
import { workspaceFromRequest } from '@/lib/web/workspace-cookie';

export function isSameOrigin(request: NextRequest): boolean {
  const host = request.headers.get('host') || '';
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const selfOrigin = `${proto}://${host}`;
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';
  if (origin) return origin === selfOrigin;
  if (referer) return referer.startsWith(selfOrigin + '/') || referer === selfOrigin;
  return false;
}

/**
 * Shared preflight for the web proxy routes: kill-switch, same-origin,
 * server-mode session presence, and rate limiting. Returns either an rlKey
 * (all checks passed) or a ready-to-return error response.
 */
export function webRequestPreflight(
  request: NextRequest,
): { ok: true; rlKey: string } | { ok: false; response: NextResponse } {
  if (process.env.OSW_DISABLE_WEB_PROXY === '1') {
    return { ok: false, response: NextResponse.json({ error: 'web access is disabled on this instance' }, { status: 403 }) };
  }
  if (!isSameOrigin(request)) {
    return { ok: false, response: NextResponse.json({ error: 'origin not allowed' }, { status: 403 }) };
  }
  const workspace = workspaceFromRequest(request) ?? null;
  if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true' && !workspace) {
    return { ok: false, response: NextResponse.json({ error: 'authentication required' }, { status: 401 }) };
  }
  const rlKey = workspace || getIdentifier(request);
  if (!checkRateLimit(rlKey)) {
    return { ok: false, response: NextResponse.json({ error: 'rate limit exceeded, slow down' }, { status: 429 }) };
  }
  return { ok: true, rlKey };
}
