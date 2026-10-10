/**
 * Logout API Route
 *
 * Clears session and workspace cookies
 */

import { NextResponse } from 'next/server';
import { clearSessionOnResponse } from '@/lib/auth/session';
import { logger } from '@/lib/utils';
import { clearWorkspaceOnResponse } from '@/lib/web/workspace-cookie';

export async function POST() {
  try {
    const response = NextResponse.json({ success: true });
    clearSessionOnResponse(response);
    clearWorkspaceOnResponse(response);
    return response;
  } catch (error) {
    logger.error('[API /api/auth/logout] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Logout failed' },
      { status: 500 }
    );
  }
}
