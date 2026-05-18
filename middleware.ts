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
import { verifySession, maybeRefreshSession, SESSION_COOKIE_NAME, SESSION_DURATION } from '@/lib/auth/session';
import type { SessionData } from '@/lib/auth/session';

async function nextWithRefreshedSession(session: SessionData): Promise<NextResponse> {
  const response = NextResponse.next();
  const refreshed = await maybeRefreshSession(session);
  if (refreshed) {
    response.cookies.set(SESSION_COOKIE_NAME, refreshed, {
      httpOnly: true,
      secure: process.env.SECURE_COOKIES !== 'false' && process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_DURATION / 1000,
      path: '/',
    });
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

  // Desktop app: skip auth but still handle workspace routing
  if (isDesktop) {
    // Legacy redirect: /admin/{view} -> /w/{workspaceId}/{view}
    if (pathname.startsWith('/admin')) {
      for (const view of WORKSPACE_VIEWS) {
        if (pathname === `/admin/${view}` || pathname.startsWith(`/admin/${view}/`)) {
          const workspaceId = request.cookies.get('osw_workspace')?.value;
          if (workspaceId) {
            const newPath = pathname.replace(`/admin/${view}`, `/w/${workspaceId}/${view}`);
            return NextResponse.redirect(new URL(newPath, request.url));
          }
          // No workspace cookie yet — redirect to root to trigger bootstrap
          return NextResponse.redirect(new URL('/', request.url));
        }
      }
    }
    return NextResponse.next();
  }

  // ============================================
  // Workspace page routes: /w/[workspaceId]/*
  // ============================================
  if (pathname.startsWith('/w/')) {
    if (!isServerMode) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    const token = request.cookies.get('osw_session')?.value;
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
      response.cookies.delete('osw_session');
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

    const token = request.cookies.get('osw_session')?.value;
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

    const token = request.cookies.get('osw_session')?.value;
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
    const token = request.cookies.get('osw_session')?.value;
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

    const token = request.cookies.get('osw_session')?.value;
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
          return NextResponse.redirect(new URL(newPath, request.url));
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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
