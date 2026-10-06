'use client';

import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SyncableItem } from '@/lib/vfs/sync-types';
import { SummaryBar } from './summary-bar';
import { SyncItemRow } from '../sync-item-row';
import { vfs, Project } from '@/lib/vfs';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { createSyncProgressToast } from '@/lib/vfs/sync-progress-toast';
import { saveManager } from '@/lib/vfs/save-manager';
import { logger } from '@/lib/utils';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { sortSyncItems } from '../sync-item-order';

interface ProjectsTabProps {
  items: SyncableItem[];
  selectedIds: Set<string>;
  syncingIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  onSyncingIdsChange: Dispatch<SetStateAction<Set<string>>>;
  onRefresh: () => void;
  onSyncComplete: () => void;
  onRegisterPushSelected: (handler: (() => Promise<void>) | null) => void;
  onRegisterPullSelected: (handler: (() => Promise<void>) | null) => void;
}

export function ProjectsTab({
  items,
  selectedIds,
  syncingIds,
  onSelectedIdsChange,
  onSyncingIdsChange,
  onRefresh,
  onSyncComplete,
  onRegisterPushSelected,
  onRegisterPullSelected,
}: ProjectsTabProps) {
  const t = useTranslations('sync');
  const syncManager = getSyncManager();

  // Use refs to hold the latest values for use in mount-only handlers
  const selectedIdsRef = useRef(selectedIds);
  const itemsRef = useRef(items);

  // Keep refs up to date
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
    itemsRef.current = items;
  }, [selectedIds, items]);

  const handleSelectChange = (id: string, selected: boolean) => {
    const newSelected = new Set(selectedIds);
    if (selected) {
      newSelected.add(id);
    } else {
      newSelected.delete(id);
    }
    onSelectedIdsChange(newSelected);
  };

  const handlePushSingle = async (item: SyncableItem, opts?: { silent?: boolean }) => {
    onSyncingIdsChange((prev: Set<string>) => new Set(prev).add(item.id));
    // A push is one request per batch, so a large project is a sequence of them. The toast
    // resolves to this push's own outcome, replacing the ones the code below used to raise.
    const progress = createSyncProgressToast(t('pushingName', { name: item.name }));
    try {
      const project = await vfs.getProject(item.id);
      if (!project) {
        progress.error(t('projectNotFound', { name: item.name }));
        return;
      }

      const files = await vfs.listFiles(item.id);
      // An explicit push from this dialog means "make the server match my copy", including when
      // both sides have changed — the row says Conflict and the tooltip offers exactly this. Only
      // background syncs leave the server's newer copy alone and report the conflict instead.
      const result = await syncManager.pushSingleProject(item.id, project, files, {
        onProgress: ({ batch, batches }) => progress.update(batch, batches),
      });

      if (result.success) {
        // Update local sync metadata to prevent conflict on refresh
        if (result.project) {
          const { persistAcknowledgedRevision } = await import('@/lib/vfs/auto-sync');
          await persistAcknowledgedRevision(item.id, result.project.revision, {
            lastSyncedAt: new Date(),
            serverUpdatedAt: result.project.updatedAt
              ? new Date(result.project.updatedAt)
              : new Date(),
            syncStatus: 'synced',
          });
        }
        progress.success(t('pushedName', { name: item.name }));
        if (!opts?.silent) {
          track('sync_manual', { item_type: 'project', direction: 'push', bulk: false, count: 1 });
        }
        onRefresh();
        onSyncComplete();
      } else {
        progress.error(result.error || t('pushProjectFailed'));
        track('sync_fail', { item_type: 'project', direction: 'push' });
      }
    } catch (error) {
      logger.error('Push error:', error);
      progress.error(t('pushProjectFailed'));
      track('sync_fail', { item_type: 'project', direction: 'push' });
    } finally {
      onSyncingIdsChange((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handlePullSingle = async (item: SyncableItem, opts?: { silent?: boolean }): Promise<boolean> => {
    onSyncingIdsChange((prev: Set<string>) => new Set(prev).add(item.id));
    // The download is one request, but writing the files back is one VFS call each — which is the
    // part that takes visible time on a large project and showed nothing until it finished.
    const progress = createSyncProgressToast(t('pullingName', { name: item.name }));
    try {
      const result = await syncManager.pullSingleProject(item.id);

      if (!result.success || !result.project) {
        progress.error(result.error || t('pullProjectFailed'));
        track('sync_fail', { item_type: 'project', direction: 'pull' });
        return false;
      }
      const serverProject = result.project;

      // Update or create local project
      let existingProject: Project | null = null;
      try {
        existingProject = await vfs.getProject(item.id);
      } catch {
        // Project doesn't exist locally yet
      }

      await saveManager.runWithSuppressedDirty(item.id, async () => {
        if (existingProject) {
          const existingFiles = await vfs.listFiles(item.id);
          for (const file of existingFiles) {
            await vfs.deleteFile(item.id, file.path);
          }
        } else {
          await vfs.createProject(serverProject.name, serverProject.description || '', item.id);
        }

        const pulledFiles = result.files || [];
        let written = 0;
        for (const file of pulledFiles) {
          await vfs.createFile(item.id, file.path, file.content || '');
          progress.update(++written, pulledFiles.length);
        }
      });

      // Update project with server data and sync metadata
      let pulledProject: Project | null = null;
      try {
        pulledProject = await vfs.getProject(item.id);
      } catch {
        // Should not happen at this point
      }
      if (pulledProject) {
        const serverUpdatedAt = result.project.updatedAt
          ? new Date(result.project.updatedAt)
          : new Date();
        pulledProject.name = result.project.name;
        pulledProject.description = result.project.description;
        pulledProject.updatedAt = serverUpdatedAt; // Match server timestamp
        pulledProject.lastSyncedAt = new Date();
        pulledProject.serverUpdatedAt = serverUpdatedAt;
        pulledProject.syncStatus = 'synced';
        if (typeof result.project.revision === 'number') {
          pulledProject.revision = result.project.revision;
        }
        await vfs.updateProject(pulledProject, { preserveUpdatedAt: true });
      }

      progress.success(t('pulledName', { name: item.name }));
      if (!opts?.silent) {
        track('sync_manual', { item_type: 'project', direction: 'pull', bulk: false, count: 1 });
      }
      onRefresh();
      onSyncComplete();
      return true;
    } catch (error) {
      logger.error('Pull error:', error);
      progress.error(t('pullProjectFailed'));
      track('sync_fail', { item_type: 'project', direction: 'pull' });
      return false;
    } finally {
      onSyncingIdsChange((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handleKeepBoth = async (item: SyncableItem) => {
    try {
      const draft = await vfs.forkLocalDraft(item.id);
      const pulled = await handlePullSingle(item, { silent: true });
      if (!pulled) {
        toast.error(t('draftSavedPullFailed', { name: draft.name }));
        return;
      }
      toast.success(t('draftKept', { name: draft.name }));
      track('sync_manual', { item_type: 'project', direction: 'keep_both', bulk: false, count: 1 });
    } catch (error) {
      logger.error('Keep both error:', error);
      toast.error(error instanceof Error ? error.message : t('keepBothFailed'));
    }
  };

  // Register handlers on mount only
  useEffect(() => {
    const pushSelected = async () => {
      const currentItems = itemsRef.current;
      const currentSelectedIds = selectedIdsRef.current;

      const itemsToPush = currentItems.filter(
        (item) =>
          currentSelectedIds.has(item.id) &&
          ['local-newer', 'local-only'].includes(item.status)
      );

      for (const item of itemsToPush) {
        await handlePushSingle(item, { silent: true });
      }

      if (itemsToPush.length > 0) {
        track('sync_manual', { item_type: 'project', direction: 'push', bulk: true, count: itemsToPush.length });
      }

      onSelectedIdsChange(new Set());
    };

    const pullSelected = async () => {
      const currentItems = itemsRef.current;
      const currentSelectedIds = selectedIdsRef.current;

      const itemsToPull = currentItems.filter(
        (item) =>
          currentSelectedIds.has(item.id) &&
          ['server-newer', 'server-only'].includes(item.status)
      );

      for (const item of itemsToPull) {
        await handlePullSingle(item, { silent: true });
      }

      if (itemsToPull.length > 0) {
        track('sync_manual', { item_type: 'project', direction: 'pull', bulk: true, count: itemsToPull.length });
      }

      onSelectedIdsChange(new Set());
    };

    onRegisterPushSelected(pushSelected);
    onRegisterPullSelected(pullSelected);

    return () => {
      onRegisterPushSelected(null);
      onRegisterPullSelected(null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t('noProjectsToSync')}
      </div>
    );
  }

  return (
    <div>
      {/* Summary */}
      <SummaryBar items={items} />

      {/* Item List - scrollable. Conflicts first so the summary is not a scavenger hunt. */}
      <div className="mt-3 border rounded-lg divide-y overflow-y-auto max-h-64">
        {sortSyncItems(items).map((item) => (
          <SyncItemRow
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onSelectChange={(selected) => handleSelectChange(item.id, selected)}
            onPush={() => handlePushSingle(item)}
            onPull={() => handlePullSingle(item)}
            onResolve={item.status === 'conflict' ? () => handleKeepBoth(item) : undefined}
            syncing={syncingIds.has(item.id)}
            disabled={syncingIds.size > 0}
          />
        ))}
      </div>
    </div>
  );
}
