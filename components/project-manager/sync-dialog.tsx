'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { getLoginUrl } from '@/lib/config/storage';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Cloud, CloudOff, RefreshCw, AlertTriangle, CheckSquare, ArrowUp, ArrowDown } from 'lucide-react';
import { SyncTabs, BulkActionState } from './sync-tabs';
import { useSyncStatus } from './hooks/use-sync-status';
import { notifyServerProjectsChanged } from '@/lib/vfs/sync-events';
import { invalidateSyncStatusCache } from '@/lib/vfs/auto-sync';
import { apiFetch } from '@/lib/api/backend-status';

interface SyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSyncComplete?: () => void;
}

export function SyncDialog({ open, onOpenChange, onSyncComplete }: SyncDialogProps) {
  const tc = useTranslations('common');
  const t = useTranslations('sync');
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const { status, refresh, loading, refreshing, error } = useSyncStatus();
  const [bulkState, setBulkState] = useState<BulkActionState | null>(null);

  useEffect(() => {
    if (open) {
      checkAuth();
      refresh();
    }
  }, [open, refresh]);

  const checkAuth = async () => {
    setAuthLoading(true);
    try {
      const response = await apiFetch('/api/auth/me');
      const data = await response.json();
      setAuthenticated(data.authenticated);
    } catch {
      setAuthenticated(false);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSyncComplete = () => {
    // A manual push or pull changes what the server holds, so the shared status snapshot has to go
    // before anyone is told to re-read — otherwise the badges recompute from a pre-sync snapshot.
    invalidateSyncStatusCache();
    refresh();
    // This dialog is mounted by PageLayout, a sibling of whatever view is on screen, so the view's
    // server-backed lists (the deployment project pickers, the project gallery) can only learn
    // about a completed sync by listening. Without this they stayed on their mount-time snapshot
    // until a full page reload.
    notifyServerProjectsChanged();
    onSyncComplete?.();
  };

  const dialogContentClass = "sm:max-w-2xl";

  // Loading state
  if (authLoading) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={dialogContentClass}>
          <DialogHeader>
            <DialogTitle>{t('serverSyncTitle')}</DialogTitle>
            <DialogDescription>
              {t('checkingAuth')}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  // Not authenticated
  if (!authenticated) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={dialogContentClass}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudOff className="w-5 h-5" />
              {t('notAuthenticated')}
            </DialogTitle>
            <DialogDescription>
              {t('needLoginToSync')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button onClick={() => (window.location.href = getLoginUrl())}>
              {t('goToLogin')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogContentClass}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="w-5 h-5" />
            {t('serverSyncTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('syncDesc')}
          </DialogDescription>
        </DialogHeader>

        <div>
          {/* Error Banner */}
          {error && (
            <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-red-600 dark:text-red-400">
                  {t('errorLoadingStatus')}
                </p>
                <p className="text-muted-foreground mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* Initial Loading */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">{t('loadingStatus')}</span>
            </div>
          )}

          {/* Tabbed Content (kept visible during refresh) */}
          {!loading && !error && (
            <div className="relative">
              {refreshing && (
                <div className="absolute inset-0 bg-background/60 z-10 flex items-center justify-center rounded-lg">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}
              <SyncTabs
                syncStatus={status}
                onRefresh={refresh}
                onSyncComplete={handleSyncComplete}
                onBulkActionStateChange={setBulkState}
              />
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {/* Bulk Actions - left side */}
          <div className="flex items-center gap-2 flex-wrap flex-1">
            {bulkState && bulkState.selectableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={bulkState.onSelectAll}
                disabled={bulkState.isSyncing}
              >
                <CheckSquare className="h-3.5 w-3.5 mr-1.5" />
                {bulkState.selectedCount === bulkState.selectableCount ? t('deselect') : t('selectAll')}
              </Button>
            )}

            {bulkState && bulkState.pushableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={bulkState.onPushSelected}
                disabled={bulkState.isSyncing}
              >
                <ArrowUp className="h-3.5 w-3.5 mr-1.5" />
                {t('pushCount', { count: bulkState.pushableCount })}
              </Button>
            )}

            {bulkState && bulkState.pullableCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={bulkState.onPullSelected}
                disabled={bulkState.isSyncing}
              >
                <ArrowDown className="h-3.5 w-3.5 mr-1.5" />
                {t('pullCount', { count: bulkState.pullableCount })}
              </Button>
            )}
          </div>

          {/* Right side buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loading || refreshing}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${loading || refreshing ? 'animate-spin' : ''}`} />
              {tc('actions.refresh')}
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {tc('actions.close')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
