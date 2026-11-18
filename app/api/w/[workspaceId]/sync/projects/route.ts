/**
 * Workspace-Scoped Project Sync API Route
 *
 * GET: Pull projects from server
 * POST: Push project from browser to server (with quota enforcement)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/api/workspace-context';
import { Project } from '@/lib/vfs/types';
import { projectLimitRefusal } from '@/lib/api/project-quota';
import { logger } from '@/lib/utils';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);

    const projects = await adapter.listProjects();

    return NextResponse.json({ projects });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/projects GET] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch projects' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { adapter, workspaceId } = await getWorkspaceContext(params);

    const body = await request.json();
    const { project, baseRevision } = body as { project: Project; baseRevision?: number };

    if (!project || !project.id) {
      return NextResponse.json(
        { error: 'Invalid project data' },
        { status: 400 }
      );
    }

    // Check if project exists
    const existing = await adapter.getProject(project.id);

    if (!existing) {
      const refusal = await projectLimitRefusal(adapter, workspaceId);
      if (refusal) return NextResponse.json({ error: refusal }, { status: 403 });
    }

    const base = typeof baseRevision === 'number' ? baseRevision : 0;
    let stored = existing;
    try {
      stored = adapter.runTransaction(() => {
        const current = adapter.getProjectSync(project.id);
        const currentRev = current?.revision ?? 0;
        if (current && base !== currentRev) {
          const err = new Error('stale-revision') as Error & { revision: number; serverUpdatedAt: Date };
          err.revision = currentRev;
          err.serverUpdatedAt = current.updatedAt;
          throw err;
        }
        if (!current) {
          void adapter.createProject(project);
          const row = adapter.getProjectSync(project.id);
          if (!row) {
            throw new Error('Failed to create project');
          }
          return row;
        }
        if (base !== currentRev) {
          const err = new Error('stale-revision') as Error & { revision: number; serverUpdatedAt: Date };
          err.revision = currentRev;
          err.serverUpdatedAt = current.updatedAt;
          throw err;
        }
        void adapter.updateProject(project);
        const next = adapter.bumpRevision(project.id, currentRev);
        const row = adapter.getProjectSync(project.id);
        if (next == null || !row) {
          const err = new Error('stale-revision') as Error & { revision: number; serverUpdatedAt: Date };
          err.revision = currentRev;
          err.serverUpdatedAt = current.updatedAt;
          throw err;
        }
        row.revision = next;
        return row;
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'stale-revision') {
        const stale = error as Error & { revision: number; serverUpdatedAt: Date };
        return NextResponse.json(
          { error: 'conflict', reason: 'stale', revision: stale.revision, serverUpdatedAt: stale.serverUpdatedAt },
          { status: 409 }
        );
      }
      throw error;
    }

    return NextResponse.json({ success: true, project: stored, revision: stored?.revision });
  } catch (error) {
    logger.error('[API /api/w/[workspaceId]/sync/projects POST] Error:', error);

    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync project' },
      { status: 500 }
    );
  }
}
