import { vfs } from '@/lib/vfs';
import { getSyncManager, type PushProgress } from '@/lib/vfs/sync-manager';
import { createSyncProgressToast, silentProgressToast } from '@/lib/vfs/sync-progress-toast';
import { logger } from '@/lib/utils';
import { translator } from '@/lib/i18n/runtime';

/**
 * Push a project to the server so it becomes deployable.
 *
 * In Server Mode a project only reaches the server (and the server-backed
 * deployment picker) when it is pushed. Newly imported or duplicated projects
 * live in IndexedDB only until then. Uses the same binary-safe push as the
 * Server Sync dialog. No-op in browser mode.
 */
export async function pushProjectToServer(
  projectId: string,
  workspaceId?: string,
  options?: { delta?: boolean; silent?: boolean }
): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;

  let project;
  try {
    project = await vfs.getProject(projectId);
  } catch (error) {
    logger.error('[pushProjectToServer] Failed to push project to server:', error);
    return;
  }
  if (!project) return;

  // A first upload is chunked into as many requests as the project needs, so a visible push
  // reports where it is. It stays invisible until the push turns out to need more than one
  // request. A background reconcile stays silent either way.
  const progress = options?.silent
    ? silentProgressToast
    : createSyncProgressToast(translator()('sync.syncingToServer', { name: project.name }));

  try {
    const files = await vfs.listFiles(projectId);
    const syncManager = getSyncManager(workspaceId);
    const onProgress = ({ batch, batches }: PushProgress) => progress.update(batch, batches);

    // Delta mode for routine reconciles: a full push sends every file, which is the right thing
    // for a first upload and far too much for a metadata change.
    const result = options?.delta
      ? await syncManager.pushProjectDelta(projectId, project, files, { onProgress })
      : await syncManager.pushSingleProject(projectId, project, files, { onProgress });

    const { persistAcknowledgedRevision } = await import('./auto-sync');
    const ack = result.project?.revision;

    if (!result.success) {
      if (typeof ack === 'number') {
        await persistAcknowledgedRevision(projectId, ack);
      }
      logger.error('[pushProjectToServer] Failed to push project to server:', result.error);
      const { markSyncNeedsRetry } = await import('./auto-sync');
      await markSyncNeedsRetry(projectId, project.name, {
        silent: options?.silent,
        reason: result.error === 'conflict' ? 'conflict' : 'error',
      });
      progress.dismiss();
      return;
    }

    await persistAcknowledgedRevision(projectId, ack, {
      lastSyncedAt: new Date(),
      serverUpdatedAt: result.project?.updatedAt
        ? new Date(result.project.updatedAt)
        : new Date(),
      syncStatus: 'synced',
    });
    // No success toast: every caller that shows this one announces the result itself, and a push
    // that needed no progress toast never raised one to resolve.
    progress.dismiss();
  } catch (error) {
    logger.error('[pushProjectToServer] Failed to push project to server:', error);
    try {
      const { markSyncNeedsRetry } = await import('./auto-sync');
      await markSyncNeedsRetry(projectId, project.name, { silent: options?.silent, reason: 'error' });
    } catch { /* already logged */ }
    progress.dismiss();
  }
}
