/**
 * Login API Route
 *
 * Authenticates user against system database and creates session.
 * Falls back to ADMIN_PASSWORD env var for backward compatibility.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createSession, setSessionOnResponse } from '@/lib/auth/session';
import { getUserByEmail, getUserDefaultWorkspace, getWorkspaceById, getUserCount } from '@/lib/auth/system-database';
import { ensureDefaultWorkspace } from '@/lib/auth/default-workspace';
import { verifyPassword } from '@/lib/auth/passwords';
import { logger } from '@/lib/utils';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!password) {
      return NextResponse.json({ error: 'Password required' }, { status: 400 });
    }

    // If email provided, authenticate against system database
    if (email) {
      const user = getUserByEmail(email);
      if (!user) {
        return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
      }

      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
      }

      // Run legacy data migration if needed
      await ensureDefaultWorkspace(user.id);

      const token = await createSession(user.id, user.email, user.is_admin === 1);
      const defaultWorkspaceId = getUserDefaultWorkspace(user.id);
      const defaultWorkspaceName = defaultWorkspaceId ? getWorkspaceById(defaultWorkspaceId)?.name : undefined;
      const response = NextResponse.json({ success: true, defaultWorkspaceId, defaultWorkspaceName });
      setSessionOnResponse(response, token);
      return response;
    }

    // Legacy admin password — only works when no users exist (bootstrap)
    const adminPassword = process.env.ADMIN_PASSWORD;
    const userCount = getUserCount();

    if (!adminPassword || userCount > 0) {
      return NextResponse.json(
        { error: userCount > 0 ? 'Please log in with your email and password' : 'Authentication not configured' },
        { status: userCount > 0 ? 400 : 500 }
      );
    }

    const passwordsMatch = (() => {
      try {
        const a = Buffer.from(password);
        const b = Buffer.from(adminPassword);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
      } catch {
        return false;
      }
    })();
    if (!passwordsMatch) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    // Bootstrap: create admin user and workspace via ensureDefaultWorkspace
    const adminWorkspaceId = await ensureDefaultWorkspace('admin');

    const token = await createSession('admin', 'admin@localhost', true);
    const adminWorkspaceName = getWorkspaceById(adminWorkspaceId)?.name;
    const response = NextResponse.json({ success: true, defaultWorkspaceId: adminWorkspaceId, defaultWorkspaceName: adminWorkspaceName });
    setSessionOnResponse(response, token);
    return response;
  } catch (error) {
    logger.error('[API /api/auth/login] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Login failed' },
      { status: 500 }
    );
  }
}
