'use client';

import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SyncableItem } from '@/lib/vfs/sync-types';
import { SummaryBar } from './summary-bar';
import { SyncItemRow } from '../sync-item-row';
import { skillsService } from '@/lib/vfs/skills/service';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { track } from '@/lib/telemetry';

interface SkillsTabProps {
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

export function SkillsTab({
  items,
  selectedIds,
  syncingIds,
  onSelectedIdsChange,
  onSyncingIdsChange,
  onRefresh,
  onSyncComplete,
  onRegisterPushSelected,
  onRegisterPullSelected,
}: SkillsTabProps) {
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
    try {
      const skill = await skillsService.getSkill(item.id);
      if (!skill) {
        toast.error(t('skillNotFound', { name: item.name }));
        return;
      }

      const result = await syncManager.pushSkill(skill);

      if (result.success) {
        // Update local sync metadata
        if (result.skill) {
          await skillsService.updateSyncMetadata(
            item.id,
            new Date(),
            new Date(result.skill.updatedAt)
          );
        }
        toast.success(t('pushedName', { name: item.name }));
        if (!opts?.silent) {
          track('sync_manual', { item_type: 'skill', direction: 'push', bulk: false, count: 1 });
        }
        onRefresh();
        onSyncComplete();
      } else {
        toast.error(result.error || t('pushSkillFailed'));
        track('sync_fail', { item_type: 'skill', direction: 'push' });
      }
    } catch (error) {
      logger.error('Push skill error:', error);
      toast.error(t('pushSkillFailed'));
      track('sync_fail', { item_type: 'skill', direction: 'push' });
    } finally {
      onSyncingIdsChange((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const handlePullSingle = async (item: SyncableItem, opts?: { silent?: boolean }) => {
    onSyncingIdsChange((prev: Set<string>) => new Set(prev).add(item.id));
    try {
      const result = await syncManager.pullSkill(item.id);

      if (!result.success || !result.skill) {
        toast.error(result.error || t('pullSkillFailed'));
        track('sync_fail', { item_type: 'skill', direction: 'pull' });
        return;
      }

      // Import skill to local storage
      await skillsService.importFromServer(result.skill);

      toast.success(t('pulledName', { name: item.name }));
      if (!opts?.silent) {
        track('sync_manual', { item_type: 'skill', direction: 'pull', bulk: false, count: 1 });
      }
      onRefresh();
      onSyncComplete();
    } catch (error) {
      logger.error('Pull skill error:', error);
      toast.error(t('pullSkillFailed'));
      track('sync_fail', { item_type: 'skill', direction: 'pull' });
    } finally {
      onSyncingIdsChange((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
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
          ['local-newer', 'local-only', 'conflict'].includes(item.status)
      );

      for (const item of itemsToPush) {
        await handlePushSingle(item, { silent: true });
      }

      if (itemsToPush.length > 0) {
        track('sync_manual', { item_type: 'skill', direction: 'push', bulk: true, count: itemsToPush.length });
      }

      onSelectedIdsChange(new Set());
    };

    const pullSelected = async () => {
      const currentItems = itemsRef.current;
      const currentSelectedIds = selectedIdsRef.current;

      const itemsToPull = currentItems.filter(
        (item) =>
          currentSelectedIds.has(item.id) &&
          ['server-newer', 'server-only', 'conflict'].includes(item.status)
      );

      for (const item of itemsToPull) {
        await handlePullSingle(item, { silent: true });
      }

      if (itemsToPull.length > 0) {
        track('sync_manual', { item_type: 'skill', direction: 'pull', bulk: true, count: itemsToPull.length });
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
        {t('noSkillsToSync')}
      </div>
    );
  }

  return (
    <div>
      {/* Summary */}
      <SummaryBar items={items} />

      {/* Item List - scrollable */}
      <div className="mt-3 border rounded-lg divide-y overflow-y-auto max-h-64">
        {items.map((item) => (
          <SyncItemRow
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onSelectChange={(selected) => handleSelectChange(item.id, selected)}
            onPush={() => handlePushSingle(item)}
            onPull={() => handlePullSingle(item)}
            syncing={syncingIds.has(item.id)}
            disabled={syncingIds.size > 0}
          />
        ))}
      </div>
    </div>
  );
}
