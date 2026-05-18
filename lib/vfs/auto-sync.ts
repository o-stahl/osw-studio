/**
 * Auto-Sync Utility
 *
 * Handles automatic background synchronization of projects to server.
 * Provides sync status calculation and conflict detection.
 */

import { Project } from './types';
import { vfs } from './index';
import { saveManager } from './save-manager';
import { logger } from '@/lib/utils';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api/backend-status';

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

// ─────────────────────────────────────────────────────────────────────────────

export type SyncStatus = 'synced' | 'local-newer' | 'server-newer' | 'conflict' | 'never-synced' | 'local-only' | 'server-only';

interface SyncStatusResult {
  status: SyncStatus;
  message: string;
}

/**
 * Comprehensive sync status info for UI display
 */
export interface SyncOverviewStatus {
  serverProjectCount: number;
  serverLastUpdated: Date | null;
  localProjectCount: number;
  isUninitialized: boolean;  // Server has no projects
  needsSync: boolean;        // Local has projects but server is empty or out of sync
  loading: boolean;
  error: string | null;
}

/**
 * Calculate sync status using three-way timestamp comparison
 */
export function calculateSyncStatus(
  localProject: Project,
  serverUpdatedAt?: Date
): SyncStatusResult {
  const { updatedAt, lastSyncedAt } = localProject;

  // If no server timestamp available, it's local-only
  if (!serverUpdatedAt) {
    return {
      status: 'local-only',
      message: 'Project exists only locally'
    };
  }

  // If never synced before
  if (!lastSyncedAt) {
    // Compare local and server times
    if (updatedAt > serverUpdatedAt) {
      return {
        status: 'local-newer',
        message: 'Local changes not yet synced'
      };
    } else if (serverUpdatedAt > updatedAt) {
      return {
        status: 'server-newer',
        message: 'Server has updates'
      };
    } else {
      return {
        status: 'synced',
        message: 'In sync with server'
      };
    }
  }

  // Three-way comparison
  const localChanged = updatedAt > lastSyncedAt;
  const serverChanged = serverUpdatedAt > lastSyncedAt;

  if (localChanged && serverChanged) {
    return {
      status: 'conflict',
      message: 'Both local and server have changes'
    };
  }

  if (localChanged) {
    return {
      status: 'local-newer',
      message: 'Local changes not yet synced'
    };
  }

  if (serverChanged) {
    return {
      status: 'server-newer',
      message: 'Server has updates'
    };
  }

  return {
    status: 'synced',
    message: 'In sync with server'
  };
}

const syncRetries = new Map<string, number>();
const MAX_RETRIES = 3;

/**
 * Auto-sync a project to the server (non-blocking, silent by default)
 */
export async function autoSyncProject(projectId: string, silent = true): Promise<void> {
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

    // Don't sync if already syncing
    if (project.syncStatus === 'syncing') {
      return;
    }

    // Get all files
    const files = await vfs.listFiles(projectId);

    // Push to server
    const response = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ project, files }),
    });

    if (response.status === 401) {
      syncRetries.delete(projectId);
      logger.warn(`[AutoSync] Skipping ${projectId}: session expired`);
      return;
    }

    if (response.status === 409) {
      // Server has newer changes — pull first, mark conflict
      logger.warn(`[AutoSync] Conflict for ${projectId}: server has newer changes`);
      project.syncStatus = 'error';
      await vfs.updateProject(project, { preserveUpdatedAt: true });
      if (!silent) {
        toast.error('Sync conflict: server has newer changes. Pull latest first.', {
          duration: 5000,
          position: 'bottom-right'
        });
      }
      syncRetries.delete(projectId);
      return;
    }

    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status}`);
    }

    const data = await response.json();
    const syncedProject = data.project;

    // Update local project with sync metadata (preserve updatedAt)
    project.lastSyncedAt = new Date(syncedProject.lastSyncedAt);
    project.serverUpdatedAt = new Date(syncedProject.serverUpdatedAt);
    project.syncStatus = 'synced';
    await vfs.updateProject(project, { preserveUpdatedAt: true });

    syncRetries.delete(projectId);
    logger.debug(`[AutoSync] Project ${projectId} synced successfully`);

    if (!silent) {
      toast.success('Project synced', {
        duration: 2000,
        position: 'bottom-right'
      });
    }
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync project ${projectId}:`, error);

    const retries = syncRetries.get(projectId) ?? 0;
    if (retries < MAX_RETRIES) {
      syncRetries.set(projectId, retries + 1);
      logger.warn(`[AutoSync] Will retry ${projectId} (${retries + 1}/${MAX_RETRIES})`);
      setTimeout(() => autoSyncProject(projectId), (retries + 1) * 5000);
    } else {
      syncRetries.delete(projectId);
      try {
        const project = await vfs.getProject(projectId);
        if (project) {
          project.syncStatus = 'error';
          await vfs.updateProject(project, { preserveUpdatedAt: true });
        }
      } catch (updateError) {
        logger.error(`[AutoSync] Failed to update project status:`, updateError);
      }

      if (!silent) {
        toast.error('Sync failed', {
          duration: 4000,
          position: 'bottom-right'
        });
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
    return status.status === 'server-newer' || status.status === 'conflict';
  } catch (error) {
    logger.error(`[AutoSync] Failed to check server updates for ${projectId}:`, error);
    return false;
  }
}

/**
 * Pull updates from server for a project
 */
export async function pullServerUpdates(projectId: string, showToast = true): Promise<boolean> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return false;
  }

  try {
    const response = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}`));
    if (!response.ok) {
      throw new Error(`Failed to pull updates: ${response.status}`);
    }

    const data = await response.json();
    const serverProject: Project = data.project;
    const serverFiles = data.files;

    // Save local state as checkpoint before overwriting (safety net)
    const localFiles = await vfs.listFiles(projectId);
    if (localFiles.length > 0) {
      try {
        const { checkpointManager } = await import('./checkpoint');
        await checkpointManager.createCheckpoint(projectId, 'Pre-sync backup (before pull)', { kind: 'auto' });
      } catch (cpErr) {
        logger.warn(`[AutoSync] Failed to create pre-pull checkpoint for ${projectId}:`, cpErr);
      }
    }

    // Suppress dirty marking during pull — these are server state, not user edits
    await saveManager.runWithSuppressedDirty(projectId, async () => {
      // Update project
      await vfs.updateProject(serverProject);

      // Sync files: update existing, create new, delete removed
      const existingFiles = await vfs.listFiles(projectId);
      const existingPaths = new Set(existingFiles.map(f => f.path));
      const serverPaths = new Set(serverFiles.map((f: any) => f.path));

      for (const file of serverFiles) {
        if (existingPaths.has(file.path)) {
          await vfs.updateFile(projectId, file.path, file.content || '');
        } else {
          await vfs.createFile(projectId, file.path, file.content || '');
        }
      }

      for (const existing of existingFiles) {
        if (!serverPaths.has(existing.path)) {
          await vfs.deleteFile(projectId, existing.path);
        }
      }

      // Update sync metadata
      const localProject = await vfs.getProject(projectId);
      if (localProject) {
        localProject.lastSyncedAt = new Date();
        localProject.serverUpdatedAt = new Date(serverProject.updatedAt);
        localProject.syncStatus = 'synced';
        await vfs.updateProject(localProject);
      }
    });

    logger.debug(`[AutoSync] Pulled updates for project ${projectId}`);
    if (showToast) {
      toast.success('Project updated from server');
    }

    return true;
  } catch (error) {
    logger.error(`[AutoSync] Failed to pull updates for ${projectId}:`, error);
    if (showToast) {
      toast.error('Failed to pull server updates');
    }
    return false;
  }
}

/**
 * Get comprehensive sync overview status for UI display
 * Compares local IndexedDB with server SQLite state
 */
export async function getSyncOverviewStatus(): Promise<SyncOverviewStatus> {
  // Only available in Server Mode
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
    return {
      serverProjectCount: 0,
      serverLastUpdated: null,
      localProjectCount: 0,
      isUninitialized: false,
      needsSync: false,
      loading: false,
      error: 'Server mode not enabled',
    };
  }

  try {
    // Fetch server status
    const response = await apiFetch(getAutoSyncApiUrl('/sync/status'));
    if (!response.ok) {
      // 404 = old route deleted (no workspace context), 401 = not authenticated
      // Return empty status instead of throwing
      if (response.status === 404 || response.status === 401) {
        return {
          serverProjectCount: 0, serverLastUpdated: null,
          localProjectCount: 0, isUninitialized: false, needsSync: false, loading: false, error: null,
        };
      }
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.summary || {
      projectCount: 0,
      deploymentCount: 0,
      lastUpdated: null,
      isUninitialized: true,
    };

    // Get local project count from IndexedDB
    await vfs.init();
    const localProjects = await vfs.listProjects();
    const localProjectCount = localProjects.length;

    // Determine if sync is needed
    const isUninitialized = summary.projectCount === 0;
    const needsSync = isUninitialized && localProjectCount > 0;

    return {
      serverProjectCount: summary.projectCount,
      serverLastUpdated: summary.lastUpdated ? new Date(summary.lastUpdated) : null,
      localProjectCount,
      isUninitialized,
      needsSync,
      loading: false,
      error: null,
    };
  } catch (error) {
    logger.error('[AutoSync] Failed to get sync overview status:', error);
    return {
      serverProjectCount: 0,
      serverLastUpdated: null,
      localProjectCount: 0,
      isUninitialized: true,
      needsSync: false,
      loading: false,
      error: error instanceof Error ? error.message : 'Failed to fetch sync status',
    };
  }
}

const AUTO_PULL_SESSION_KEY = 'osw_auto_pull_done';

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
    // Lightweight check — just project IDs + timestamps from server
    const response = await apiFetch(getAutoSyncApiUrl('/sync/status'));
    if (!response.ok) {
      logger.debug('[AutoSync] Server not available for pull');
      return { pulled: 0, skipped: 0, conflicts: [], errors: 0 };
    }

    const data = await response.json();
    const serverStatuses: { id: string; updatedAt: string }[] = data.projects || [];

    // Build local lookup: projectId → serverUpdatedAt (already cached from last sync)
    await vfs.init();
    const localProjects = await vfs.listProjects();
    const localMap = new Map(localProjects.map(p => [p.id, p]));

    // Filter to only projects that need attention
    const needsPull: { id: string; serverUpdatedAt: Date; isNew: boolean }[] = [];
    for (const serverStatus of serverStatuses) {
      const serverUpdatedAt = new Date(serverStatus.updatedAt);
      const local = localMap.get(serverStatus.id);

      if (!local) {
        needsPull.push({ id: serverStatus.id, serverUpdatedAt, isNew: true });
        continue;
      }

      const syncStatus = calculateSyncStatus(local, serverUpdatedAt);
      if (syncStatus.status === 'server-newer') {
        needsPull.push({ id: serverStatus.id, serverUpdatedAt, isNew: false });
      } else if (syncStatus.status === 'conflict') {
        conflicts.push(serverStatus.id);
      } else {
        skipped++;
      }
    }

    if (needsPull.length === 0 && conflicts.length === 0) {
      logger.debug(`[AutoSync] All ${skipped} projects up to date`);
      try { sessionStorage.setItem(AUTO_PULL_SESSION_KEY, '1'); } catch {}
      return { pulled: 0, skipped, conflicts, errors: 0 };
    }

    const total = needsPull.length;
    let processed = 0;

    for (const item of needsPull) {
      processed++;
      onProgress?.(processed, total);
      try {
        if (item.isNew) {
          const pullResponse = await apiFetch(getAutoSyncApiUrl(`/sync/projects/${item.id}`));
          if (!pullResponse.ok) { errors++; continue; }

          const pullData = await pullResponse.json();
          const serverProject: Project = pullData.project;
          const serverFiles = pullData.files;

          await vfs.createProject(serverProject.name, serverProject.description || '', serverProject.id);

          await saveManager.runWithSuppressedDirty(serverProject.id, async () => {
            const newProject = await vfs.getProject(serverProject.id);
            if (newProject) {
              newProject.settings = serverProject.settings || {};
              newProject.lastSyncedAt = new Date();
              newProject.serverUpdatedAt = item.serverUpdatedAt;
              newProject.syncStatus = 'synced';
              await vfs.updateProject(newProject, { preserveUpdatedAt: true });
            }

            for (const file of serverFiles) {
              await vfs.createFile(serverProject.id, file.path, file.content || '');
            }
          });

          pulled++;
          logger.debug(`[AutoSync] Pulled new project: ${serverProject.name}`);
        } else {
          await pullServerUpdates(item.id, false);
          pulled++;
        }
      } catch (error) {
        logger.error(`[AutoSync] Failed to process project ${item.id}:`, error);
        errors++;
      }
    }

    if (pulled > 0) {
      logger.debug(`[AutoSync] Auto-pull complete: ${pulled} updated, ${skipped} skipped, ${errors} errors`);
    }

    try { sessionStorage.setItem(AUTO_PULL_SESSION_KEY, '1'); } catch {}
    return { pulled, skipped, conflicts, errors };
  } catch (error) {
    logger.error('[AutoSync] Failed to auto-pull projects:', error);
    return { pulled, skipped, conflicts, errors };
  }
}

/**
 * Auto-delete a project from the server (non-blocking)
 */
export async function autoDeleteProject(projectId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    await apiFetch(getAutoSyncApiUrl(`/sync/projects/${projectId}`), { method: 'DELETE' });
    logger.debug(`[AutoSync] Project ${projectId} deleted from server`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to delete project ${projectId} from server:`, error);
  }
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
    await syncManager.pushSkill(skill);
    logger.debug(`[AutoSync] Skill ${skill.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync skill ${skill.id}:`, error);
  }
}

/**
 * Auto-delete a skill from the server (non-blocking)
 */
export async function autoDeleteSkill(skillId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    await apiFetch(getAutoSyncApiUrl(`/sync/skills/${skillId}`), { method: 'DELETE' });
    logger.debug(`[AutoSync] Skill ${skillId} deleted from server`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to delete skill ${skillId} from server:`, error);
  }
}

/**
 * Auto-sync a template to the server (non-blocking)
 */
export async function autoSyncTemplate(template: import('./types').CustomTemplate): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    const { getSyncManager } = await import('./sync-manager');
    const syncManager = getSyncManager();
    await syncManager.pushTemplate(template);
    logger.debug(`[AutoSync] Template ${template.id} synced`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to sync template ${template.id}:`, error);
  }
}

/**
 * Auto-delete a template from the server (non-blocking)
 */
export async function autoDeleteTemplate(templateId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    await apiFetch(getAutoSyncApiUrl(`/sync/templates/${templateId}`), { method: 'DELETE' });
    logger.debug(`[AutoSync] Template ${templateId} deleted from server`);
  } catch (error) {
    logger.error(`[AutoSync] Failed to delete template ${templateId} from server:`, error);
  }
}
