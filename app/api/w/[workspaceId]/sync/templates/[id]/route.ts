/**
 * Workspace-Scoped Individual Template Sync API Route
 *
 * GET: Pull specific template from server
 * POST: Push specific template to server
 * DELETE: Delete template from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import { CustomTemplate } from '@/lib/vfs/types';
import { logger } from '@/lib/utils';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;

    const template = await adapter.getCustomTemplate(id);

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      template,
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/templates/[id] GET] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch template' },
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
    /**
     * `appendFiles` adds this request's files to the stored template instead of replacing it.
     *
     * A template carries the whole file set of the project it was made from
     * (`lib/vfs/template-service.ts`), so one too large for a request body has to arrive as a
     * sequence of them. The first request stores the record and its first slice; the rest append.
     * Absent it defaults to false, so a caller sending the template in one request is unchanged.
     */
    const { template, appendFiles = false } = body as {
      template: CustomTemplate;
      appendFiles?: boolean;
    };

    if (!template || template.id !== id) {
      return NextResponse.json(
        { error: 'Invalid template data or ID mismatch' },
        { status: 400 }
      );
    }

    const existing = await adapter.getCustomTemplate(id);

    const templateToSave: CustomTemplate = {
      ...template,
      files: appendFiles && existing
        ? [...(existing.files ?? []), ...(template.files ?? [])]
        : template.files,
      updatedAt: new Date(),
    };

    await adapter.saveCustomTemplate(templateToSave);

    const updatedTemplate = await adapter.getCustomTemplate(id);

    return NextResponse.json({
      success: true,
      template: updatedTemplate,
      action: existing ? 'updated' : 'created',
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/templates/[id] POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync template' },
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

    const existing = await adapter.getCustomTemplate(id);

    if (!existing) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteCustomTemplate(id);

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/templates/[id] DELETE] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete template' },
      { status: 500 }
    );
  }
}
