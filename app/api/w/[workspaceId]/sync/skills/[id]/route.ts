/**
 * Workspace-Scoped Individual Skill Sync API Route
 *
 * GET: Pull specific skill from server
 * POST: Push specific skill to server
 * DELETE: Delete skill from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import { Skill } from '@/lib/vfs/skills/types';
import { logger } from '@/lib/utils';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;

    const skill = await adapter.getSkill(id);

    if (!skill) {
      return NextResponse.json(
        { error: 'Skill not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      skill,
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/skills/[id] GET] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch skill' },
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
    const { skill } = body as { skill: Skill };

    if (!skill || skill.id !== id) {
      return NextResponse.json(
        { error: 'Invalid skill data or ID mismatch' },
        { status: 400 }
      );
    }

    if (skill.isBuiltIn) {
      return NextResponse.json(
        { error: 'Cannot sync built-in skills' },
        { status: 400 }
      );
    }

    const existing = await adapter.getSkill(id);
    const now = new Date();

    if (existing) {
      await adapter.updateSkill({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        markdown: skill.markdown,
        createdAt: skill.createdAt,
        updatedAt: now,
      });
    } else {
      await adapter.createSkill({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        content: skill.content,
        markdown: skill.markdown,
        createdAt: skill.createdAt,
        updatedAt: now,
      });
    }

    const updatedSkill = await adapter.getSkill(id);

    return NextResponse.json({
      success: true,
      skill: updatedSkill,
      action: existing ? 'updated' : 'created',
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/skills/[id] POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync skill' },
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

    const existing = await adapter.getSkill(id);

    if (!existing) {
      return NextResponse.json(
        { error: 'Skill not found' },
        { status: 404 }
      );
    }

    if (existing.isBuiltIn) {
      return NextResponse.json(
        { error: 'Cannot delete built-in skills' },
        { status: 400 }
      );
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteSkill(id);

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/skills/[id] DELETE] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete skill' },
      { status: 500 }
    );
  }
}
