'use client';

import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SyncableItem } from '@/lib/vfs/sync-types';
import { SummaryBar } from './summary-bar';
import { SyncItemRow } from '../sync-item-row';
import { vfs } from '@/lib/vfs';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { track } from '@/lib/telemetry';

interface TemplatesTabProps {
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

export function TemplatesTab({
  items,
  selectedIds,
  syncingIds,
  onSelectedIdsChange,
  onSyncingIdsChange,
  onRefresh,
  onSyncComplete,
  onRegisterPushSelected,
  onRegisterPullSelected,
}: TemplatesTabProps) {
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
      // Get template from IndexedDB
      await vfs.init();
      const template = await vfs.getStorageAdapter().getCustomTemplate(item.id);

      if (!template) {
        toast.error(t('templateNotFound', { name: item.name }));
        return;
      }

      const result = await syncManager.pushTemplate(template);

      if (result.success) {
        toast.success(t('pushedName', { name: item.name }));
        if (!opts?.silent) {
          track('sync_manual', { item_type: 'template', direction: 'push', bulk: false, count: 1 });
        }
        onRefresh();
        onSyncComplete();
      } else {
        toast.error(result.error || t('pushTemplateFailed'));
        track('sync_fail', { item_type: 'template', direction: 'push' });
      }
    } catch (error) {
      logger.error('Push template error:', error);
      toast.error(t('pushTemplateFailed'));
      track('sync_fail', { item_type: 'template', direction: 'push' });
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
      const result = await syncManager.pullTemplate(item.id);

      if (!result.success || !result.template) {
        toast.error(result.error || t('pullTemplateFailed'));
        track('sync_fail', { item_type: 'template', direction: 'pull' });
        return;
      }

      // Save template to IndexedDB
      await vfs.init();

      // Restore Date objects
      const template = {
        ...result.template,
        importedAt: new Date(result.template.importedAt),
        updatedAt: result.template.updatedAt ? new Date(result.template.updatedAt) : new Date(),
      };

      await vfs.getStorageAdapter().saveCustomTemplate(template);

      toast.success(t('pulledName', { name: item.name }));
      if (!opts?.silent) {
        track('sync_manual', { item_type: 'template', direction: 'pull', bulk: false, count: 1 });
      }
      onRefresh();
      onSyncComplete();
    } catch (error) {
      logger.error('Pull template error:', error);
      toast.error(t('pullTemplateFailed'));
      track('sync_fail', { item_type: 'template', direction: 'pull' });
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
        track('sync_manual', { item_type: 'template', direction: 'push', bulk: true, count: itemsToPush.length });
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
        track('sync_manual', { item_type: 'template', direction: 'pull', bulk: true, count: itemsToPull.length });
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
        {t('noTemplatesToSync')}
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
