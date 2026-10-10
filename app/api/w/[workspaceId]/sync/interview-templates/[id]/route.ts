/**
 * Workspace-Scoped Individual Interview Template Sync API Route
 *
 * GET: Pull specific interview template from server
 * POST: Push specific interview template to server
 * DELETE: Delete interview template from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import type { InterviewTemplate } from '@/lib/interview/types';
import { isBuiltInInterviewTemplateId } from '@/lib/interview/templates';
import { logger } from '@/lib/utils';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;

    const interviewTemplate = await adapter.getInterviewTemplate(id);

    if (!interviewTemplate) {
      return NextResponse.json({ error: 'Interview template not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, interviewTemplate });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/interview-templates/[id] GET] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch interview template' },
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
    const { interviewTemplate } = body as { interviewTemplate: InterviewTemplate };

    if (!interviewTemplate || interviewTemplate.id !== id) {
      return NextResponse.json({ error: 'Invalid interview template data or ID mismatch' }, { status: 400 });
    }

    if (isBuiltInInterviewTemplateId(interviewTemplate.id)) {
      return NextResponse.json({ error: 'Cannot sync built-in templates' }, { status: 400 });
    }

    const existing = await adapter.getInterviewTemplate(id);
    const record: InterviewTemplate = { ...interviewTemplate, updatedAt: new Date() };

    if (existing) {
      await adapter.updateInterviewTemplate(record);
    } else {
      await adapter.createInterviewTemplate(record);
    }

    const updated = await adapter.getInterviewTemplate(id);

    return NextResponse.json({
      success: true,
      interviewTemplate: updated,
      action: existing ? 'updated' : 'created',
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/interview-templates/[id] POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync interview template' },
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

    const existing = await adapter.getInterviewTemplate(id);

    if (!existing) {
      return NextResponse.json({ error: 'Interview template not found' }, { status: 404 });
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteInterviewTemplate(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/interview-templates/[id] DELETE] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete interview template' },
      { status: 500 }
    );
  }
}
