/**
 * Registration API Route
 *
 * Creates a new user account in the system database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSession, setSessionOnResponse } from '@/lib/auth/session';
import { createUser, getUserByEmail, getUserCount, createWorkspace, setDefaultWorkspace } from '@/lib/auth/system-database';
import { hashPassword } from '@/lib/auth/passwords';
import { logger } from '@/lib/utils';
import { getSystemDatabase } from '@/lib/auth/system-database';

export async function POST(request: NextRequest) {
  try {
    const userCount = getUserCount();
    const isFirstUser = userCount === 0;
    const registrationMode = process.env.REGISTRATION_MODE || 'closed';

    // Allow registration if: open mode, OR no users exist yet (initial setup)
    if (registrationMode !== 'open' && !isFirstUser) {
      return NextResponse.json(
        { error: 'Registration is not available on this instance' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { email, password, displayName } = body;

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    }

    const existing = getUserByEmail(email);
    if (existing) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const userId = createUser(email, passwordHash, displayName);

    // First user becomes admin
    if (isFirstUser) {
      const db = getSystemDatabase();
      db.prepare("UPDATE users SET is_admin = 1, updated_at = datetime('now') WHERE id = ?").run(userId);
    }

    // Create default workspace
    const workspaceName = displayName ? `${displayName}'s Workspace` : 'My Workspace';
    const workspaceId = createWorkspace(workspaceName, userId);

    setDefaultWorkspace(userId, workspaceId);

    const token = await createSession(userId, email, isFirstUser);
    const response = NextResponse.json({ success: true, userId, defaultWorkspaceId: workspaceId, defaultWorkspaceName: workspaceName });
    setSessionOnResponse(response, token);
    return response;
  } catch (error) {
    logger.error('[API /api/auth/register] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Registration failed' },
      { status: 500 }
    );
  }
}
