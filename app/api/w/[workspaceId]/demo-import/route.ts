/**
 * The signed-in user has dealt with the offer to bring projects over from the hosted demo: brought
 * some, or said no. On a hosted instance this tells the gateway, which then stops adding the offer
 * to its sign-in links (`components/demo-import`). Elsewhere there is no gateway and nothing to do.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/session';
import { verifyWorkspaceAccess } from '@/lib/auth/system-database';
import { enqueueEventOnce } from '@/lib/webhooks/outbox';
import { logger } from '@/lib/utils';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const session = await requireAuth();
    const { workspaceId } = await params;
    verifyWorkspaceAccess(session.userId, workspaceId, 'viewer');
    enqueueEventOnce('user.demo_import_handled', { userId: session.userId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[API /api/w/[workspaceId]/demo-import] Error:', error);
    return NextResponse.json({ error: 'Failed to record the demo import' }, { status: 500 });
  }
}
