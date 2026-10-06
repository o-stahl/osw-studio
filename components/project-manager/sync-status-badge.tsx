'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { ItemSyncStatus } from '@/lib/vfs/sync-types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CheckCircle,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  HardDrive,
  Cloud,
  RefreshCw,
  XCircle,
} from 'lucide-react';

interface SyncStatusBadgeProps {
  status: ItemSyncStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const STATUS_CONFIG: Record<
  ItemSyncStatus,
  {
    icon: typeof CheckCircle;
    colorClass: string;
    bgClass: string;
  }
> = {
  synced: {
    icon: CheckCircle,
    colorClass: 'text-green-600 dark:text-green-400',
    bgClass: 'bg-green-500/10',
  },
  'local-newer': {
    icon: ArrowUp,
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-500/10',
  },
  'server-newer': {
    icon: ArrowDown,
    colorClass: 'text-orange-600 dark:text-orange-400',
    bgClass: 'bg-orange-500/10',
  },
  conflict: {
    icon: AlertTriangle,
    colorClass: 'text-red-600 dark:text-red-400',
    bgClass: 'bg-red-500/10',
  },
  'local-only': {
    icon: HardDrive,
    colorClass: 'text-gray-600 dark:text-gray-400',
    bgClass: 'bg-gray-500/10',
  },
  'server-only': {
    icon: Cloud,
    colorClass: 'text-purple-600 dark:text-purple-400',
    bgClass: 'bg-purple-500/10',
  },
  syncing: {
    icon: RefreshCw,
    colorClass: 'text-blue-600 dark:text-blue-400',
    bgClass: 'bg-blue-500/10',
  },
  error: {
    icon: XCircle,
    colorClass: 'text-red-600 dark:text-red-400',
    bgClass: 'bg-red-500/10',
  },
};

/**
 * Translated label and description per status.
 *
 * {@link STATUS_CONFIG} is module-level and holds only the icon and colours, which do not change
 * with the locale. Every `t()` call is a literal, because typed messages reject a computed key.
 */
function useStatusCopy(): Record<ItemSyncStatus, { label: string; description: string }> {
  const t = useTranslations('syncStatus');
  return useMemo(() => ({
    synced: { label: t('synced'), description: t('syncedDesc') },
    'local-newer': { label: t('localNewer'), description: t('localNewerDesc') },
    'server-newer': { label: t('serverNewer'), description: t('serverNewerDesc') },
    conflict: { label: t('conflict'), description: t('conflictDesc') },
    'local-only': { label: t('localOnly'), description: t('localOnlyDesc') },
    'server-only': { label: t('serverOnly'), description: t('serverOnlyDesc') },
    syncing: { label: t('syncing'), description: t('syncingDesc') },
    error: { label: t('error'), description: t('failedDesc') },
  }), [t]);
}

export function SyncStatusBadge({
  status,
  showLabel = true,
  size = 'sm',
  className,
}: SyncStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const copy = useStatusCopy()[status];
  const Icon = config.icon;

  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';
  const padding = size === 'sm' ? 'px-1.5 py-0.5' : 'px-2 py-1';

  const badge = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full font-medium cursor-help',
        padding,
        config.bgClass,
        config.colorClass,
        textSize,
        className
      )}
    >
      <Icon
        className={cn(iconSize, status === 'syncing' && 'animate-spin')}
      />
      {showLabel && <span>{copy.label}</span>}
    </span>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-sm">{copy.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function getStatusPriority(status: ItemSyncStatus): number {
  const priorities: Record<ItemSyncStatus, number> = {
    conflict: 0,
    error: 1,
    'local-newer': 2,
    'server-newer': 3,
    syncing: 4,
    'local-only': 5,
    'server-only': 6,
    synced: 7,
  };
  return priorities[status];
}
