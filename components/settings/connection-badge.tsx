'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut } from 'lucide-react';

interface ConnectionBadgeProps {
  method?: string;
  extra?: string;
  info?: React.ReactNode;
  onDisconnect: () => void;
  disconnecting?: boolean;
}

export function ConnectionBadge({ method, extra, info, onDisconnect, disconnecting }: ConnectionBadgeProps) {
  const tc = useTranslations('common');
  const t = useTranslations('settings');
  return (
    <div>
      <div className="flex items-center justify-between p-2.5 rounded-lg border border-green-600/15 bg-green-500/5">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
          <span className="text-sm font-semibold text-green-600 dark:text-green-400">{tc('labels.connected')}</span>
          {method && (
            <span className="text-xs text-muted-foreground">{t('connectedVia', { method })}</span>
          )}
          {extra && (
            <span className="text-xs text-muted-foreground">{extra}</span>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-muted-foreground hover:text-destructive h-7 px-2 text-xs"
          onClick={onDisconnect}
          disabled={disconnecting}
        >
          {disconnecting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <LogOut className="h-3 w-3" />
          )}
          {tc('actions.disconnect')}
        </Button>
      </div>
      {info && (
        <div className="text-xs text-muted-foreground mt-2 pl-0.5">
          {info}
        </div>
      )}
    </div>
  );
}
