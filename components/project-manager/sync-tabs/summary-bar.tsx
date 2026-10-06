'use client';

import { useTranslations } from 'next-intl';
import { SyncableItem } from '@/lib/vfs/sync-types';

interface SummaryBarProps {
  items: SyncableItem[];
}

export function SummaryBar({ items }: SummaryBarProps) {
  const t = useTranslations('syncSummary');
  const synced = items.filter((i) => i.status === 'synced').length;
  const localNewer = items.filter((i) => i.status === 'local-newer').length;
  const serverNewer = items.filter((i) => i.status === 'server-newer').length;
  const conflicts = items.filter((i) => i.status === 'conflict').length;
  const localOnly = items.filter((i) => i.status === 'local-only').length;
  const serverOnly = items.filter((i) => i.status === 'server-only').length;

  const parts: string[] = [];
  if (synced > 0) parts.push(t('synced', { count: synced }));
  if (localNewer > 0) parts.push(t('localNewer', { count: localNewer }));
  if (serverNewer > 0) parts.push(t('serverNewer', { count: serverNewer }));
  if (conflicts > 0) parts.push(t('conflicts', { count: conflicts }));
  if (localOnly > 0) parts.push(t('localOnly', { count: localOnly }));
  if (serverOnly > 0) parts.push(t('serverOnly', { count: serverOnly }));

  return (
    <div className="text-sm text-muted-foreground">
      {parts.join(', ')}
    </div>
  );
}
