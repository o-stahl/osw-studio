/**
 * Workspace-Scoped Per-Project Sync API
 *
 * POST - Push single project + files to server
 * GET - Pull single project + files from server
 * DELETE - Delete project from server
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceContext, requireWorkspaceRole } from '@/lib/api/workspace-context';
import { Project, VirtualFile } from '@/lib/vfs/types';
import { serializeFilesForResponse, deserializeFilesFromRequest } from '@/lib/vfs/sync-utils';
import { logger } from '@/lib/utils';
import { isSafeVirtualPath } from '@/lib/vfs/path-safety';
import { forgetWorkspaceStorage } from '@/lib/api/storage-quota';

interface PushRequestBody {
  project: Project;
  files: (VirtualFile & { _isBinaryBase64?: boolean })[];
  deletedPaths?: string[];
  partial?: boolean;
  /**
   * Write the project row. Default true; a chunked push sends `false` on every batch but the last.
   *
   * The row is stored with the *client's* `updatedAt` rather than the server's clock, so a batch
   * that writes it moves `existingProject.updatedAt` up to a value the client's own
   * `lastSyncedAt` predates — and the next batch of the same push then fails the concurrency
   * check below against itself. Holding the write until the final batch keeps the check comparing
   * the same server state throughout, so it still catches a real concurrent change instead of
   * being forced past. It also means a push that dies half way leaves the project looking
   * un-synced, which is what makes a delta retry resend the remainder.
   *
   * A project the server does not have yet is created regardless: files carry a foreign key to it.
   */
  writeProject?: boolean;
  /** Revision this client last observed. Stale or missing-after-upgrade is 409. */
  baseRevision?: number;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; id: string }> }
) {
  try {
    const { adapter } = await getWorkspaceContext(params);
    const { id } = await params;
    const body: PushRequestBody = await request.json();
    const {
      project,
      files,
      deletedPaths = [],
      partial = false,
      writeProject = true,
      baseRevision,
    } = body;

    if (!project || project.id !== id || !Array.isArray(files) || !Array.isArray(deletedPaths)) {
      return NextResponse.json(
        { error: 'Invalid project data' },
        { status: 400 }
      );
    }

    // Checked before anything is written, for the reason given in the files route: a path with a
    // `..` segment becomes a filesystem path at publish time.
    const unsafe = (Array.isArray(files) ? files : []).find((file) => !isSafeVirtualPath(file?.path));
    if (unsafe) {
      logger.warn(`[API sync/projects] Rejected push with unsafe path: ${String(unsafe?.path).slice(0, 120)}`);
      return NextResponse.json(
        { error: 'Invalid request: file paths must be absolute and contain no "." or ".." segments' },
        { status: 400 }
      );
    }

    const now = new Date();
    const syncedProject: Project = {
      ...project,
      lastSyncedAt: now,
      serverUpdatedAt: project.updatedAt,
      syncStatus: 'synced',
    };
    const incomingFiles = deserializeFilesFromRequest(files);
    const base = typeof baseRevision === 'number' ? baseRevision : 0;

    let storedProject: Project;
    try {
      storedProject = adapter.runTransaction(() => {
        const existingProject = adapter.getProjectSync(id);
        const currentRev = existingProject?.revision ?? 0;
        if (existingProject && base !== currentRev) {
          const err = new Error('stale-revision') as Error & { revision: number; serverUpdatedAt: Date };
          err.revision = currentRev;
          err.serverUpdatedAt = existingProject.updatedAt;
          throw err;
        }

        let stored: Project;
        if (existingProject) {
          if (writeProject) {
            void adapter.updateProject(syncedProject);
            stored = { ...syncedProject, revision: currentRev };
          } else {
            stored = existingProject;
          }
        } else {
          const created = writeProject ? syncedProject : { ...syncedProject, updatedAt: new Date(0) };
          void adapter.createProject(created);
          stored = { ...created, revision: 0 };
        }

        if (partial) {
          for (const filePath of deletedPaths) {
            void adapter.deleteFile(id, filePath);
          }
          for (const file of incomingFiles) {
            const fileData = { ...file, projectId: id };
            if (adapter.getFileSync(id, fileData.path)) void adapter.updateFile(fileData);
            else void adapter.createFile(fileData);
          }
        } else {
          for (const file of adapter.listFilesSync(id)) {
            void adapter.deleteFile(id, file.path);
          }
          for (const file of incomingFiles) {
            void adapter.createFile({ ...file, projectId: id });
          }
        }

        const next = adapter.bumpRevision(id, stored.revision ?? 0);
        if (next == null) {
          const err = new Error('stale-revision') as Error & { revision: number; serverUpdatedAt: Date };
          err.revision = stored.revision ?? 0;
          err.serverUpdatedAt = stored.updatedAt;
          throw err;
        }
        stored.revision = next;
        return stored;
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

    logger.debug(`[API /api/w/[workspaceId]/sync/projects/${id}] Project synced successfully`);

    return NextResponse.json({
      success: true,
      // What the server now holds. On a batch that did not write the row this is the existing
      // record, so a client cannot read its own unwritten metadata back as though it had landed.
      project: storedProject,
      revision: storedProject.revision,
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
  request: NextRequest,
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

    if (request.nextUrl.searchParams.get('manifest') === '1') {
      return NextResponse.json({
        success: true,
        project,
        files: files.map((file) => ({ path: file.path, updatedAt: file.updatedAt, size: file.size })),
      });
    }

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
    // A viewer may learn that something never reached the server (404, or success for a project),
    // so its local-only copy can still be deleted; deleting what is there needs editor.
    const context = await getWorkspaceContext(params, 'viewer');
    const { adapter } = context;
    const { workspaceId, id } = await params;

    const existing = await adapter.getProject(id);
    if (!existing) {
      return NextResponse.json({ success: true });
    }

    // A deployment builds from its project; deleting the project out from under it leaves the
    // deployment nothing to republish from. Point the deployment elsewhere, or delete it, first.
    const deployments = (await adapter.listDeployments?.()) ?? [];
    const usedBy = deployments.filter((d) => d.projectId === id).map((d) => d.name);
    if (usedBy.length > 0) {
      return NextResponse.json(
        { error: 'Project is used by a deployment', code: 'in_use', deployments: usedBy },
        { status: 409 }
      );
    }

    requireWorkspaceRole(context, 'editor');
    await adapter.deleteProject(id);
    forgetWorkspaceStorage(workspaceId);

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
