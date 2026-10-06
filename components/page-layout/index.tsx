'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useViewNames } from '@/lib/i18n/use-view-names';
import { Project } from '@/lib/vfs/types';
import { Sidebar } from '@/components/sidebar';
import { AppHeader } from '@/components/ui/app-header';
import { X } from 'lucide-react';
import { SyncDialog } from '@/components/project-manager/sync-dialog';
import { cn } from '@/lib/utils';
import { setAutoSyncWorkspaceId, fetchSyncStatus, pullConnectionsIntoCache } from '@/lib/vfs/auto-sync';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { refreshProjectSyncState } from '@/lib/vfs/project-sync-state';

interface PageLayoutProps {
  children: React.ReactNode;
  currentView: string;
  workspaceId?: string;
  onNavigate: (view: string) => void;
  onProjectSelect: (project: Project) => void;
  onStartTour?: () => void;
  onOpenAbout?: () => void;
  onOpenSettings?: () => void;
  showSidebar?: boolean; // false when in Workspace
}

export function PageLayout({
  children,
  currentView,
  workspaceId,
  onNavigate,
  onProjectSelect,
  onStartTour,
  onOpenAbout,
  onOpenSettings,
  showSidebar = true,
}: PageLayoutProps) {
  const [sidebarPinned, setSidebarPinned] = useState(true);
  const [sidebarHovering, setSidebarHovering] = useState(false);
  const [, setSidebarCollapsed] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [quotaWarning, setQuotaWarning] = useState<{ percent: number; used: number; max: number } | null>(null);
  const t = useTranslations();
  const viewNames: Record<string, string> = useViewNames();

  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';

  // Set workspace context for auto-sync and sync-manager, check quota
  useEffect(() => {
    if (workspaceId) {
      setAutoSyncWorkspaceId(workspaceId);
      getSyncManager(workspaceId);
      void pullConnectionsIntoCache();
    }

    if (!isServerMode || !showSidebar || !workspaceId) return;

    // Compute sync state here rather than in the sidebar: child effects run before parent effects,
    // so a sidebar-owned refresh would fire before setAutoSyncWorkspaceId above and request the
    // unscoped /api/sync/status, which does not exist. This also means the "not synced" count is
    // populated on every workspace page, not only after visiting Projects.
    void refreshProjectSyncState();

    async function checkQuota() {
      try {
        const data = await fetchSyncStatus();
        if (!data?.quota?.storage) return;
        const { usedMb, maxMb } = data.quota.storage;
        const percent = Math.round((usedMb / maxMb) * 100) / 100;
        if (percent >= 0.8) {
          setQuotaWarning({ percent, used: usedMb, max: maxMb });
        } else {
          setQuotaWarning(null);
        }
      } catch {}
    }
    checkQuota();
  }, [workspaceId, isServerMode, showSidebar]);

  // When in Workspace, don't show sidebar or header
  if (!showSidebar) {
    return <>{children}</>;
  }

  return (
    <div className="relative flex h-full overflow-hidden">
      <Sidebar
        currentView={currentView}
        workspaceId={workspaceId}
        onNavigate={onNavigate}
        onProjectSelect={onProjectSelect}
        onStartTour={onStartTour}
        onOpenAbout={onOpenAbout}
        onOpenSettings={onOpenSettings}
        onServerSync={() => setSyncDialogOpen(true)}
        onPinnedChange={setSidebarPinned}
        onHoverChange={setSidebarHovering}
        onCollapsedChange={setSidebarCollapsed}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
      />

      {/* Backdrop when sidebar is unpinned and hovering */}
      {!sidebarPinned && sidebarHovering && (
        <div className="absolute inset-0 bg-black/20 z-30" />
      )}

      <div
        className={cn(
          "flex-1 flex flex-col overflow-hidden transition-all duration-300",
          // On mobile, no margin (sidebar is overlay). On desktop, apply margin when unpinned
          !sidebarPinned && "md:ml-[56px]"
        )}
      >
        {/* Header - mobile only (logo + page name + hamburger) */}
        <AppHeader
          hideLogo={true}
          showMobileMenu={true}
          onMobileMenuClick={() => setMobileSidebarOpen(true)}
          hideActionsOnMobile={true}
          pageName={viewNames[currentView] ?? currentView}
          className="md:hidden"
        />
        {/* Content area */}
        <div className="flex-1 overflow-hidden">
          {quotaWarning && (
            <div className="bg-orange-500/10 border-b border-orange-500/20 px-4 py-2 text-sm text-orange-400 flex items-center justify-between">
              <span>{t('pageLayout.storageWarning', quotaWarning)}</span>
              <button
                onClick={() => setQuotaWarning(null)}
                aria-label={t('common.actions.dismiss')}
                className="text-orange-400/60 hover:text-orange-400 ml-4 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {children}
        </div>
      </div>

      {/* Sync Dialog */}
      <SyncDialog
        open={syncDialogOpen}
        onOpenChange={setSyncDialogOpen}
      />
    </div>
  );
}
