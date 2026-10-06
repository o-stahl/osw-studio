'use client';

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';
import {
  LayoutGrid, FileText, Layers, Palette, DollarSign,
  Shield, Database, Settings as SettingsIcon, Mail, Plug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { hasAnyConnectedProvider } from '@/lib/llm/providers/connection-status';
import { useStudioView } from '@/components/view-mode-provider';
import { ModelsPane } from '@/components/providers-models/models-pane';
import { ConnectionsPane } from '@/components/providers-models/connections-pane';
import { TemplatesPane } from '@/components/providers-models/templates-pane';
import { AppearancePane } from '@/components/settings/appearance-pane';
import { CostTrackingPane } from '@/components/settings/cost-tracking-pane';
import { PermissionsPane } from '@/components/settings/permissions-pane';
import { DataPane } from '@/components/settings/data-pane';
import { McpPane } from '@/components/settings/mcp-pane';
import { PageShell, PageHeader, PageBody } from '@/components/ui/page-shell';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { MailView } from '@/components/views/mail-view';
import { UsersView } from '@/components/views/users-view';
import { Users as UsersIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Pane registry
// ---------------------------------------------------------------------------

export type SettingsPane =
  | 'connections'
  | 'models'
  | 'templates'
  | 'appearance'
  | 'costs'
  | 'permissions'
  | 'data'
  | 'mcp'
  | 'mail'
  | 'users';

interface PaneDef {
  id: SettingsPane;
  label: string;
  icon: React.ReactNode;
  /** Mail needs an instance behind it, and a workspace to scope the settings to. */
  serverModeOnly?: boolean;
  /** Administering members is the workspace owner's, not every member's. */
  ownerOnly?: boolean;
  /**
   * Hidden in the simple view.
   *
   * The test is whether someone can finish their own editing loop without it, not whether it looks
   * advanced: Connections and Models stay, because a person who cannot choose a provider or a model
   * cannot use the thing at all.
   */
  studioOnly?: boolean;
}

const PANES: PaneDef[] = [
  { id: 'connections', label: 'Connections',   icon: <FileText className="size-4 shrink-0" /> },
  { id: 'models',      label: 'Models',        icon: <LayoutGrid className="size-4 shrink-0" /> },
  { id: 'templates',   label: 'Templates',     icon: <Layers className="size-4 shrink-0" /> },
  { id: 'appearance',  label: 'Appearance',    icon: <Palette className="size-4 shrink-0" /> },
  { id: 'costs',       label: 'Cost Tracking', icon: <DollarSign className="size-4 shrink-0" /> },
  { id: 'permissions', label: 'Permissions',   icon: <Shield className="size-4 shrink-0" /> },
  { id: 'data',        label: 'Data',          icon: <Database className="size-4 shrink-0" /> },
  { id: 'mcp', label: 'MCP', icon: <Plug className="size-4 shrink-0" />, serverModeOnly: true, studioOnly: true },
  { id: 'mail',        label: 'Mail',          icon: <Mail className="size-4 shrink-0" />, serverModeOnly: true, studioOnly: true },
  { id: 'users',       label: 'Users',         icon: <UsersIcon className="size-4 shrink-0" />, serverModeOnly: true, ownerOnly: true },
];

/**
 * The panes this install can actually show.
 *
 * Mail is workspace-scoped: it reads and writes `/api/w/{id}/mail`, and an admin additionally gets
 * the instance tier inside the same view. Without a workspace there is nothing for it to edit, so it
 * is hidden rather than shown empty.
 */
/**
 * Every pane id, for anything that has to recognise one without deciding whether to show it.
 *
 * Derived rather than restated: the URL parser used to keep its own list, so a pane added here was
 * silently rejected there and the deep link fell back to the first pane.
 */
export const SETTINGS_PANE_IDS: readonly SettingsPane[] = PANES.map((p) => p.id);

export function visiblePanes(workspaceId: string | undefined, isOwner: boolean | null, studioView: boolean): PaneDef[] {
  const serverMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  return PANES.filter(
    (p) =>
      (!p.serverModeOnly || (serverMode && !!workspaceId)) &&
      // Null while the answer is still in flight, which shows it rather than blinking it away from
      // an owner who is entitled to it.
      (!p.ownerOnly || isOwner !== false) &&
      (!p.studioOnly || studioView)
  );
}

// ---------------------------------------------------------------------------
// Pane content
// ---------------------------------------------------------------------------

function PaneContent({ pane, workspaceId }: { pane: SettingsPane; workspaceId?: string }) {
  switch (pane) {
    case 'connections': return <ConnectionsPane />;
    case 'models':      return <ModelsPane />;
    case 'templates':   return <TemplatesPane />;
    case 'appearance':  return <AppearancePane />;
    case 'costs':       return <CostTrackingPane />;
    case 'permissions': return <PermissionsPane />;
    case 'data':        return <DataPane />;
    case 'mcp': return <McpPane workspaceId={workspaceId} />;
    case 'mail':        return <MailView workspaceId={workspaceId} />;
    case 'users':       return <UsersView workspaceId={workspaceId} embedded />;
  }
}

// ---------------------------------------------------------------------------
// Sidebar nav (shared between modal and inline modes)
// ---------------------------------------------------------------------------

/**
 * The pane labels, translated.
 *
 * PANES is a module constant, so it cannot call a hook; the labels are looked up by id where they
 * render and the constant's own label stays as the fallback. MCP is absent on purpose, being an
 * acronym rather than a word to translate.
 */
function usePaneLabels(): Record<string, string> {
  const t = useTranslations('nav.settings');
  const tc = useTranslations('common');

  return useMemo(() => ({
    connections: t('connections'),
    models: tc('terms.models'),
    templates: tc('terms.templates'),
    appearance: t('appearance'),
    costs: t('costs'),
    permissions: t('permissions'),
    data: t('data'),
    mail: t('mail'),
    users: t('users'),
  }), [t, tc]);
}

function SettingsNav({
  activePane,
  onChange,
  workspaceId,
  isOwner,
}: {
  activePane: SettingsPane;
  onChange: (pane: SettingsPane) => void;
  workspaceId?: string;
  isOwner?: boolean | null;
}) {
  const paneLabels = usePaneLabels();
  const studioView = useStudioView();
  const panes = visiblePanes(workspaceId, isOwner ?? null, studioView);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const m = measureRef.current;
      if (!c || !m) return;
      setCollapsed(m.scrollWidth + 8 > c.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const active = panes.find((p) => p.id === activePane) ?? panes[0];

  return (
    <nav ref={containerRef} className="shrink-0 md:flex md:flex-col md:gap-0.5 md:border-r border-border/60 md:py-6 md:pl-6 md:pr-3 md:w-48">
      {/* Hidden measurer for inline button row */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap md:hidden"
      >
        {panes.map((item) => (
          <span key={item.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            {item.icon}
            {paneLabels[item.id] ?? item.label}
          </span>
        ))}
      </div>

      {/* Mobile: dropdown or inline buttons */}
      <div className="md:hidden p-3 border-b border-border/60">
        {collapsed ? (
          <Select value={activePane} onValueChange={(v) => onChange(v as SettingsPane)}>
            <SelectTrigger className="w-full">
              <span className="flex items-center gap-2 text-sm">
                {active.icon}
                {paneLabels[active.id] ?? active.label}
              </span>
            </SelectTrigger>
            <SelectContent>
              {panes.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className="flex items-center gap-2">
                    {item.icon}
                    {paneLabels[item.id] ?? item.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex gap-1.5 overflow-x-auto">
            {panes.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange(item.id)}
                style={activePane === item.id ? { backgroundColor: 'var(--sidebar-active-surface)' } : undefined}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-medium transition-colors select-none whitespace-nowrap shrink-0',
                  activePane === item.id
                    ? 'text-foreground font-semibold'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {item.icon}
                <span>{paneLabels[item.id] ?? item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: sidebar buttons */}
      <div className="hidden md:flex md:flex-col md:gap-0.5">
        {panes.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            style={activePane === item.id ? { backgroundColor: 'var(--sidebar-active-surface)' } : undefined}
            className={cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-full text-[13px] font-medium transition-colors select-none whitespace-nowrap w-full text-left',
              activePane === item.id
                ? 'text-foreground font-semibold'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {item.icon}
            <span>{paneLabels[item.id] ?? item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// UnifiedSettings — the main export
// ---------------------------------------------------------------------------

export interface UnifiedSettingsProps {
  /** Which pane to show initially. Defaults to connections (or models if connected). */
  initialPane?: SettingsPane;
  /** When true, renders its own left-nav sidebar (for modal usage). */
  showSidebar?: boolean;
  /** Controlled active pane from external navigation (sidebar sub-items). */
  activePane?: SettingsPane;
  /** Scopes the workspace-only panes. Without it those panes are not offered. */
  workspaceId?: string;
}

export function UnifiedSettings({
  initialPane,
  showSidebar = false,
  activePane: controlledPane,
  workspaceId,
}: UnifiedSettingsProps) {
  const paneLabels = usePaneLabels();
  const tc = useTranslations('common');
  // Owners administer their own members; an instance admin does so in every workspace.
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
      setIsOwner(false);
      return;
    }
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const roles = data?.user?.workspaceRoles as Record<string, string> | undefined;
        setIsOwner(data?.user?.isAdmin === true || (!!workspaceId && roles?.[workspaceId] === 'owner'));
      })
      .catch(() => setIsOwner(false));
  }, [workspaceId]);
  const defaultPane = initialPane ?? (hasAnyConnectedProvider() ? 'models' : 'connections');
  const [internalPane, setInternalPane] = useState<SettingsPane>(defaultPane);

  const currentPane = controlledPane ?? internalPane;

  useEffect(() => {
    configManager.migrateModels();
  }, []);

  // Sync internal state when controlled pane changes
  useEffect(() => {
    if (controlledPane) setInternalPane(controlledPane);
  }, [controlledPane]);

  if (showSidebar) {
    return (
      <div className="flex flex-col md:flex-row h-full min-h-0">
        <SettingsNav activePane={currentPane} onChange={setInternalPane} workspaceId={workspaceId} isOwner={isOwner} />
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-4 md:p-6">
          <PaneContent pane={currentPane} workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  const activeLabel = paneLabels[currentPane] ?? PANES.find((p) => p.id === currentPane)?.label ?? '';

  return (
    <PageShell>
      <PageHeader title={tc('terms.settings')} maxWidth="max-w-4xl">
        <span className="text-lg font-normal text-muted-foreground">· {activeLabel}</span>
      </PageHeader>
      <PageBody maxWidth="max-w-4xl">
        <PaneContent pane={currentPane} workspaceId={workspaceId} />
      </PageBody>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// UnifiedSettingsModal — for workspace / chat panel usage
// ---------------------------------------------------------------------------

export interface UnifiedSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPane?: SettingsPane;
}

export function UnifiedSettingsModal({
  open,
  onOpenChange,
  initialPane = 'connections',
}: UnifiedSettingsModalProps) {
  const tc = useTranslations('common');
  const handleOpenChange = useCallback((v: boolean) => onOpenChange(v), [onOpenChange]);

  return (
    <>
      {/* Our own backdrop: a non-modal dialog gets no Radix overlay. */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => handleOpenChange(false)}
        />,
        document.body
      )}
    <Dialog open={open} onOpenChange={handleOpenChange} modal={false}>
      <DialogContent
        className="sm:max-w-4xl w-[calc(100vw-1.5rem)] max-w-none sm:w-auto p-0 gap-0 overflow-hidden"
        style={{ display: 'flex', flexDirection: 'column', height: 'min(90vh, calc(100dvh - 3rem))' }}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => {
          // Non-modal on purpose. The connections drawer is portaled to <body>, so a modal
          // dialog's focus trap pulls focus straight back out of its inputs (they take a click
          // but no typing) and react-remove-scroll cancels wheel events over it. Closing is
          // handled by the backdrop and Escape instead.
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          // The drawer is a separate fixed layer; interacting with it is not an outside click.
          const original = (e as unknown as { detail?: { originalEvent?: Event } }).detail?.originalEvent;
          const target = (original?.target ?? e.target) as Element | null;
          if (target?.closest?.('[data-models-drawer]')) e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{tc('terms.settings')}</DialogTitle>
        <div className="flex items-center gap-2 px-6 py-4 border-b shrink-0">
          <SettingsIcon className="h-4 w-4" />
          <h2 className="font-semibold text-base">{tc('terms.settings')}</h2>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <UnifiedSettings initialPane={initialPane} showSidebar />
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

// Re-export pane type for sidebar routing
export { PANES as SETTINGS_PANES };
