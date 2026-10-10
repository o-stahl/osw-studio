import { NextRequest, NextResponse } from 'next/server';
import { verifyHandoffToken, createSession, setSessionOnResponse } from '@/lib/auth/session';
import { getUserById, getUserDefaultWorkspace } from '@/lib/auth/system-database';
import { ensureDefaultWorkspace } from '@/lib/auth/default-workspace';
import { setWorkspaceOnResponse } from '@/lib/web/workspace-cookie';
import { sanitizeRedirect } from '@/lib/auth/safe-redirect';

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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

  // Select the workspace: the one in the redirect URL, or the user's default
  const workspaceMatch = redirect.match(/\/w\/([^/]+)\//);
  const extractedId = workspaceMatch?.[1];
  const workspaceId = (extractedId && UUID_REGEX.test(extractedId)) ? extractedId : getUserDefaultWorkspace(user.id);
  if (workspaceId) {
    setWorkspaceOnResponse(response, workspaceId);
  }

  return response;
}
