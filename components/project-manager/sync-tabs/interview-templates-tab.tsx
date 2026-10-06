'use client';

import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SyncableItem } from '@/lib/vfs/sync-types';
import { SummaryBar } from './summary-bar';
import { SyncItemRow } from '../sync-item-row';
import { interviewTemplatesService } from '@/lib/interview/templates-service';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { track } from '@/lib/telemetry';

interface InterviewTemplatesTabProps {
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

export function InterviewTemplatesTab({
  items,
  selectedIds,
  syncingIds,
  onSelectedIdsChange,
  onSyncingIdsChange,
  onRefresh,
  onSyncComplete,
  onRegisterPushSelected,
  onRegisterPullSelected,
}: InterviewTemplatesTabProps) {
  const t = useTranslations('sync');
  const syncManager = getSyncManager();

  const selectedIdsRef = useRef(selectedIds);
  const itemsRef = useRef(items);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
    itemsRef.current = items;
  }, [selectedIds, items]);

  const handleSelectChange = (id: string, selected: boolean) => {
    const newSelected = new Set(selectedIds);
    if (selected) newSelected.add(id);
    else newSelected.delete(id);
    onSelectedIdsChange(newSelected);
  };

  const handlePushSingle = async (item: SyncableItem, opts?: { silent?: boolean }) => {
    onSyncingIdsChange((prev: Set<string>) => new Set(prev).add(item.id));
    try {
      const template = await interviewTemplatesService.getTemplate(item.id);
      if (!template || template.isBuiltIn) {
        toast.error(t('templateNotFound', { name: item.name }));
        return;
      }
      const result = await syncManager.pushInterviewTemplate(template);
      if (result.success) {
        if (result.interviewTemplate?.updatedAt) {
          await interviewTemplatesService.updateSyncMetadata(item.id, new Date(), new Date(result.interviewTemplate.updatedAt));
        }
        toast.success(t('pushedName', { name: item.name }));
        if (!opts?.silent) {
          track('sync_manual', { item_type: 'interviewTemplate', direction: 'push', bulk: false, count: 1 });
        }
        onRefresh();
        onSyncComplete();
      } else {
        toast.error(result.error || t('pushTemplateFailed'));
        track('sync_fail', { item_type: 'interviewTemplate', direction: 'push' });
      }
    } catch (error) {
      logger.error('Push interview template error:', error);
      toast.error(t('pushTemplateFailed'));
      track('sync_fail', { item_type: 'interviewTemplate', direction: 'push' });
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
      const result = await syncManager.pullInterviewTemplate(item.id);
      if (!result.success || !result.interviewTemplate) {
        toast.error(result.error || t('pullTemplateFailed'));
        track('sync_fail', { item_type: 'interviewTemplate', direction: 'pull' });
        return;
      }
      await interviewTemplatesService.importFromServer(result.interviewTemplate);
      toast.success(t('pulledName', { name: item.name }));
      if (!opts?.silent) {
        track('sync_manual', { item_type: 'interviewTemplate', direction: 'pull', bulk: false, count: 1 });
      }
      onRefresh();
      onSyncComplete();
    } catch (error) {
      logger.error('Pull interview template error:', error);
      toast.error(t('pullTemplateFailed'));
      track('sync_fail', { item_type: 'interviewTemplate', direction: 'pull' });
    } finally {
      onSyncingIdsChange((prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  // Register bulk handlers on mount only
  useEffect(() => {
    const pushSelected = async () => {
      const itemsToPush = itemsRef.current.filter(
        (item) => selectedIdsRef.current.has(item.id) && ['local-newer', 'local-only', 'conflict'].includes(item.status)
      );
      for (const item of itemsToPush) await handlePushSingle(item, { silent: true });
      if (itemsToPush.length > 0) {
        track('sync_manual', { item_type: 'interviewTemplate', direction: 'push', bulk: true, count: itemsToPush.length });
      }
      onSelectedIdsChange(new Set());
    };
    const pullSelected = async () => {
      const itemsToPull = itemsRef.current.filter(
        (item) => selectedIdsRef.current.has(item.id) && ['server-newer', 'server-only', 'conflict'].includes(item.status)
      );
      for (const item of itemsToPull) await handlePullSingle(item, { silent: true });
      if (itemsToPull.length > 0) {
        track('sync_manual', { item_type: 'interviewTemplate', direction: 'pull', bulk: true, count: itemsToPull.length });
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
  }, []);

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        {t('noInterviewTemplatesToSync')}
      </div>
    );
  }

  return (
    <div>
      <SummaryBar items={items} />
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
