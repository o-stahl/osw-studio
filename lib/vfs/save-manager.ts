import { checkpointManager, Checkpoint } from './checkpoint';
import { getActiveVFS } from './index';
import { logger } from '@/lib/utils';

interface DirtyEvent {
  projectId: string;
  dirty: boolean;
}

class SaveManager {
  private dirtyProjects = new Set<string>();
  private listeners = new Set<(event: DirtyEvent) => void>();
  private suppressionCounts = new Map<string, number>();
  private manualCheckpoints = new Map<string, string>();

  subscribe(listener: (event: DirtyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(projectId: string): void {
    const event: DirtyEvent = { projectId, dirty: this.isDirty(projectId) };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('[SaveManager] Listener error', error);
      }
    }
  }

  markDirty(projectId: string): void {
    if (this.isDirtySuppressed(projectId) || this.dirtyProjects.has(projectId)) {
      return;
    }
    this.dirtyProjects.add(projectId);
    this.emit(projectId);
  }

  /**
   * Always tells the listeners, changed or not: the workspace's own flag, which the header shows, is
   * also set by a finished server run that never passes through here, and has to be cleared too.
   */
  markClean(projectId: string): void {
    this.dirtyProjects.delete(projectId);
    this.emit(projectId);
  }

  isDirty(projectId: string): boolean {
    return this.dirtyProjects.has(projectId);
  }

  beginSuppression(projectId: string): void {
    const current = this.suppressionCounts.get(projectId) ?? 0;
    this.suppressionCounts.set(projectId, current + 1);
  }

  endSuppression(projectId: string): void {
    const current = this.suppressionCounts.get(projectId) ?? 0;
    if (current <= 1) {
      this.suppressionCounts.delete(projectId);
      return;
    }
    this.suppressionCounts.set(projectId, current - 1);
  }

  async runWithSuppressedDirty<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    this.beginSuppression(projectId);
    try {
      return await fn();
    } finally {
      this.endSuppression(projectId);
    }
  }

  isDirtySuppressed(projectId: string): boolean {
    return (this.suppressionCounts.get(projectId) ?? 0) > 0;
  }

  async save(projectId: string, description?: string): Promise<Checkpoint> {
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const project = await activeVFS.getProject(projectId);
    const fallbackDescription = `Manual save @ ${new Date().toLocaleTimeString()}`; // i18n-ignore: stored English; the panel shows `label`
    const previousSavedId = project.lastSavedCheckpointId ?? null;
    const checkpoint = await checkpointManager.createCheckpoint(projectId, description || fallbackDescription, {
      kind: 'manual',
      // The time is read from the checkpoint's own timestamp when shown, in the viewer's format.
      label: description ? undefined : { key: 'manualSave' },
      baseRevisionId: previousSavedId
    });

    project.lastSavedCheckpointId = checkpoint.id;
    await activeVFS.updateProject(project);
    project.lastSavedAt = project.updatedAt;
    await activeVFS.updateProject(project, { preserveUpdatedAt: true });

    if (previousSavedId && previousSavedId !== checkpoint.id) {
      // The previous save is now an ordinary checkpoint; one an earlier Save pinned is unpinned.
      await checkpointManager.releaseSavePin(previousSavedId);
    }

    activeVFS.scheduleAutoSync(projectId);

    this.manualCheckpoints.set(projectId, checkpoint.id);
    this.markClean(projectId);
    return checkpoint;
  }

  async restoreLastSaved(projectId: string): Promise<boolean> {
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const project = await activeVFS.getProject(projectId);
    const checkpointId = project.lastSavedCheckpointId;
    if (!checkpointId) {
      logger.warn('[SaveManager] No saved checkpoint to restore', { projectId });
      return false;
    }

    const restored = await this.runWithSuppressedDirty(projectId, async () => {
      const exists = await checkpointManager.checkpointExists(checkpointId);
      if (!exists) {
        logger.warn('[SaveManager] Saved checkpoint missing', { projectId, checkpointId });
        return false;
      }
      // Files only. Discard is explicit; opening a project no longer calls this. Backend
      // features are editable from the gallery with no Save button — restoring them here
      // would drop an edit the user had no way to commit, and any secret created since.
      const success = await checkpointManager.restoreCheckpoint(checkpointId, { backend: false });
      if (!success) {
        logger.error('[SaveManager] Failed to restore saved checkpoint', { projectId, checkpointId });
      }
      return success;
    });

    if (restored) {
      // The restore is stamped as a change so it syncs; the files are the save's again, so the
      // saved baseline moves up to it and the project reads as saved.
      const after = await activeVFS.getProject(projectId);
      after.lastSavedAt = after.updatedAt;
      await activeVFS.updateProject(after, { preserveUpdatedAt: true });
      this.markClean(projectId);
    }
    return restored;
  }

  /** Record a save made other than by `save`: the checkpoint a project gets on its first open. */
  setSavedCheckpointId(projectId: string, checkpointId: string): void {
    this.manualCheckpoints.set(projectId, checkpointId);
  }

  getSavedCheckpointId(projectId: string): string | null {
    return this.manualCheckpoints.get(projectId) ?? null;
  }

  async syncProjectSaveState(projectId: string): Promise<void> {
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const project = await activeVFS.getProject(projectId);
    if (project.lastSavedCheckpointId) {
      this.manualCheckpoints.set(projectId, project.lastSavedCheckpointId);
    } else {
      this.manualCheckpoints.delete(projectId);
    }
  }
}

export const saveManager = new SaveManager();
