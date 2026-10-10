/**
 * Workspace-Scoped Individual Model Template Sync API Route
 *
 * GET: Pull specific model template from server
 * POST: Push specific model template to server
 * DELETE: Delete model template from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import type { ModelTemplate } from '@/lib/llm/models/assignment';
import { logger } from '@/lib/utils';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;

    const modelTemplate = await adapter.getModelTemplate(id);

    if (!modelTemplate) {
      return NextResponse.json({ error: 'Model template not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, modelTemplate });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/model-templates/[id] GET] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch model template' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);
    const { id } = await params;
    const body = await request.json();
    const { modelTemplate } = body as { modelTemplate: ModelTemplate };

    if (!modelTemplate || modelTemplate.id !== id) {
      return NextResponse.json({ error: 'Invalid model template data or ID mismatch' }, { status: 400 });
    }

    if (modelTemplate.builtin) {
      return NextResponse.json({ error: 'Cannot sync built-in templates' }, { status: 400 });
    }

    const existing = await adapter.getModelTemplate(id);
    const record: ModelTemplate = {
      id: modelTemplate.id,
      name: modelTemplate.name,
      description: modelTemplate.description,
      assignment: modelTemplate.assignment,
      updatedAt: new Date(),
    };

    if (existing) {
      await adapter.updateModelTemplate(record);
    } else {
      await adapter.createModelTemplate(record);
    }

    const updated = await adapter.getModelTemplate(id);

    return NextResponse.json({
      success: true,
      modelTemplate: updated,
      action: existing ? 'updated' : 'created',
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/model-templates/[id] POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync model template' },
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

    const existing = await adapter.getModelTemplate(id);

    if (!existing) {
      return NextResponse.json({ error: 'Model template not found' }, { status: 404 });
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteModelTemplate(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/model-templates/[id] DELETE] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete model template' },
      { status: 500 }
    );
  }
}
