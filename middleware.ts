/**
 * Next.js Middleware
 *
 * Handles authentication and routing for Server mode.
 * In Browser mode, server-only routes are blocked.
 * In Server mode, all data routes require authentication.
 *
 * Workspace routing:
 * - /w/[workspaceId]/* pages require auth
 * - /api/w/[workspaceId]/* routes require auth
 * - /api/server-generate/* routes require auth
 * - Legacy /admin/{view} paths redirect to /w/{defaultWorkspaceId}/{view}
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifySession, maybeRefreshSession, sessionCookieName, sessionCookieOptions } from '@/lib/auth/session';
import type { SessionData } from '@/lib/auth/session';
import { PENDING_MCP_COOKIE, pendingAuthorizationIsWellFormed } from '@/lib/mcp/pending';
import { isCrossOriginWrite } from '@/lib/web/origin-guard';
import { isRelocatedSitePath, isSiteHost, isSitePath, isStudioHost, requestHost, sitesMode } from '@/lib/web/site-origin';

async function nextWithRefreshedSession(session: SessionData): Promise<NextResponse> {
  const response = NextResponse.next();
  const refreshed = await maybeRefreshSession(session);
  if (refreshed) {
    response.cookies.set(sessionCookieName(), refreshed, sessionCookieOptions());
  }
  return response;
}

// Views that have moved from /admin/{view} to /w/{workspaceId}/{view}
const WORKSPACE_VIEWS = ['projects', 'dashboard', 'deployments', 'settings', 'skills', 'templates', 'docs'];

function loginRedirect(request: NextRequest): NextResponse {
  const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
  if (gatewayUrl) return NextResponse.redirect(gatewayUrl + '/login');
  return NextResponse.redirect(new URL('/admin/login', request.url));
}

export async function middleware(request: NextRequest) {
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const { pathname } = request.nextUrl;
  const isDesktop = process.env.OSW_DESKTOP === 'true';

  // Before anything else, desktop included: its API has no session at all, so any page the user
  // opens could otherwise write to it on localhost.
  if (isCrossOriginWrite(request.method, pathname, request.headers)) {
    return NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 });
  }

  // Sites served away from the studio (lib/web/site-origin.ts). A site host answers only what a
  // site needs, which matters most on desktop, whose API has no session to check. On the studio
  // host, a site document is sent to where it lives instead of being served on this origin.
  const host = requestHost(request.headers);
  if (isSiteHost(host)) {
    return isSitePath(pathname) ? NextResponse.next() : new NextResponse('Not found', { status: 404 });
  }
  if (sitesMode() !== 'same-origin' && isStudioHost(host) && isRelocatedSitePath(pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new NextResponse('Not found', { status: 404 });
    }
    return NextResponse.rewrite(new URL(`/api/site-location${pathname}${request.nextUrl.search}`, request.url));
  }

  // Desktop app: skip auth but still handle workspace routing
  if (isDesktop) {
    // Only ever addressed by loopback. Any other Host is a page that resolved its own name to this
    // machine (DNS rebinding), and the desktop API has no session to stop it.
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
      return new NextResponse('Not found', { status: 404 });
    }
    // Legacy redirect: /admin/{view} -> /w/{workspaceId}/{view}
    if (pathname.startsWith('/admin')) {
      for (const view of WORKSPACE_VIEWS) {
        if (pathname === `/admin/${view}` || pathname.startsWith(`/admin/${view}/`)) {
          const workspaceId = request.cookies.get('osw_workspace')?.value;
          if (workspaceId) {
            const newPath = pathname.replace(`/admin/${view}`, `/w/${workspaceId}/${view}`);
            return NextResponse.redirect(new URL(newPath + request.nextUrl.search, request.url));
          }
          // No workspace cookie yet — redirect to root to trigger bootstrap
          return NextResponse.redirect(new URL('/', request.url));
        }
      }
    }
    return NextResponse.next();
  }

  // ============================================
  // A held MCP authorization, resumed after an external login
  // ============================================
  // The consent screen parks the request here when a signed-out visitor is sent to the gateway to
  // log in, because the gateway carries no destination of its own and lands them on a workspace.
  // The first page they open once signed in spends the cookie and puts them back on consent.
  if (isServerMode && request.method === 'GET' && !pathname.startsWith('/mcp/') && !pathname.startsWith('/api/')) {
    const pending = request.cookies.get(PENDING_MCP_COOKIE)?.value;
    if (pending) {
      const token = request.cookies.get(sessionCookieName())?.value;
      const resumed = token ? await verifySession(token) : null;
      // Spent either way once a session exists: a value that fails validation is not going to start
      // passing, and leaving it would redirect every page view until it expires.
      if (resumed) {
        const wellFormed = pendingAuthorizationIsWellFormed(pending);
        const target = new URL(wellFormed ? '/mcp/authorize' : '/', request.url);
        if (wellFormed) target.search = `?${pending}`;
        const response = NextResponse.redirect(target);
        response.cookies.delete(PENDING_MCP_COOKIE);
        return response;
      }
    }
  }

  // ============================================
  // Workspace page routes: /w/[workspaceId]/*
  // ============================================
  if (pathname.startsWith('/w/')) {
    if (!isServerMode) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    const token = request.cookies.get(sessionCookieName())?.value;
    if (!token) {
      const response = loginRedirect(request);
      // Clear stale workspace cookie
      response.cookies.delete('osw_workspace');
      return response;
    }

    const session = await verifySession(token);
    if (!session) {
      const response = loginRedirect(request);
      // Clear stale cookies
      response.cookies.delete(sessionCookieName());
      response.cookies.delete('osw_workspace');
      return response;
    }

    return nextWithRefreshedSession(session);
  }

  // ============================================
  // Server-generate API routes: /api/server-generate/*
  // ============================================
  if (pathname.startsWith('/api/server-generate')) {
    if (!isServerMode) {
      return NextResponse.json({ error: 'Not available in Browser mode' }, { status: 404 });
    }

    const token = request.cookies.get(sessionCookieName())?.value;
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const session = await verifySession(token);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return nextWithRefreshedSession(session);
  }

  // ============================================
  // Workspace API routes: /api/w/[workspaceId]/*
  // ============================================
  if (pathname.startsWith('/api/w/')) {
    if (!isServerMode) {
      return NextResponse.json({ error: 'Not available in Browser mode' }, { status: 404 });
    }

    const token = request.cookies.get(sessionCookieName())?.value;
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const session = await verifySession(token);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return nextWithRefreshedSession(session);
  }

  // ============================================
  // Admin API routes: /api/admin/*
  // ============================================
  if (pathname.startsWith('/api/admin')) {
    if (!isServerMode) {
      return NextResponse.json({ error: 'Not available in Browser mode' }, { status: 404 });
    }
    // Defense-in-depth: verify session for admin API routes
    const token = request.cookies.get(sessionCookieName())?.value;
    const apiKey = request.headers.get('x-instance-api-key');
    if (!token && !apiKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (token) {
      const session = await verifySession(token);
      if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return nextWithRefreshedSession(session);
    }
    return NextResponse.next();
  }

  // ============================================
  // Admin pages: /admin/*
  // ============================================
  if (pathname.startsWith('/admin')) {
    if (!isServerMode) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    // When managed by an external auth provider, redirect login/register there
    const gatewayUrl = process.env.NEXT_PUBLIC_GATEWAY_URL;
    if (gatewayUrl && (pathname === '/admin/login' || pathname === '/admin/register')) {
      return NextResponse.redirect(gatewayUrl + '/login');
    }

    // Allow login and register pages without auth
    // (Register API enforces REGISTRATION_MODE + zero-users check server-side)
    if (pathname === '/admin/login' || pathname === '/admin/register') {
      return NextResponse.next();
    }

    const token = request.cookies.get(sessionCookieName())?.value;
    if (!token) return loginRedirect(request);

    const session = await verifySession(token);
    if (!session) return loginRedirect(request);

    // Only admins can access user/workspace management
    if (!session.isAdmin && (pathname.startsWith('/admin/users') || pathname.startsWith('/admin/workspaces'))) {
      // Redirect non-admin to their default workspace
      const workspaceId = request.cookies.get('osw_workspace')?.value;
      if (workspaceId) {
        return NextResponse.redirect(new URL(`/w/${workspaceId}/projects`, request.url));
      }
      return loginRedirect(request);
    }

    // Legacy redirect: /admin/{view} -> /w/{workspaceId}/{view}
    for (const view of WORKSPACE_VIEWS) {
      if (pathname === `/admin/${view}` || pathname.startsWith(`/admin/${view}/`)) {
        const workspaceId = request.cookies.get('osw_workspace')?.value;
        if (workspaceId) {
          const newPath = pathname.replace(`/admin/${view}`, `/w/${workspaceId}/${view}`);
          return NextResponse.redirect(new URL(newPath + request.nextUrl.search, request.url));
        }
        // No workspace cookie — redirect to login
        return loginRedirect(request);
      }
    }

    // /admin root redirect
    if (pathname === '/admin' || pathname === '/admin/') {
      const workspaceId = request.cookies.get('osw_workspace')?.value;
      if (workspaceId) {
        return NextResponse.redirect(new URL(`/w/${workspaceId}/projects`, request.url));
      }
      return loginRedirect(request);
    }

    return nextWithRefreshedSession(session);
  }

  return NextResponse.next();
}

/**
 * Static-asset extensions skip the middleware entirely.
 *
 * A preview iframe is a `srcdoc` document with no base URL of its own, so any asset reference the
 * VFS interceptor does not resolve is sent to this app instead. A project carrying references to
 * files it does not contain (a scraped site whose lazily-loaded scripts were never captured) turns
 * every one of those into a request here, and a loader that retries turns it into thousands. Each
 * would otherwise verify the session JWT, and possibly re-sign it, before the router returns 404.
 *
 * What makes this safe is that no guarded route can end in one of these. `/api/server-generate` and
 * `/api/admin/dashboard` have this middleware as their only gate, and they are reachable only at
 * fixed paths with no extension; every route under `/api/w` additionally authenticates itself. A
 * dynamic segment added under a prefix that does not authenticate itself would break that, since
 * the segment's value is the end of the path.
 *
 * What is lost is a redirect to the login page for a *page* path ending in one of these, which no
 * real workspace view does.
 *
 * `/api/` paths are never skipped, whatever they end in: a route whose last segment is a value
 * (`/api/w/{id}/sync/projects/{id}`) can be sent one ending in `.js`, and the cross-origin write
 * check here is the only one those routes have. Preview misses resolve against page paths, not `/api/`.
 *
 * Nor are `/deployments/` and `/review/` paths: they are where a published site lives, and on the
 * studio host they are redirected to the site's own host (`lib/web/site-origin.ts`). Skipping an
 * `.svg` there would serve it on the studio's origin, and an SVG opened as a page runs its script.
 *
 * Written out rather than composed from a constant: Next has to statically analyse this value at
 * build time and ignores one it cannot, which would leave every route above unguarded.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|(?!api/|deployments/|review/).*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|js|mjs|cjs|css|map|woff|woff2|ttf|otf|eot)$).*)',
  ],
};
