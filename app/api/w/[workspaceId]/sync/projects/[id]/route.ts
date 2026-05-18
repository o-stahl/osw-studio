/**
 * Workspace-Scoped Per-Project Sync API
 *
 * POST - Push single project + files to server
 * GET - Pull single project + files from server
 * DELETE - Delete project from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/api/workspace-context';
import { Project, VirtualFile } from '@/lib/vfs/types';
import { serializeFilesForResponse } from '@/lib/vfs/sync-utils';
import { logger } from '@/lib/utils';

interface PushRequestBody {
  project: Project;
  files: (VirtualFile & { _isBinaryBase64?: boolean })[];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);
    const { id } = await params;
    const body: PushRequestBody = await request.json();
    const { project, files } = body;

    if (!project || project.id !== id) {
      return NextResponse.json(
        { error: 'Invalid project data' },
        { status: 400 }
      );
    }

    // Update sync tracking fields
    const now = new Date();
    const syncedProject: Project = {
      ...project,
      lastSyncedAt: now,
      serverUpdatedAt: project.updatedAt,
      syncStatus: 'synced'
    };

    // Check if project exists
    const existingProject = await adapter.getProject(id);

    if (existingProject) {
      // Optimistic concurrency: reject if server has newer changes than client last saw
      const clientLastSynced = project.lastSyncedAt ? new Date(project.lastSyncedAt).getTime() : 0;
      const serverUpdated = new Date(existingProject.updatedAt).getTime();
      if (clientLastSynced > 0 && serverUpdated > clientLastSynced) {
        return NextResponse.json(
          { error: 'conflict', serverUpdatedAt: existingProject.updatedAt },
          { status: 409 }
        );
      }
      await adapter.updateProject(syncedProject);
    } else {
      await adapter.createProject(syncedProject);
    }

    // Sync files - delete all existing files and recreate
    const existingFiles = await adapter.listFiles(id);
    for (const file of existingFiles) {
      await adapter.deleteFile(id, file.path);
    }

    for (const file of files) {
      const { _isBinaryBase64, ...fileData } = file;
      await adapter.createFile(fileData);
    }

    logger.debug(`[API /api/w/[workspaceId]/sync/projects/${id}] Project synced successfully`);

    return NextResponse.json({
      success: true,
      project: syncedProject,
      fileCount: files.length
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[API /api/w/[workspaceId]/sync/projects/[id] POST] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to push project' },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params, 'viewer');
    const { id } = await params;

    const project = await adapter.getProject(id);
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const files = await adapter.listFiles(id);

    logger.debug(`[API /api/w/[workspaceId]/sync/projects/${id}] Project pulled successfully`);

    return NextResponse.json({
      success: true,
      project,
      files: serializeFilesForResponse(files)
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[API /api/w/[workspaceId]/sync/projects/[id] GET] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to pull project' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);
    const { id } = await params;

    const existing = await adapter.getProject(id);
    if (!existing) {
      return NextResponse.json({ success: true });
    }

    await adapter.deleteProject(id);

    logger.debug(`[API /api/w/[workspaceId]/sync/projects/${id}] Project deleted from server`);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && (error.message === 'Workspace access denied' || error.message === 'Insufficient workspace permissions')) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    logger.error('[API /api/w/[workspaceId]/sync/projects/[id] DELETE] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete project from server' },
      { status: 500 }
    );
  }
}
