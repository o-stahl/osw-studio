/**
 * Auto-Sync Utility
 *
 * Handles automatic background synchronization of projects to server.
 * Provides sync status calculation and conflict detection.
 */

import { Project, VirtualFile } from './types';
import { calculateItemSyncStatus, toTime } from './sync-types';
import { batchFilesBySize, serializeFileContent, deserializeFileContent } from './sync-manager';
import { notifyServerProjectsChanged } from './sync-events';
import { vfs } from './index';
import { normalizeProjectSettings } from './project-settings';
import { saveManager } from './save-manager';
import { logger } from '@/lib/utils';
import { toast } from 'sonner';
import { apiFetch, getBackendStatus, subscribeBackendStatus } from '@/lib/api/backend-status';
import { track } from '@/lib/telemetry';
import { translator } from '@/lib/i18n/runtime';

// ── Workspace-scoped URL helpers ─────────────────────────────────────────────

let _autoSyncWorkspaceId: string | undefined;

/**
 * Set the workspace ID used by auto-sync functions for URL scoping.
 * When set, all `/api/sync/…` calls become `/api/w/{workspaceId}/sync/…`.
 * Call with `undefined` to revert to unscoped paths (browser/no-workspace mode).
 */
export function setAutoSyncWorkspaceId(workspaceId: string | undefined): void {
  _autoSyncWorkspaceId = workspaceId;
}

/**
 * Build an API URL scoped to the current workspace when one is configured.
 * @param path - must start with '/' (e.g. '/sync/status')
 */
export function getAutoSyncApiUrl(path: string): string {
  if (_autoSyncWorkspaceId) {
    return `/api/w/${_autoSyncWorkspaceId}${path}`;
  }
  return `/api${path}`;
}

// ── Sync status request dedup ───────────────────────────────────────────────
// Prevents duplicate /sync/status fetches when multiple callers (PageLayout
// quota check, autoPullAllProjects) request it within the same tick.

let _pendingSyncStatus: Promise<any | null> | null = null;
// Keyed by workspace: switching workspace within the TTL must not be served the previous
// workspace's project list, which would misreport every project's sync status.
let _cachedSyncData: { workspaceId: string | undefined; data: any; ts: number } | null = null;
// Bumped on every invalidation. A request that was already in flight carries data from before the
// change, so it captures the epoch at its start and declines to populate the cache if it no longer
// matches — otherwise it would quietly undo the invalidation and serve the stale snapshot for the
// rest of the TTL, which is precisely the window just after a push.
let _syncStatusEpoch = 0;
const SYNC_STATUS_CACHE_TTL = 5_000;

export async function fetchSyncStatus(): Promise<any | null> {
  const workspaceId = _autoSyncWorkspaceId;
  if (
    _cachedSyncData
    && _cachedSyncData.workspaceId === workspaceId
    && Date.now() - _cachedSyncData.ts < SYNC_STATUS_CACHE_TTL
  ) {
    return _cachedSyncData.data;
  }
  if (!_pendingSyncStatus) {
    const epoch = _syncStatusEpoch;
    _pendingSyncStatus = (async () => {
      try {
        const res = await apiFetch(getAutoSyncApiUrl('/sync/status'));
        if (!res.ok) return null;
        const data = await res.json();
        if (epoch === _syncStatusEpoch) {
          _cachedSyncData = { workspaceId, data, ts: Date.now() };
        }
        return data;
      } catch {
        return null;
      } finally {
        _pendingSyncStatus = null;
      }
    })();
  }
  return _pendingSyncStatus;
}

/**
 * Drop the cached server status.
 *
 * Must be called after anything that changes what the server holds, otherwise the next read is
 * served a snapshot taken before the change — which showed freshly pushed projects as "Local only"
 * and let a second reconcile inside the TTL re-upload a project that was already in sync.
 */
export function invalidateSyncStatusCache(): void {
  _cachedSyncData = null;
  _syncStatusEpoch++;
}

// ─────────────────────────────────────────────────────────────────────────────

export type SyncStatus = 'synced' | 'local-newer' | 'server-newer' | 'conflict' | 'never-synced' | 'local-only' | 'server-only';

interface SyncStatusResult {
  status: SyncStatus;
}

/**
 * Calculate sync status using three-way timestamp comparison.
 *
 * Delegates to calculateItemSyncStatus so projects, skills and templates cannot drift apart on
 * how drift is defined — there used to be two copies of this comparison and only one got fixed.
 */
/** Local content changed since the last acknowledged sync. Used to refuse destructive auto-pulls. */
export function localHasUnackedEdits(project: Project): boolean {
  const updated = project.updatedAt ? new Date(project.updatedAt).getTime() : 0;
  const synced = project.lastSyncedAt ? new Date(project.lastSyncedAt).getTime() : NaN;
  if (!Number.isFinite(synced)) return true;
  return updated > synced;
}

export function calculateSyncStatus(
  localProject: Project,
  serverUpdatedAt?: Date
): SyncStatusResult {
  const status = calculateItemSyncStatus(
    localProject.updatedAt,
    serverUpdatedAt ?? null,
    localProject.lastSyncedAt ?? null
  ) as SyncStatus;

  return { status };
}

const syncRetries = new Map<string, number>();
const MAX_RETRIES = 3;

/**
 * Work out which files actually need sending.
 *
 * A 404 means the server has never seen this project, so everything goes and there is nothing to
 * delete. Returns null when the manifest cannot be read at all: without it there is no way to know
 * what the server holds that this project does not, and the alternative — the route's
 * `partial: false` delete-and-recreate — cannot be split across requests, since each batch would
 * delete what the batch before it wrote. The caller treats null as a failed sync and retries.
 */
async function buildFileDelta(
  projectId: string,
  files: VirtualFile[]
): Promise<{ files: VirtualFile[]; deletedPaths: string[] } | 'unauthorized' | null> {
  try {
    const response = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}?manifest=1`));
    if (response.status === 404) return { files, deletedPaths: [] };
    if (response.status === 401) return 'unauthorized';
    if (!response.ok) return null;

    const manifest = await response.json() as {
      files?: Array<{ path: string; updatedAt: string; size?: number }>;
    };
    if (!Array.isArray(manifest.files)) return null;

    const serverFiles = new Map(manifest.files.map((file) => [file.path, file]));
    const changed = files.filter((file) => {
      const serverFile = serverFiles.get(file.path);
      if (!serverFile) return true;
      return new Date(serverFile.updatedAt).getTime() !== new Date(file.updatedAt).getTime()
        || (serverFile.size ?? 0) !== (file.size ?? 0);
    });
    const localPaths = new Set(files.map((file) => file.path));
    const deletedPaths = manifest.files
      .filter((file) => !localPaths.has(file.path))
      .map((file) => file.path);

    return { files: changed, deletedPaths };
  } catch {
    return null;
  }
}

/**
 * POST the push as a sequence of batches, and hand back the response the caller should act on:
 * the first that failed, or the last one when they all succeeded.
 *
 * Next truncates a request body past `experimental.proxyClientMaxBodySize` rather than rejecting
 * it, so a project that outgrew the limit arrived cut mid-string and the route's `request.json()`
 * threw — reported here as a 500, which also marks the whole backend as down. Same protocol as
 * `SyncManager.pushBatches`: `partial: true` throughout, only the last batch writes the project
 * row, and deletions ride with it so an interrupted run is strictly additive.
 */
async function postProjectBatches(
  projectId: string,
  project: Project,
  files: VirtualFile[],
  deletedPaths: string[]
): Promise<Response> {
  const { batches, oversized } = batchFilesBySize(files.map(serializeFileContent));
  if (oversized.length > 0) {
    throw new Error(`Too large to sync: ${oversized.join(', ')}`); // i18n-ignore: logged, never shown
  }

  let baseRevision = project.revision ?? 0;
  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;
    // Binary content MUST go through serializeFileContent (done above): JSON.stringify turns an
    // ArrayBuffer into {}, and the route rebuilds the server's copy from this payload, so sending
    // raw files silently replaced every image and font with an empty object.
    const response = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        project,
        files: batches[i],
        deletedPaths: isLast ? deletedPaths : [],
        partial: true,
        writeProject: isLast,
        baseRevision,
      }),
    });

    if (!response.ok || isLast) return response;
    const data = await response.json();
    if (typeof data.project?.revision === 'number') baseRevision = data.project.revision;
  }

  // batchFilesBySize always returns at least one batch, so the loop always returns.
  throw new Error('[AutoSync] nothing to send');
}

/**
 * Auto-sync a project to the server (non-blocking, silent by default)
 */
/**
 * Pushes in flight, one entry per project.
 *
 * Two pushes for one project must not overlap: the second would read the project before the first
 * has written back the `lastSyncedAt` the server gave it, pushing a stamp older than the row the
 * first just created, which the server answers with a 409 the user reads as "edited on another
 * device". In memory rather than persisted, so a tab that dies mid-push leaves nothing unsyncable.
 */
const pushesInFlight = new Map<string, Promise<void>>();

export async function autoSyncProject(projectId: string, silent = true): Promise<void> {
  const inFlight = pushesInFlight.get(projectId);
  if (inFlight) await inFlight.catch(() => { /* its own caller reported it */ });

  const push = pushProject(projectId, silent);
  pushesInFlight.set(projectId, push);
  try {
    await push;
  } finally {
    if (pushesInFlight.get(projectId) === push) pushesInFlight.delete(projectId);
  }
}

/** Merge onto a fresh row so a concurrent edit cannot wipe the ack. */
export async function persistAcknowledgedRevision(
  projectId: string,
  revision: number | undefined,
  extra?: { lastSyncedAt?: Date; serverUpdatedAt?: Date; syncStatus?: Project['syncStatus'] },
): Promise<void> {
  const latest = await vfs.getProject(projectId);
  if (typeof revision === 'number') latest.revision = revision;
  if (extra?.lastSyncedAt) latest.lastSyncedAt = extra.lastSyncedAt;
  if (extra?.serverUpdatedAt) latest.serverUpdatedAt = extra.serverUpdatedAt;
  if (extra?.syncStatus) latest.syncStatus = extra.syncStatus;
  await vfs.updateProject(latest, { preserveUpdatedAt: true });
}

export async function markSyncNeedsRetry(
  projectId: string,
  name: string,
  options?: { silent?: boolean; reason?: 'conflict' | 'error' },
): Promise<void> {
  const latest = await vfs.getProject(projectId);
  latest.syncStatus = 'error';
  await vfs.updateProject(latest, { preserveUpdatedAt: true });
  saveManager.markDirty(projectId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('osw-sync-needs-retry', { detail: { projectId } }));
  }
  if (!options?.silent) {
    const message = options?.reason === 'conflict'
      ? translator()('sync.conflictKept', { name })
      : translator()('sync.failedKept', { name });
    toast.warning(message, { duration: Infinity });
  }
  syncRetries.delete(projectId);
}

async function pushProject(projectId: string, silent: boolean): Promise<void> {
  // Only sync in Server Mode
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return;
  }

  try {
    const project = await vfs.getProject(projectId);
    if (!project) {
      logger.error(`[AutoSync] Project ${projectId} not found`);
      return;
    }


    // Get all files
    const files = await vfs.listFiles(projectId);

    // Ask the server what it already has, so an unchanged file is not re-uploaded and, more
    // importantly, so the push does not have to be a full delete-and-recreate of every file.
    const delta = await buildFileDelta(projectId, files);
    if (!delta) {
      throw new Error('Sync failed: could not read the server manifest');
    }

    // An expired session: the banner is up, and the load after signing in pushes what is left.
    const response = delta === 'unauthorized'
      ? 'unauthorized'
      : await postProjectBatches(projectId, project, delta.files, delta.deletedPaths);

    if (response === 'unauthorized' || response.status === 401) {
      syncRetries.delete(projectId);
      logger.warn(`[AutoSync] Skipping ${projectId}: session expired`);
      return;
    }

    if (response.status === 409) {
      // Do not retry. A one-commit second writer is also local+1; retrying with a fresh
      // manifest treats their files as deletedPaths and removes them. Lost acks are
      // handled by persistAcknowledgedRevision on success.
      await markSyncNeedsRetry(projectId, project.name, { silent, reason: 'conflict' });
      return;
    }

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status}`); // i18n-ignore: logged, never shown
    }

    const data = await response.json();
    const syncedProject = data.project;
    const revision = typeof syncedProject?.revision === 'number'
      ? syncedProject.revision
      : typeof data.revision === 'number' ? data.revision : undefined;
    await persistAcknowledgedRevision(projectId, revision, {
      lastSyncedAt: syncedProject?.lastSyncedAt ? new Date(syncedProject.lastSyncedAt) : new Date(),
      serverUpdatedAt: syncedProject?.serverUpdatedAt ? new Date(syncedProject.serverUpdatedAt) : new Date(),
      syncStatus: 'synced',
    });

    syncRetries.delete(projectId);
    invalidateSyncStatusCache();
    logger.debug(`[AutoSync] Project ${projectId} synced successfully`);

    if (!silent) {
      toast.success(translator()('sync.projectSynced'), {
        duration: 2000,
        position: 'bottom-right'
      });
    }
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync project ${projectId}:`, error);
    track('sync_fail', { item_type: 'project', direction: 'push' });

    const retries = syncRetries.get(projectId) ?? 0;
    if (retries < MAX_RETRIES) {
      syncRetries.set(projectId, retries + 1);
      logger.warn(`[AutoSync] Will retry ${projectId} (${retries + 1}/${MAX_RETRIES})`);
      setTimeout(() => autoSyncProject(projectId), (retries + 1) * 5000);
    } else {
      try {
        const failed = await vfs.getProject(projectId);
        if (failed) await markSyncNeedsRetry(projectId, failed.name, { silent, reason: 'error' });
      } catch (updateError) {
        logger.error(`[AutoSync] Failed to update project status:`, updateError);
      }
    }
  }
}

/**
 * Check if server has updates for a project
 */
export async function checkServerUpdates(projectId: string): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return false;
  }

  try {
    const localProject = await vfs.getProject(projectId);
    if (!localProject) {
      return false;
    }

    // Use lightweight status endpoint instead of fetching full project + files
    const response = await apiFetch(getAutoSyncApiUrl('/sync/status'));
    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const serverStatus = (data.projects || []).find((p: { id: string }) => p.id === projectId);
    if (!serverStatus) {
      return false;
    }

    const serverUpdatedAt = new Date(serverStatus.updatedAt);
    const status = calculateSyncStatus(localProject, serverUpdatedAt);
    // Conflict is visible, not a pull. Pulling would overwrite a local draft (and then a later
    // push can delete server-only files the tab never saw).
    return status.status === 'server-newer';
  } catch (error) {
    logger.error(`[AutoSync] Failed to check server updates for ${projectId}:`, error);
    return false;
  }
}

/**
 * Pull a project down from the server, creating it locally if it is not there yet.
 *
 * Handles both cases deliberately: auto-pull used to carry a separate copy of this for projects
 * that only existed on the server, and the two drifted — a fix applied here did not reach the
 * other, which is how a premature commit survived in one of them.
 */
export async function pullServerUpdates(projectId: string, showToast = true): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return false;
  }

  let createdLocally = false;
  try {
    const response = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}`));
    if (!response.ok) {
      throw new Error(`Failed to pull updates: ${response.status}`); // i18n-ignore: logged, never shown
    }

    const data = await response.json();
    const serverProject: Project = data.project;
    const serverFiles = data.files;
    // Captured before any write: vfs.updateProject mutates the object it is handed, so reading
    // serverProject.updatedAt afterwards yields the local clock, not the server's timestamp.
    const serverUpdatedAt = toTime(serverProject.updatedAt);

    try {
      const existingLocal = await vfs.getProject(projectId);
      if (existingLocal && localHasUnackedEdits(existingLocal)) {
        await markSyncNeedsRetry(projectId, existingLocal.name, { reason: 'conflict' });
        return false;
      }
    } catch {
      // No local project yet — fall through and create from the server copy.
    }

    // The project may not exist locally at all. Create the shell first so files have somewhere to
    // go; if anything below fails it is rolled back, because a shell with no files reads as local
    // work and the reconcile would push it over the server's real copy.
    let existsLocally = true;
    try {
      await vfs.getProject(projectId);
    } catch {
      existsLocally = false;
    }
    if (!existsLocally) {
      await vfs.createProject(serverProject.name, serverProject.description || '', projectId);
      createdLocally = true;
    }

    // Save local state as checkpoint before overwriting (safety net)
    const localFiles = await vfs.listFiles(projectId);
    if (localFiles.length > 0) {
      try {
        const { checkpointManager } = await import('./checkpoint');
        await checkpointManager.createCheckpoint(projectId, 'Pre-sync backup (before pull)', { kind: 'auto', label: { key: 'preSyncPull' } });
      } catch (cpErr) {
        logger.warn(`[AutoSync] Failed to create pre-pull checkpoint for ${projectId}:`, cpErr);
      }
    }

    // Suppress dirty marking during pull — these are server state, not user edits
    await saveManager.runWithSuppressedDirty(projectId, async () => {
      // The project record is written LAST, after the files have actually landed — see the end of
      // this block. Committing the server's metadata first meant an interrupted pull left a record
      // claiming to be up to date over a half-written file set: the pull would not be retried,
      // because nothing looked out of date any more.

      // Sync files: update existing, create new, delete removed
      const existingFiles = await vfs.listFiles(projectId);
      const existingPaths = new Set(existingFiles.map(f => f.path));
      const serverPaths = new Set(serverFiles.map((f: any) => f.path));

      // Binary content arrives base64-encoded; writing the string through as-is would replace
      // every image and font in the project with a text file.
      for (const raw of serverFiles) {
        const file = deserializeFileContent(raw);
        if (existingPaths.has(file.path)) {
          await vfs.updateFile(projectId, file.path, file.content || '');
        } else {
          await vfs.createFile(projectId, file.path, file.content || '');
        }
      }

      // An empty server tree is not permission to delete the working copy. That used to be
      // papered over by restore-on-open putting the last checkpoint back; without it, a
      // server-newer pull of zero files emptied the project and the next publish built nothing.
      if (serverFiles.length > 0 || existingFiles.length === 0) {
        for (const existing of existingFiles) {
          if (!serverPaths.has(existing.path)) {
            await vfs.deleteFile(projectId, existing.path);
          }
        }
      }

      // Commit the project record now that the files are in place: the server's fields, plus the
      // sync metadata. updatedAt takes the server's own timestamp rather than "now" — a pull
      // produces no local change, and a locally-stamped updatedAt reads as local-newer against the
      // copy it was just pulled from.
      const localProject = await vfs.getProject(projectId);
      if (localProject) {
        localProject.name = serverProject.name;
        localProject.description = serverProject.description;
        // Normalized: this is a value straight out of a JSON response, which is where settings
        // stored as a string came from in the first place (see lib/vfs/project-settings.ts).
        if (serverProject.settings) localProject.settings = normalizeProjectSettings(serverProject.settings);
        if (serverUpdatedAt !== null) localProject.updatedAt = new Date(serverUpdatedAt);
        localProject.lastSyncedAt = new Date();
        localProject.serverUpdatedAt = serverUpdatedAt !== null ? new Date(serverUpdatedAt) : new Date();
        localProject.syncStatus = 'synced';
        if (typeof serverProject.revision === 'number') {
          localProject.revision = serverProject.revision;
        }
        await vfs.updateProject(localProject, { preserveUpdatedAt: true });
      }
    });

    logger.debug(`[AutoSync] Pulled updates for project ${projectId}`);
    if (showToast) {
      toast.success(translator()('sync.updatedFromServer'));
    }

    return true;
  } catch (error) {
    logger.error(`[AutoSync] Failed to pull updates for ${projectId}:`, error);
    track('sync_fail', { item_type: 'project', direction: 'pull' });
    if (createdLocally) {
      // Roll back the shell so a retry starts clean and nothing half-created is left to sync.
      try { await vfs.deleteProject(projectId); } catch { /* best effort */ }
    }
    if (showToast) {
      toast.error(translator()('sync.pullFailed'));
    }
    return false;
  }
}


const AUTO_PULL_SESSION_KEY = 'osw_auto_pull_done';

function markAutoPullDone(): void {
  // A pull that ran into an expired session has to run again after signing in.
  if (getBackendStatus().authExpired) return;
  try { sessionStorage.setItem(AUTO_PULL_SESSION_KEY, '1'); } catch { /* sessionStorage unavailable */ }
}

// While signed out, the server refuses and pulls fail, so the once-per-tab pull has to run again
// after the next sign-in, which usually reloads this same tab.
if (typeof window !== 'undefined') {
  subscribeBackendStatus((status) => {
    if (!status.authExpired) return;
    try { sessionStorage.removeItem(AUTO_PULL_SESSION_KEY); } catch { /* sessionStorage unavailable */ }
  });
}

/**
 * Auto-pull projects from server on first load of a browser tab.
 * Compares local `serverUpdatedAt` against server timestamps — only pulls
 * projects that actually diverged or don't exist locally.
 * Runs once per tab (tracked via sessionStorage). Pass force=true to bypass.
 */
export async function autoPullAllProjects(onProgress?: (current: number, total: number) => void, options?: { force?: boolean }): Promise<{
  pulled: number;
  skipped: number;
  conflicts: string[];
  errors: number;
}> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return { pulled: 0, skipped: 0, conflicts: [], errors: 0 };
  }

  if (!options?.force) {
    try {
      if (sessionStorage.getItem(AUTO_PULL_SESSION_KEY)) {
        return { pulled: 0, skipped: 0, conflicts: [], errors: 0 };
      }
    } catch { /* sessionStorage unavailable — proceed */ }
  }

  let pulled = 0;
  let skipped = 0;
  const conflicts: string[] = [];
  let errors = 0;

  try {
    // Lightweight check — just project IDs + timestamps from server (deduped)
    const data = await fetchSyncStatus();
    if (!data) {
      logger.debug('[AutoSync] Server not available for pull');
      return { pulled: 0, skipped: 0, conflicts: [], errors: 0 };
    }

    const serverStatuses: { id: string; updatedAt: string }[] = data.projects || [];

    // Build local lookup: projectId → serverUpdatedAt (already cached from last sync)
    await vfs.init();
    const localProjects = await vfs.listProjects();
    const localMap = new Map(localProjects.map(p => [p.id, p]));

    // Filter to only projects that need attention
    const needsPull: { id: string }[] = [];
    for (const serverStatus of serverStatuses) {
      const serverUpdatedAt = new Date(serverStatus.updatedAt);
      const local = localMap.get(serverStatus.id);

      if (!local) {
        needsPull.push({ id: serverStatus.id });
        continue;
      }

      if (typeof local.revision !== 'number') {
        try {
          const res = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${serverStatus.id}`));
          if (res.ok) {
            const body = await res.json();
            const rev = body.project?.revision ?? body.revision;
            if (typeof rev === 'number') {
              await persistAcknowledgedRevision(local.id, rev);
            }
          }
        } catch { /* best effort */ }
      }
      const syncStatus = calculateSyncStatus(local, serverUpdatedAt);
      if (syncStatus.status === 'server-newer') {
        needsPull.push({ id: serverStatus.id });
      } else if (syncStatus.status === 'conflict') {
        conflicts.push(serverStatus.id);
      } else {
        skipped++;
      }
    }

    if (needsPull.length === 0 && conflicts.length === 0) {
      logger.debug(`[AutoSync] All ${skipped} projects up to date`);
      markAutoPullDone();
      return { pulled: 0, skipped, conflicts, errors: 0 };
    }

    const total = needsPull.length;
    let processed = 0;
    const CONCURRENCY = 4;

    async function pullOne(item: typeof needsPull[number]) {
      try {
        // One path for both cases — pullServerUpdates creates the project when it is only on the
        // server. This used to be a second, subtly different copy of the same pull.
        if (await pullServerUpdates(item.id, false)) pulled++;
        else errors++;
      } catch (error) {
        logger.error(`[AutoSync] Failed to process project ${item.id}:`, error);
        track('sync_fail', { item_type: 'project', direction: 'pull' });
        errors++;
      } finally {
        processed++;
        onProgress?.(processed, total);
      }
    }

    // Pull up to CONCURRENCY projects in parallel
    for (let i = 0; i < needsPull.length; i += CONCURRENCY) {
      const batch = needsPull.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(pullOne));
    }

    if (pulled > 0) {
      logger.debug(`[AutoSync] Auto-pull complete: ${pulled} updated, ${skipped} skipped, ${errors} errors`);
    }

    markAutoPullDone();
    return { pulled, skipped, conflicts, errors };
  } catch (error) {
    logger.error('[AutoSync] Failed to auto-pull projects:', error);
    return { pulled, skipped, conflicts, errors };
  }
}

/**
 * Push every project whose local copy is ahead of the server up to the server. This is the
 * load-time counterpart to autoPullAllProjects (which only reconciles server→local).
 *
 * Two kinds of drift are repaired:
 *  - 'local-only': never reached the server at all — a .osws restore (raw IndexedDB writes) or a
 *    .json import whose push threw. Pushed in full.
 *  - 'local-newer': pushed once, then changed locally by a write that does not itself sync
 *    (renaming a project, recording a checkpoint id, capturing a thumbnail). Pushed as a delta,
 *    so an unchanged file set costs one manifest request and no re-upload.
 *
 * The earlier version only handled the first case, which is why an imported project that was
 * pushed and then edited stayed stuck on "Local newer" through every subsequent load.
 *
 * Deliberately skipped:
 *  - 'conflict' — both sides moved; only the user can choose, in Server Sync.
 *  - projects with unsaved local edits — pushing a half-finished state behind the user's back is
 *    worse than showing drift.
 *
 * Deliberately NOT gated by AUTO_PULL_SESSION_KEY: a .osws restore triggers a same-session reload,
 * so a session-once guard would skip the very reconcile the import needs. No-op in browser mode.
 */
export async function reconcileProjectsToServer(
  workspaceId?: string
): Promise<{ pushed: number; skipped: number; errors: number }> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return { pushed: 0, skipped: 0, errors: 0 };
  let pushed = 0;
  let skipped = 0;
  let errors = 0;
  try {
    await vfs.init();
    const localProjects = await vfs.listProjects();
    if (localProjects.length === 0) return { pushed: 0, skipped: 0, errors: 0 };

    // fetchSyncStatus returns null for any failure — an expired session, a 5xx, an unreachable
    // backend. Treating that as "the server has no projects" would mark every project local-only
    // and re-upload all of them, so a failure means do nothing at all (same guard as the pull).
    const status = await fetchSyncStatus();
    if (!status) {
      logger.debug('[AutoSync] Server status unavailable, skipping reconcile');
      return { pushed: 0, skipped, errors: 0 };
    }
    const serverUpdatedAt = new Map<string, string>(
      (status.projects ?? []).map((p: { id: string; updatedAt: string }) => [p.id, p.updatedAt])
    );

    const drifted = localProjects.filter((project) => {
      const onServer = serverUpdatedAt.get(project.id) ?? null;

      // Contradictory evidence: the local record says this project was pushed, yet the server's
      // list does not contain it. Either the list is not the one this project belongs to (a stale
      // workspace-scoped VFS after switching workspaces) or it was deleted server-side on purpose.
      // Neither is a reason to re-upload it, and treating it as never-pushed would do exactly that.
      if (!onServer && (project.serverUpdatedAt || project.lastSyncedAt)) {
        skipped++;
        return false;
      }

      const state = calculateItemSyncStatus(
        project.updatedAt,
        onServer,
        project.lastSyncedAt ?? null
      );
      if (state !== 'local-only' && state !== 'local-newer') return false;
      if (saveManager.isDirty(project.id)) {
        skipped++;
        return false;
      }
      return true;
    });
    if (drifted.length === 0) return { pushed: 0, skipped, errors: 0 };

    const { pushProjectToServer } = await import('./push-project-to-server');
    for (const project of drifted) {
      try {
        // Delta whenever the server already has the project. The full push deletes and recreates
        // every server file, so it is reserved for a project the server has genuinely never seen —
        // which the filter above has now established.
        const known = serverUpdatedAt.has(project.id);
        await pushProjectToServer(project.id, workspaceId, { delta: known, silent: true });
        // pushProjectToServer stamps lastSyncedAt on success; re-read to confirm it landed.
        const updated = await vfs.getProject(project.id);
        const settled =
          updated &&
          calculateItemSyncStatus(
            updated.updatedAt,
            updated.serverUpdatedAt ?? null,
            updated.lastSyncedAt ?? null
          ) === 'synced';
        if (settled) pushed++;
        else errors++;
      } catch (error) {
        logger.error(`[AutoSync] Failed to reconcile project ${project.id}:`, error);
        errors++;
      }
    }
    if (pushed > 0) logger.debug(`[AutoSync] Reconciled ${pushed} project(s) to server`);
    if (pushed > 0) invalidateSyncStatusCache();
    if (pushed > 0 || errors > 0) notifyServerProjectsChanged();
    return { pushed, skipped, errors };
  } catch (error) {
    logger.error('[AutoSync] Failed to reconcile projects:', error);
    return { pushed, skipped, errors };
  }
}

type ServerDeleteReason = 'auth' | 'forbidden' | 'failed';

/** The server did not delete the item. Its message is ready to show; nothing was deleted. */
export class ServerDeleteRefused extends Error {
  constructor(public readonly reason: ServerDeleteReason) {
    super(translator()(`sync.deleteRefused.${reason}`));
    this.name = 'ServerDeleteRefused';
  }
}

/**
 * DELETE a synced item on the server, before the caller touches the local copy. A 404 counts as
 * deleted: the item never reached the server. No-op in browser mode.
 */
async function deleteOnServer(path: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  // Sync routes are workspace-scoped; without a workspace the DELETE would answer 404, read as
  // already gone, and the local copy would go while the server's stayed.
  if (!_autoSyncWorkspaceId) throw new ServerDeleteRefused('failed');
  let res: Response;
  try {
    res = await apiFetch(getAutoSyncApiUrl(path), { method: 'DELETE' });
  } catch (error) {
    logger.error(`[AutoSync] DELETE ${path} failed:`, error);
    throw new ServerDeleteRefused('failed');
  }
  if (res.ok || res.status === 404) return;
  logger.error(`[AutoSync] DELETE ${path} refused: ${res.status}`);
  throw new ServerDeleteRefused(res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : 'failed');
}

/**
 * Delete a project from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteProject(projectId: string): Promise<void> {
  await deleteOnServer(`/sync/projects/${encodeURIComponent(projectId)}`);
}

/** Delete a project on the server, then locally. A refused server delete keeps both copies. */
export async function deleteProjectServerFirst(projectId: string): Promise<void> {
  await autoDeleteProject(projectId);
  await vfs.deleteProject(projectId);
}

/**
 * Auto-sync a skill to the server (non-blocking)
 */
export async function autoSyncSkill(skill: import('./skills/types').Skill): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  if (skill.isBuiltIn) return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const syncManager = getSyncManager();
    const pushed = await syncManager.pushSkill(skill);
    if (!pushed.success) throw new Error(pushed.error || 'push refused'); // i18n-ignore: logged, never shown
    logger.debug(`[AutoSync] Skill ${skill.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync skill ${skill.id}:`, error);
    track('sync_fail', { item_type: 'skill', direction: 'push' });
  }
}

/**
 * Delete a skill from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteSkill(skillId: string): Promise<void> {
  await deleteOnServer(`/sync/skills/${encodeURIComponent(skillId)}`);
}

/**
 * Auto-sync a template to the server (non-blocking)
 */
export async function autoSyncTemplate(template: import('./types').CustomTemplate): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const syncManager = getSyncManager();
    const pushed = await syncManager.pushTemplate(template);
    if (!pushed.success) throw new Error(pushed.error || 'push refused'); // i18n-ignore: logged, never shown
    logger.debug(`[AutoSync] Template ${template.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync template ${template.id}:`, error);
    track('sync_fail', { item_type: 'template', direction: 'push' });
  }
}

/**
 * Delete a template from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteTemplate(templateId: string): Promise<void> {
  await deleteOnServer(`/sync/templates/${encodeURIComponent(templateId)}`);
}

/**
 * Auto-sync a model template to the server (non-blocking)
 */
export async function autoSyncModelTemplate(template: import('@/lib/llm/models/assignment').ModelTemplate): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  if (template.builtin) return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const syncManager = getSyncManager();
    const pushed = await syncManager.pushModelTemplate(template);
    if (!pushed.success) throw new Error(pushed.error || 'push refused'); // i18n-ignore: logged, never shown
    logger.debug(`[AutoSync] Model template ${template.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync model template ${template.id}:`, error);
    track('sync_fail', { item_type: 'modelTemplate', direction: 'push' });
  }
}

/**
 * Delete a model template from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteModelTemplate(templateId: string): Promise<void> {
  await deleteOnServer(`/sync/model-templates/${encodeURIComponent(templateId)}`);
}

/**
 * Auto-sync a custom provider connection to the server (non-blocking, key-less)
 */
export async function autoSyncConnection(cfg: import('@/lib/llm/providers/types').ProviderConfig): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    const { toConnectionRecord } = await import('@/lib/llm/providers/connection-record');
    const { getSyncManager } = await import('./sync-manager');
    const pushed = await getSyncManager().pushConnection(toConnectionRecord(cfg));
    if (!pushed.success) throw new Error(pushed.error || 'push refused'); // i18n-ignore: logged, never shown
    logger.debug(`[AutoSync] Connection ${cfg.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync connection ${cfg.id}:`, error);
  }
}

/**
 * Pull custom provider connections from the server into the local cache (server mode only).
 * Keys are never pulled — only definitions. Uses the low-level cache writer so it does NOT
 * re-trigger auto-sync (which would cause a pull->push loop).
 */
export async function pullConnectionsIntoCache(): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const result = await getSyncManager().pullConnections();
    if (!result.success || !result.connections?.length) return;
    const { getCustomProviders, setCustomProviders } = await import('@/lib/llm/providers/custom-providers');
    const { fromConnectionRecord } = await import('@/lib/llm/providers/connection-record');
    const merged = { ...getCustomProviders() };
    for (const rec of result.connections) {
      merged[rec.id] = fromConnectionRecord(rec);
    }
    setCustomProviders(merged);
    logger.debug(`[AutoSync] Pulled ${result.connections.length} connection(s) into cache`);
  } catch (error) {
    logger.error('[AutoSync] Failed to pull connections into cache:', error);
  }
}

/**
 * Auto-sync a custom interview template to the server (non-blocking)
 */
export async function autoSyncInterviewTemplate(template: import('@/lib/interview/types').InterviewTemplate): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  if (template.isBuiltIn) return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const pushed = await getSyncManager().pushInterviewTemplate(template);
    if (!pushed.success) throw new Error(pushed.error || 'push refused'); // i18n-ignore: logged, never shown
    logger.debug(`[AutoSync] Interview template ${template.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync interview template ${template.id}:`, error);
    track('sync_fail', { item_type: 'interviewTemplate', direction: 'push' });
  }
}

/**
 * Delete an interview template from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteInterviewTemplate(templateId: string): Promise<void> {
  await deleteOnServer(`/sync/interview-templates/${encodeURIComponent(templateId)}`);
}

/**
 * Delete a custom provider connection from the server. Resolves once the server has it gone; throws
 * `ServerDeleteRefused` otherwise, so the caller keeps the local copy.
 */
export async function autoDeleteConnection(id: string): Promise<void> {
  await deleteOnServer(`/sync/connections/${encodeURIComponent(id)}`);
}
