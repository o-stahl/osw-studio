'use client';

import { SyncableItem } from '@/lib/vfs/sync-types';
import { useTranslations } from 'next-intl';
import { SyncStatusBadge } from './sync-status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tip } from '@/components/ui/tooltip';
import { ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SyncItemRowProps {
  item: SyncableItem;
  selected: boolean;
  onSelectChange: (selected: boolean) => void;
  onPush?: () => void;
  onPull?: () => void;
  onResolve?: () => void;
  disabled?: boolean;
  syncing?: boolean;
}

export function SyncItemRow({
  item,
  selected,
  onSelectChange,
  onPush,
  onPull,
  onResolve,
  disabled = false,
  syncing = false,
}: SyncItemRowProps) {
  const t = useTranslations('sync');
  const canPush = ['local-newer', 'local-only', 'conflict'].includes(item.status);
  const canPull = ['server-newer', 'server-only', 'conflict'].includes(item.status);
  const isConflict = item.status === 'conflict';
  const busy = disabled || syncing;
  const pushTip = item.status === 'local-only'
    ? t('tips.pushNew', { name: item.name })
    : t('tips.pushReplace', { name: item.name });
  const pullTip = item.status === 'server-only'
    ? t('tips.pullNew', { name: item.name })
    : t('tips.pullReplace', { name: item.name });
  const selectOff = item.status === 'synced'
    ? t('tips.inSync')
    : item.status === 'server-only'
      ? t('tips.serverOnly')
      : busy
        ? t('tips.busy')
        : undefined;

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors',
        selected && 'bg-muted/30'
      )}
    >
      {/* Checkbox */}
      <Tip label={selectOff} wrap wrapClassName="inline-flex shrink-0">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectChange(checked === true)}
          disabled={disabled || syncing || item.status === 'synced' || item.status === 'server-only'}
          aria-label={t('selectItem', { name: item.name })}
        />
      </Tip>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">{item.name}</span>
      </div>

      {/* Status Badge */}
      <SyncStatusBadge
        status={syncing ? 'syncing' : item.status}
        showLabel={true}
        size="sm"
      />

      {/* Actions */}
      <div className="flex items-center gap-1">
        {isConflict && onResolve ? (
          <Tip label={busy ? t('tips.busy') : t('tips.keepBoth')}>
            <Button
              variant="outline"
              size="sm"
              onClick={onResolve}
              disabled={disabled || syncing}
              className="h-7 text-xs"
            >
              {t('keepBoth')}
            </Button>
          </Tip>
        ) : (
          <>
            {canPush && onPush && (
              <Tip label={busy ? t('tips.busy') : pushTip}>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onPush}
                  disabled={disabled || syncing}
                  className="h-7 w-7"
                  aria-label={pushTip}
                >
                  {syncing ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" />
                  )}
                </Button>
              </Tip>
            )}
            {canPull && onPull && (
              <Tip label={busy ? t('tips.busy') : pullTip}>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onPull}
                  disabled={disabled || syncing}
                  className="h-7 w-7"
                  aria-label={pullTip}
                >
                  {syncing ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" />
                  )}
                </Button>
              </Tip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
