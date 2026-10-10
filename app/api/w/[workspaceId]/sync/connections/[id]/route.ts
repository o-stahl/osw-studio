/**
 * Workspace-Scoped Individual Connection Sync API Route
 *
 * POST: Push specific custom connection to server
 * DELETE: Delete custom connection from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import type { CustomConnection } from '@/lib/llm/providers/connection-record';
import { assertPublicHttpUrl } from '@/lib/llm/providers/url-safety';
import { logger } from '@/lib/utils';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);
    const { id } = await params;
    const body = await request.json();
    const { connection } = body as { connection: CustomConnection };

    if (!connection || connection.id !== id) {
      return NextResponse.json({ error: 'Invalid connection data or ID mismatch' }, { status: 400 });
    }

    // Build record explicitly — never spread the request object so no stray apiKey reaches the DB
    const rec: CustomConnection = {
      id: connection.id,
      name: connection.name,
      baseUrl: connection.baseUrl,
      format: 'openai',
      apiKeyRequired: !!connection.apiKeyRequired,
      updatedAt: new Date().toISOString(),
    };
    assertPublicHttpUrl(rec.baseUrl); // reject internal/loopback endpoints at write time

    const existing = await adapter.getConnection(id);
    if (existing) {
      await adapter.updateConnection(rec);
    } else {
      await adapter.createConnection(rec);
    }

    return NextResponse.json({
      success: true,
      connection: await adapter.getConnection(id),
      action: existing ? 'updated' : 'created',
    });
  } catch (error) {
    logger.error('[API .../sync/connections/[id] POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync connection' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    // A viewer may learn that something never reached the server (404, or success for a project),
    // so its local-only copy can still be deleted; deleting what is there needs editor.
    const context = await getWorkspaceContext(params, 'viewer');
    const { adapter } = context;
    const { id } = await params;

    const existing = await adapter.getConnection(id);

    if (!existing) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteConnection(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[API .../sync/connections/[id] DELETE] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete connection' },
      { status: 500 }
    );
  }
}
