'use client';

import React, { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Project } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/ui/logo';
import {
  FolderOpen,
  Globe,
  Users,
  LayoutTemplate,
  ClipboardList,
  Sparkles,
  Settings,
  Info,
  TestTube,
  Github,
  BookOpen,
  ChevronDown,
  Cloud,
  LogOut,
  LayoutDashboard,
  UserCircle,
  FileText,
  LayoutGrid,
  Layers,
  Palette,
  DollarSign,
  Shield,
  Database,
  Mail,
  Plug,
  CircleHelp,
  Languages,
  MessagesSquare,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { DOCS_ITEMS } from '@/lib/constants/docs';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useProjectSyncState } from '@/lib/hooks/use-project-sync-state';
import { useRouter, useSearchParams } from 'next/navigation';
import pkg from '@/package.json';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { getExternalAccountUrl } from '@/lib/config/deployment-mode';
import { useStudioView } from '@/components/view-mode-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LanguageMenu } from '@/components/language-menu';
import { MenuPill } from '@/components/ui/menu-pill';
import { useViewNames } from '@/lib/i18n/use-view-names';
import { DISCUSSIONS_URL, REPO_URL } from '@/lib/constants/links';

// Collapsed sidebar width
export const COLLAPSED_SIDEBAR_WIDTH = 56; // Width in pixels for icon-only buttons

interface SidebarItem {
  id: string;
  label: string;
  icon: React.ElementType;
  path?: string;
  action?: string;
  href?: string;
  serverModeOnly?: boolean;
  adminOnly?: boolean;
  /** Shown to a workspace owner, who administers their own members. */
  ownerOnly?: boolean;
  /** Hidden in the simple view, which is projects and deployments and nothing else. */
  studioOnly?: boolean;
  hasRecentProjects?: boolean;
  subItems?: {
    id: string;
    label: string;
    icon: React.ElementType;
    /** Hidden in the simple view, like the top-level flag of the same name. */
    studioOnly?: boolean;
    /** Shown to a workspace owner, like the top-level flag of the same name. */
    ownerOnly?: boolean;
    file?: string; // For docs
    /** Hidden in browser mode, like the top-level flag of the same name. */
    serverModeOnly?: boolean;
  }[];
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: 'dashboard' },
  { id: 'projects', label: 'Projects', icon: FolderOpen, path: 'projects', hasRecentProjects: true },
  { id: 'deployments', label: 'Deployments', icon: Globe, path: 'deployments', serverModeOnly: true },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate, path: 'templates', studioOnly: true },
  { id: 'skills', label: 'Skills', icon: Sparkles, path: 'skills', studioOnly: true },
  { id: 'interviews', label: 'Interviews', icon: ClipboardList, path: 'interviews', studioOnly: true },
  {
    id: 'docs',
    label: 'Docs',
    icon: BookOpen,
    path: 'docs',
    subItems: DOCS_ITEMS.map(doc => ({
      id: doc.id,
      label: doc.title,
      icon: doc.icon,
      file: doc.file,
    }))
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    path: 'settings',
    subItems: [
      { id: 'connections', label: 'Connections', icon: FileText },
      { id: 'models', label: 'Models', icon: LayoutGrid },
      { id: 'templates', label: 'Templates', icon: Layers, studioOnly: true },
      { id: 'appearance', label: 'Appearance', icon: Palette },
      { id: 'costs', label: 'Cost Tracking', icon: DollarSign },
      { id: 'permissions', label: 'Permissions', icon: Shield, studioOnly: true },
      { id: 'data', label: 'Data', icon: Database },
      { id: 'mcp', label: 'MCP', icon: Plug, serverModeOnly: true, studioOnly: true },
      { id: 'mail', label: 'Mail', icon: Mail, serverModeOnly: true, studioOnly: true },
      { id: 'users', label: 'Users', icon: Users, serverModeOnly: true, ownerOnly: true },
    ]
  },
  { id: 'tester', label: 'Benchmark', icon: TestTube, path: '/test-generation', studioOnly: true },
];

const ACCOUNT_URL = getExternalAccountUrl();

const SYSTEM_ACTIONS: SidebarItem[] = [
  { id: 'sync', label: 'Server Sync', icon: Cloud, action: 'server-sync' },
  ...(ACCOUNT_URL ? [{ id: 'account', label: 'Account', icon: UserCircle, href: ACCOUNT_URL }] : []),
  { id: 'logout', label: 'Logout', icon: LogOut, action: 'logout' },
];

/**
 * The nav labels, translated.
 *
 * SIDEBAR_ITEMS and DOCS_ITEMS are module-level constants, so they cannot call a hook. Rather than
 * translate at each of the ten places a label is rendered, the arrays are mapped once here and the
 * render sites keep reading `item.label`.
 *
 * Every key is written out as a literal call because typed messages reject a computed key, and the
 * English array stays the fallback: an id with no entry, such as a brand name, keeps its own label
 * rather than rendering a key path. That is why MCP is absent below.
 */
function useNavLabels() {
  const t = useTranslations();
  const viewNames = useViewNames();

  return useMemo(() => ({
    items: {
      ...viewNames,
      tester: t('nav.items.tester'),
      sync: t('nav.items.sync'),
      account: t('common.labels.account'),
      logout: t('nav.items.logout'),
    } as Record<string, string>,
    settings: {
      connections: t('nav.settings.connections'),
      models: t('common.terms.models'),
      templates: t('common.terms.templates'),
      appearance: t('nav.settings.appearance'),
      costs: t('nav.settings.costs'),
      permissions: t('nav.settings.permissions'),
      data: t('nav.settings.data'),
      mail: t('nav.settings.mail'),
      users: t('nav.settings.users'),
    } as Record<string, string>,
    docs: {
      'whats-new': t('nav.docs.whats-new'),
      overview: t('nav.docs.overview'),
      'getting-started': t('nav.docs.getting-started'),
      projects: t('common.terms.projects'),
      'working-with-ai': t('nav.docs.working-with-ai'),
      templates: t('common.terms.templates'),
      skills: t('common.terms.skills'),
      'deploying-sites': t('nav.docs.deploying-sites'),
      'server-mode': t('nav.docs.server-mode'),
      'vps-deployment': t('nav.docs.vps-deployment'),
      'site-publishing': t('nav.docs.site-publishing'),
      'custom-domains': t('nav.docs.custom-domains'),
      'backend-features': t('nav.docs.backend-features'),
      'mcp-server': t('nav.docs.mcp-server'),
      multitenancy: t('nav.docs.multitenancy'),
      faq: t('nav.docs.faq'),
      troubleshooting: t('nav.docs.troubleshooting'),
    } as Record<string, string>,
  }), [t, viewNames]);
}

function useTranslatedNav() {
  const labels = useNavLabels();

  return useMemo(() => {
    const translate = (items: SidebarItem[]): SidebarItem[] =>
      items.map((item) => ({
        ...item,
        label: labels.items[item.id] ?? item.label,
        subItems: item.subItems?.map((sub) => ({
          ...sub,
          label: (item.id === 'docs' ? labels.docs[sub.id] : labels.settings[sub.id]) ?? sub.label,
        })),
      }));

    return { items: translate(SIDEBAR_ITEMS), systemActions: translate(SYSTEM_ACTIONS) };
  }, [labels]);
}

// ---------------------------------------------------------------------------
// Flyout sub-menu (WP-style hover reveal for collapsed sections)
// ---------------------------------------------------------------------------

function SidebarFlyout({
  item,
  triggerRect,
  sidebarRight,
  recentProjects,
  loadingRecentProjects,
  studioView,
  isOwner,
  onSubItemClick,
  onMouseEnter,
  onMouseLeave,
}: {
  item: SidebarItem;
  triggerRect: DOMRect;
  sidebarRight: number;
  recentProjects: Project[];
  loadingRecentProjects: boolean;
  /** The collapsed sidebar's flyout has to hide the same sub-items the expanded one does. */
  studioView: boolean;
  isOwner: boolean | null;
  onSubItemClick: (parentItem: SidebarItem, subItem: { id: string; label: string; icon: React.ElementType; file?: string }) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const t = useTranslations();
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(triggerRect.top);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const labelH = labelRef.current?.offsetHeight ?? 0;
    const containerPadTop = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const offset = labelH + containerPadTop;
    const idealTop = triggerRect.top - offset;
    const h = el.getBoundingClientRect().height;
    const maxTop = window.innerHeight - h - 8;
    setTop(Math.max(8, Math.min(idealTop, maxTop)));
  }, [triggerRect.top]);

  return createPortal(
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-[60] bg-popover border rounded-lg shadow-lg py-1 min-w-[180px] max-w-[240px] max-h-[calc(100vh-1rem)] overflow-y-auto"
      style={{ left: sidebarRight + 4, top }}
    >
      <div ref={labelRef} className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {item.label}
      </div>

      {item.hasRecentProjects ? (
        loadingRecentProjects ? (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">{t('common.loading')}</div>
        ) : recentProjects.length > 0 ? (
          recentProjects.map(project => (
            <button
              key={project.id}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent rounded-sm transition-colors text-left"
              onClick={() => onSubItemClick(item, { id: project.id, label: project.name, icon: FolderOpen })}
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">{project.name}</span>
            </button>
          ))
        ) : (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">{t('sidebar.noRecentProjects')}</div>
        )
      ) : item.subItems ? (
        item.subItems
          .filter(si => !si.serverModeOnly || process.env.NEXT_PUBLIC_SERVER_MODE === 'true')
          .filter(si => !si.studioOnly || studioView)
          .filter(si => !si.ownerOnly || isOwner !== false)
          .map(subItem => {
          const SubIcon = subItem.icon;
          return (
            <button
              key={subItem.id}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent rounded-sm transition-colors text-left"
              onClick={() => onSubItemClick(item, subItem)}
            >
              <SubIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{subItem.label}</span>
            </button>
          );
        })
      ) : null}
    </div>,
    document.body
  );
}

interface SidebarProps {
  currentView: string;
  workspaceId?: string;
  onNavigate: (view: string) => void;
  onProjectSelect: (project: Project) => void;
  onStartTour?: () => void;
  onOpenAbout?: () => void;
  onOpenSettings?: () => void;
  onServerSync?: () => void;
  onPinnedChange?: (pinned: boolean) => void;
  onHoverChange?: (hovering: boolean) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}

function SidebarContent({
  currentView,
  workspaceId,
  onNavigate,
  onProjectSelect,
  onStartTour,
  onOpenAbout,
  onOpenSettings,
  onServerSync,
  onPinnedChange,
  onHoverChange,
  onCollapsedChange,
  mobileOpen = false,
  onMobileOpenChange,
}: SidebarProps) {
  const t = useTranslations('sidebar');
  const tn = useTranslations('nav');
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentDocId = searchParams.get('doc');
  const currentSettingsTab = searchParams.get('settings');
  const [pinned, setPinned] = useState(true); // Pinned = sidebar stays expanded
  const [hovering, setHovering] = useState(false);
  const sidebarExpandingRef = useRef(false);
  const pendingFlyoutRef = useRef<{ itemId: string; el: HTMLElement } | null>(null);
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loadingRecentProjects, setLoadingRecentProjects] = useState(true);

  // Initialize expandedItems based on currentView to prevent flash
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (currentView === 'docs') initial.add('docs');
    if (currentView === 'projects') initial.add('projects');
    if (currentView === 'settings') initial.add('settings');
    return initial;
  });

  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  // Read-only: the gallery owns refreshing this, so the sidebar adds no extra request.
  const { pendingCount } = useProjectSyncState();
  const isDesktop = process.env.NEXT_PUBLIC_DESKTOP === 'true';
  const [isAdmin, setIsAdmin] = useState<boolean | null>(isServerMode ? null : false);
  // Null until /api/auth/me answers. Both are read as "not yet known" rather than false, so a
  // reload does not blink the full menu at someone in the simple view, or hide Users from an owner.
  const [isWorkspaceOwner, setIsWorkspaceOwner] = useState<boolean | null>(isServerMode ? null : false);
  // Server-seeded, so the first HTML already carries the right menu and there is nothing to correct
  // after hydration.
  const studioView = useStudioView();

  useEffect(() => {
    if (!isServerMode) return;

    // Admin and owner status only, which a view change does not affect. The view itself comes from
    // the server-seeded context, which refreshes itself.
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(data => {
      setIsAdmin(data?.user?.isAdmin ?? false);
      const roles = data?.user?.workspaceRoles as Record<string, string> | undefined;
      setIsWorkspaceOwner(workspaceId ? roles?.[workspaceId] === 'owner' : false);
    }).catch(() => {
      setIsAdmin(false);
      setIsWorkspaceOwner(false);
    });
  }, [isServerMode, workspaceId]);

  // Track if we're on mobile (client-side only)
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Collapsed state is derived: collapsed when not pinned AND not hovering (desktop only)
  // On mobile, sidebar is never collapsed - it's either open or closed via mobileOpen
  // An open footer menu keeps an unpinned sidebar open, so the menu never loses its trigger. The
  // menus are non-modal: a modal one stops pointer events on the page, so the sidebar never hears
  // the pointer leave and stays open after the menu closes. On close, the pointer decides.
  const [footerMenuOpen, setFooterMenuOpen] = useState(false);
  const handleFooterMenuOpenChange = (open: boolean) => {
    setFooterMenuOpen(open);
    if (!open && !isMobile && !pinned && !sidebarRef.current?.matches(':hover')) setHovering(false);
  };
  const collapsed = !isMobile && !pinned && !hovering && !footerMenuOpen;

  const ts = useTranslations('settings');

  // Auto-expand items when on their view
  useEffect(() => {
    if (currentView === 'docs') {
      setExpandedItems(prev => new Set(prev).add('docs'));
    }
    if (currentView === 'projects') {
      setExpandedItems(prev => new Set(prev).add('projects'));
    }
    if (currentView === 'settings') {
      setExpandedItems(prev => new Set(prev).add('settings'));
    }
  }, [currentView]);

  // Load recent projects
  useEffect(() => {
    async function loadRecentProjects() {
      try {
        await vfs.init();
        const projects = await vfs.listProjects();
        const sorted = projects.sort((a, b) =>
          b.updatedAt.getTime() - a.updatedAt.getTime()
        );
        setRecentProjects(sorted.slice(0, 3));
      } catch (error) {
        console.error('Failed to load recent projects:', error);
      } finally {
        setLoadingRecentProjects(false);
      }
    }
    loadRecentProjects();
  }, []);

  // Load pinned state from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('osw-admin-sidebar-pinned');
    if (stored !== null) {
      setPinned(stored === 'true');
    }
  }, []);

  // Toggle pinned state
  const togglePinned = () => {
    const newState = !pinned;
    setPinned(newState);
    localStorage.setItem('osw-admin-sidebar-pinned', String(newState));
    onPinnedChange?.(newState);
  };

  // Mouse enter/leave handlers (desktop only)
  const handleMouseEnter = () => {
    if (!isMobile && !pinned) {
      sidebarExpandingRef.current = true;
      setHovering(true);
    }
  };

  const handleMouseLeave = () => {
    if (!isMobile && !pinned) {
      pendingFlyoutRef.current = null;
      setHovering(false);
    }
  };

  // The layout darkens the page while the unpinned sidebar is open over it. An open footer menu
  // keeps it open (see `footerMenuOpen`), so it keeps the backdrop too.
  useEffect(() => {
    onHoverChange?.(!isMobile && !pinned && (hovering || footerMenuOpen));
  }, [isMobile, pinned, hovering, footerMenuOpen, onHoverChange]);

  // Notify parent of initial pinned state
  useEffect(() => {
    onPinnedChange?.(pinned);
  }, [pinned, onPinnedChange]);

  // Notify parent of collapsed state
  useEffect(() => {
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  // Filter sidebar items based on Server Mode
  const { items: navItems, systemActions } = useTranslatedNav();
  const visibleSidebarItems = navItems.filter(
    item =>
      (!item.serverModeOnly || isServerMode) &&
      (!item.adminOnly || isAdmin !== false) &&
      // An instance admin administers every workspace, so they see Users wherever they are.
      (!item.ownerOnly || isWorkspaceOwner !== false || isAdmin === true) &&
      (!item.studioOnly || studioView)
  );

  const toggleExpanded = (itemId: string) => {
    setExpandedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  // --- Flyout sub-menu state ---
  const [flyoutItemId, setFlyoutItemId] = useState<string | null>(null);
  const [flyoutTriggerRect, setFlyoutTriggerRect] = useState<DOMRect | null>(null);
  const flyoutTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const showFlyout = useCallback((itemId: string, el: HTMLElement) => {
    clearTimeout(flyoutTimerRef.current);
    setFlyoutItemId(itemId);
    setFlyoutTriggerRect(el.getBoundingClientRect());
  }, []);

  const hideFlyout = useCallback(() => {
    flyoutTimerRef.current = setTimeout(() => {
      setFlyoutItemId(null);
      setFlyoutTriggerRect(null);
    }, 150);
  }, []);

  const cancelFlyoutHide = useCallback(() => {
    clearTimeout(flyoutTimerRef.current);
  }, []);

  useEffect(() => () => clearTimeout(flyoutTimerRef.current), []);

  useEffect(() => {
    if (flyoutItemId && expandedItems.has(flyoutItemId)) {
      setFlyoutItemId(null);
      setFlyoutTriggerRect(null);
    }
  }, [expandedItems, flyoutItemId]);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'width' && e.target === el) {
        sidebarExpandingRef.current = false;
        const pending = pendingFlyoutRef.current;
        if (pending) {
          pendingFlyoutRef.current = null;
          showFlyout(pending.itemId, pending.el);
        }
      }
    };
    el.addEventListener('transitionend', onTransitionEnd);
    return () => el.removeEventListener('transitionend', onTransitionEnd);
  }, [showFlyout]);

  const handleSubItemClick = useCallback((parentItem: SidebarItem, subItem: { id: string; label: string; icon: React.ElementType; file?: string }) => {
    setFlyoutItemId(null);
    setFlyoutTriggerRect(null);
    onMobileOpenChange?.(false);
    if (parentItem.hasRecentProjects) {
      const project = recentProjects.find(p => p.id === subItem.id);
      if (project) onProjectSelect(project);
      return;
    }
    if (isServerMode) {
      const subBase = workspaceId ? `/w/${workspaceId}` : '/admin';
      if (subItem.file) {
        router.push(`${subBase}/docs?doc=${subItem.id}`);
      } else {
        router.push(`${subBase}/${parentItem.id}?settings=${subItem.id}`);
      }
    } else {
      if (subItem.file) {
        router.push(`/?doc=${subItem.id}`);
        onNavigate(parentItem.id);
      } else if (parentItem.id === 'settings') {
        router.push(`/?settings=${subItem.id}`);
        onNavigate(parentItem.id);
      } else {
        router.push('/');
        onNavigate(parentItem.id);
      }
    }
  }, [isServerMode, workspaceId, router, onNavigate, onMobileOpenChange, onProjectSelect, recentProjects]);

  const flyoutItem = flyoutItemId ? visibleSidebarItems.find(i => i.id === flyoutItemId) ?? null : null;

  const brand = (
    <>
      <Logo width={24} height={24} className="flex-shrink-0" />
      {!collapsed && (
        <div className="flex flex-col">
          <span className="text-sm font-semibold whitespace-nowrap leading-none">
            Open{'\u00A0'}Source Web{'\u00A0'}Studio
          </span>
          <span className="text-[10px] leading-[10px] text-muted-foreground text-left mt-0.5">
            {isServerMode ? t('serverBuild', { version: pkg.version }) : `v${pkg.version}`}
          </span>
        </div>
      )}
    </>
  );

  const handleItemAction = async (item: SidebarItem) => {
    // Close mobile menu when action is triggered
    onMobileOpenChange?.(false);

    if (item.href) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
    } else if (item.path) {
      // Check if path is absolute (starts with /)
      if (item.path.startsWith('/')) {
        router.push(item.path);
      } else if (isServerMode) {
        // Workspaces stays instance-wide; users is workspace-scoped, with the instance tier
        // rendered inside the same page for an admin.
        const systemItems = ['workspaces'];
        if (systemItems.includes(item.id)) {
          router.push(`/admin/${item.path}`);
        } else if (workspaceId) {
          router.push(`/w/${workspaceId}/${item.path}`);
        } else {
          router.push(`/admin/${item.path}`);
        }
      } else {
        // Browser Mode: Use router.push to clear query params when navigating away from docs
        router.push('/');
        onNavigate(item.id);
      }
    } else if (item.action === 'open-settings' && onOpenSettings) {
      onOpenSettings();
    } else if (item.action === 'server-sync' && onServerSync) {
      onServerSync();
    } else if (item.action === 'logout') {
      try {
        const response = await fetch('/api/auth/logout', { method: 'POST' });
        if (response.ok) {
          router.push('/admin/login');
        }
      } catch (error) {
        console.error('Logout failed:', error);
      }
    }
  };

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => onMobileOpenChange?.(false)}
        />
      )}

      <div
        ref={sidebarRef}
        className={cn(
          'flex flex-col h-screen bg-card transition-all duration-300',
          // Border: left on mobile (slides from right), right on desktop (stays on left)
          'border-l md:border-l-0 md:border-r',
          // Desktop behavior - always on left
          'md:relative md:left-0',
          pinned ? 'md:relative' : 'md:absolute md:left-0 md:top-0 md:z-40 md:shadow-lg',
          // Mobile behavior - slide in from right, fixed 240px width
          'fixed right-0 top-0 z-50 w-60',
          // Desktop - 240px when expanded, or collapsed width
          collapsed ? '' : 'md:w-60',
          // Mobile: slide from right. Desktop: always visible
          mobileOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'
        )}
        style={{
          // Apply collapsed width when needed
          width: collapsed ? `${COLLAPSED_SIDEBAR_WIDTH}px` : undefined,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
      {/* Logo/Brand. On mobile it also closes the sidebar; pinning lives in the footer. */}
      {isMobile ? (
        <button
          type="button"
          onClick={() => onMobileOpenChange?.(false)}
          className="p-3 border-b flex items-center gap-3 h-[54px] overflow-hidden w-full hover:bg-accent/50 transition-colors cursor-pointer"
        >
          {brand}
        </button>
      ) : (
        <div className={cn('p-3 border-b flex items-center gap-3 h-[54px] overflow-hidden w-full', collapsed && 'justify-center')}>
          {brand}
        </div>
      )}

      {isServerMode && !collapsed && (
        <WorkspaceSwitcher workspaceId={workspaceId} />
      )}

      {/* Main Navigation - Single scrollable container */}
      {/* Padding is split between this and the per-item wrapper below so the two together match the
          sections underneath, which get 8px from p-2 and 4px between rows from space-y-1: 6+2 = 8px
          to the first button, and 2+2 = 4px between them. The wrapper cannot give up its vertical
          padding to simplify this, since that padding is what stops a row jumping when it expands. */}
      <nav className="flex-1 px-1 py-1.5 overflow-y-auto">
        {visibleSidebarItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          const hasSubItems = (item.subItems && item.subItems.length > 0) || item.hasRecentProjects;
          const isExpanded = expandedItems.has(item.id);

          return (
            <div key={item.id}>
              {/* Wrap parent + children in container - always has padding to prevent layout shift */}
              <div className={cn(
                'px-1 py-0.5',
                isExpanded && hasSubItems && 'bg-muted rounded-2xl'
              )}>
                <div
                  className="relative"
                  onMouseEnter={(e) => {
                    if (!isMobile && hasSubItems && !isExpanded) {
                      if (sidebarExpandingRef.current) {
                        pendingFlyoutRef.current = { itemId: item.id, el: e.currentTarget };
                      } else {
                        showFlyout(item.id, e.currentTarget);
                      }
                    }
                  }}
                  onMouseLeave={() => {
                    if (pendingFlyoutRef.current?.itemId === item.id) pendingFlyoutRef.current = null;
                    if (flyoutItemId === item.id) hideFlyout();
                  }}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    style={isActive && !hasSubItems ? { backgroundColor: 'var(--sidebar-active-surface)' } : undefined}
                    className={cn(
                      'w-full',
                      collapsed ? 'justify-center px-2' : 'justify-start',
                      !collapsed && hasSubItems && 'pr-8',
                      isActive && !hasSubItems && 'font-semibold'
                    )}
                    onClick={() => {
                      if (!hasSubItems || currentView !== item.id) {
                        handleItemAction(item);
                      }
                    }}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon className={cn('h-4 w-4', !collapsed && 'mr-2')} />
                    {!collapsed && item.label}
                  </Button>
                  {!collapsed && hasSubItems && (
                    <button
                      className={cn(
                        'absolute right-2 top-1/2 -translate-y-1/2',
                        'p-1 rounded hover:bg-accent transition-colors'
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleExpanded(item.id);
                      }}
                    >
                      <ChevronDown
                        className={cn(
                          'h-4 w-4 transition-transform',
                          isExpanded && 'rotate-180'
                        )}
                      />
                    </button>
                  )}
                </div>

              {/* Recent Projects Sub-items (for Projects item) */}
              {item.hasRecentProjects && isExpanded && (
                <div className={cn(
                  "mt-1 space-y-1",
                  collapsed ? "flex flex-col items-center" : "ml-4"
                )}>
                  {loadingRecentProjects ? (
                    // Skeleton loaders
                    <>
                      {[1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className={cn(
                            "flex items-center gap-2",
                            collapsed ? "justify-center p-1" : "h-8 px-2"
                          )}
                        >
                          <div className="h-3 w-3 bg-muted-foreground/20 rounded animate-pulse" />
                          {!collapsed && <div className="h-3 flex-1 bg-muted-foreground/20 rounded animate-pulse" />}
                        </div>
                      ))}
                    </>
                  ) : recentProjects.length > 0 ? (
                    // Actual projects
                    recentProjects.map((project) => (
                      <Button
                        key={project.id}
                        variant="ghost"
                        size="sm"
                        className={cn(
                          collapsed ? "w-8 h-8 p-0 justify-center" : "w-full justify-start text-xs"
                        )}
                        onClick={() => {
                          onMobileOpenChange?.(false);
                          onProjectSelect(project);
                        }}
                        title={project.name}
                      >
                        <FolderOpen className={cn("h-3 w-3 flex-shrink-0", !collapsed && "mr-2")} />
                        {!collapsed && <span className="truncate">{project.name}</span>}
                      </Button>
                    ))
                  ) : (
                    !collapsed && (
                      <div className="px-2 py-1 text-xs text-muted-foreground">
                        {t('noRecentProjects')}
                      </div>
                    )
                  )}
                </div>
              )}

              {/* Sub-items (for Docs and Settings) */}
              {item.subItems && isExpanded && (
                <div className={cn(
                  "mt-1 space-y-1",
                  collapsed ? "flex flex-col items-center" : "ml-4"
                )}>
                  {item.subItems
                    .filter(si => !si.serverModeOnly || isServerMode)
                    .filter(si => !si.studioOnly || studioView)
                    .filter(si => !si.ownerOnly || isWorkspaceOwner !== false || isAdmin === true)
                    .map((subItem) => {
                    const SubIcon = subItem.icon;
                    // For docs, check currentDocId. For settings, check URL param or path
                    const wsBase = workspaceId ? `/w/${workspaceId}` : '/admin';
                    const isSubItemActive = subItem.file
                      ? currentDocId === subItem.id
                      : item.id === 'settings'
                        ? currentSettingsTab === subItem.id
                        : (isServerMode && (window.location.pathname === `${wsBase}/${item.id}/${subItem.id}` || window.location.pathname === `/admin/${item.id}/${subItem.id}`));

                    return (
                      <Button
                        key={subItem.id}
                        variant={isSubItemActive ? 'default' : 'ghost'}
                        size="sm"
                        className={cn(
                          collapsed ? "w-8 h-8 p-0 justify-center" : "w-full justify-start text-xs"
                        )}
                        onClick={() => {
                          onMobileOpenChange?.(false);
                          if (isServerMode) {
                            const subBase = workspaceId ? `/w/${workspaceId}` : '/admin';
                            if (subItem.file) {
                              // Docs sub-item
                              router.push(`${subBase}/docs?doc=${subItem.id}`);
                            } else {
                              // Settings sub-item — the settings page reads the tab from
                              // ?settings=, there is no /settings/<tab> route (that 404s).
                              router.push(`${subBase}/${item.id}?settings=${subItem.id}`);
                            }
                          } else {
                            // Browser mode
                            if (subItem.file) {
                              // Docs sub-item - navigate to specific doc
                              router.push(`/?doc=${subItem.id}`);
                              onNavigate(item.id);
                            } else if (item.id === 'settings') {
                              // Settings sub-item - use query param
                              router.push(`/?settings=${subItem.id}`);
                              onNavigate(item.id);
                            } else {
                              // Other sub-items
                              router.push('/');
                              onNavigate(item.id);
                            }
                          }
                        }}
                        title={collapsed ? subItem.label : undefined}
                      >
                        <SubIcon className={cn("h-3 w-3", !collapsed && "mr-2")} />
                        {!collapsed && subItem.label}
                      </Button>
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          );
        })}
      </nav>

      {/* System Actions (Server Mode only) */}
      {isServerMode && (
        <div className="border-t p-2 space-y-1">
          {systemActions.filter(item => !(isDesktop && item.id === 'logout')).map((item) => {
            const Icon = item.icon;
            const isLogout = item.id === 'logout';

            if (item.href) {
              return (
                <Button
                  key={item.id}
                  asChild
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'w-full',
                    collapsed ? 'justify-center px-2' : 'justify-start'
                  )}
                  title={collapsed ? item.label : undefined}
                >
                  <a href={item.href}>
                    <Icon className={cn('h-4 w-4', !collapsed && 'mr-2')} />
                    {!collapsed && item.label}
                  </a>
                </Button>
              );
            }

            // Projects the server is missing or behind on. Shown here because Server Sync is
            // where the user resolves them, and nothing else made drift visible.
            const pendingBadge = item.id === 'sync' && pendingCount > 0;

            return (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                className={cn(
                  'w-full relative',
                  collapsed ? 'justify-center px-2' : 'justify-start',
                  isLogout && 'text-destructive hover:text-destructive hover:bg-destructive/10'
                )}
                onClick={() => handleItemAction(item)}
                title={collapsed ? (pendingBadge ? t('notSyncedTitle', { label: item.label, count: pendingCount }) : item.label) : undefined}
              >
                <Icon className={cn('h-4 w-4', !collapsed && 'mr-2')} />
                {!collapsed && item.label}
                {pendingBadge && (
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-medium',
                      collapsed
                        ? 'absolute top-1 right-1 h-4 min-w-4 px-1'
                        : 'ml-auto h-4 min-w-4 px-1'
                    )}
                    aria-label={t('notSyncedAria', { count: pendingCount })}
                  >
                    {pendingCount}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}

      {/* Pin, help and language. Collapsed, only the pin shows: hovering opens the sidebar. */}
      <div className={cn('border-t p-2 flex items-center gap-1', collapsed && 'justify-center')}>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'hidden md:flex h-7 rounded-full gap-1.5 text-xs text-foreground',
            collapsed ? 'w-7 p-0' : 'px-2.5'
          )}
          onClick={togglePinned}
          aria-label={pinned ? tn('unpinSidebar') : tn('pinSidebar')}
          title={pinned ? tn('unpinSidebar') : tn('pinSidebar')}
        >
          {pinned ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
          {!collapsed && (pinned ? tn('unpin') : tn('pin'))}
        </Button>
        {!collapsed && (
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu modal={false} onOpenChange={handleFooterMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <MenuPill icon={CircleHelp} aria-label={tn('help')} title={tn('help')} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" collisionPadding={8} className="min-w-48">
                {studioView && onStartTour && (
                  <DropdownMenuItem onSelect={() => { onMobileOpenChange?.(false); onStartTour(); }}>
                    <Sparkles className="h-4 w-4" />
                    {tn('items.tour')}
                  </DropdownMenuItem>
                )}
                {onOpenAbout && (
                  <DropdownMenuItem onSelect={() => { onMobileOpenChange?.(false); onOpenAbout(); }}>
                    <Info className="h-4 w-4" />
                    {tn('items.about')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href={DISCUSSIONS_URL} target="_blank" rel="noopener noreferrer">
                    <MessagesSquare className="h-4 w-4" />
                    <span className="flex-1">{tn('discussions')}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                    <Github className="h-4 w-4" />
                    <span className="flex-1">GitHub</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <LanguageMenu modal={false} align="end" onOpenChange={handleFooterMenuOpenChange}>
              <MenuPill icon={Languages} aria-label={ts('language.title')} title={ts('language.title')} />
            </LanguageMenu>
          </div>
        )}
      </div>
    </div>

      {/* Flyout sub-menu portal */}
      {flyoutItem && flyoutTriggerRect && !isMobile && (
        <SidebarFlyout
          item={flyoutItem}
          triggerRect={flyoutTriggerRect}
          sidebarRight={sidebarRef.current?.getBoundingClientRect().right ?? 0}
          recentProjects={recentProjects}
          loadingRecentProjects={loadingRecentProjects}
          studioView={studioView}
          isOwner={isWorkspaceOwner !== false || isAdmin === true}
          onSubItemClick={handleSubItemClick}
          onMouseEnter={cancelFlyoutHide}
          onMouseLeave={hideFlyout}
        />
      )}
    </>
  );
}

// Wrapper component with Suspense boundary for Next.js 15
/**
 * The top-level views the simple view does not offer.
 *
 * Derived from the same table the menu is built from, so a view whose `studioOnly` changes cannot be
 * hidden from the menu while something else still lands on it. An absolute `path` is a link out of
 * the app rather than a view it can land on, so those are left out.
 */
export const STUDIO_ONLY_VIEWS: readonly string[] = SIDEBAR_ITEMS
  .filter((item) => item.studioOnly && item.path && !item.path.startsWith('/'))
  .map((item) => item.path as string);

export function Sidebar(props: SidebarProps) {
  return (
    <Suspense fallback={<div className="w-full h-full bg-card" />}>
      <SidebarContent {...props} />
    </Suspense>
  );
}
