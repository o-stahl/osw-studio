import { NextRequest, NextResponse } from 'next/server';
import { verifyHandoffToken, createSession, setSessionOnResponse } from '@/lib/auth/session';
import { getUserById, getUserDefaultWorkspace } from '@/lib/auth/system-database';
import { ensureDefaultWorkspace } from '@/lib/auth/default-workspace';
import { setWorkspaceOnResponse } from '@/lib/web/workspace-cookie';

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function sanitizeRedirect(redirect: string): string {
  // Only allow relative paths starting with / — block open redirects
  if (!redirect.startsWith('/') || redirect.startsWith('//')) return '/';
  return redirect;
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const rawRedirect = request.nextUrl.searchParams.get('redirect') || '/';
  const redirect = sanitizeRedirect(rawRedirect);

  if (!token) {
    return NextResponse.redirect(new URL('/admin/login', process.env.NEXT_PUBLIC_APP_URL || request.url));
  }

  const result = await verifyHandoffToken(token);
  if (!result) {
    return NextResponse.redirect(new URL('/admin/login', process.env.NEXT_PUBLIC_APP_URL || request.url));
  }

  const user = getUserById(result.userId);
  if (!user) {
    return NextResponse.redirect(new URL('/admin/login', process.env.NEXT_PUBLIC_APP_URL || request.url));
  }

  // Ensure workspace is fully initialized (same as login flow)
  await ensureDefaultWorkspace(user.id);

  // Create a normal OSWS session for this user
  const sessionToken = await createSession(user.id, user.email, !!user.is_admin);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.url;
  const response = NextResponse.redirect(new URL(redirect, baseUrl));
  setSessionOnResponse(response, sessionToken);

  // Set osw_workspace cookie — extract workspace ID from redirect URL or use default
  const workspaceMatch = redirect.match(/\/w\/([^/]+)\//);
  const extractedId = workspaceMatch?.[1];
  const workspaceId = (extractedId && UUID_REGEX.test(extractedId)) ? extractedId : getUserDefaultWorkspace(user.id);
  if (workspaceId) {
    setWorkspaceOnResponse(response, workspaceId);
  }

  return response;
}
