'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import {
  RefreshCw,
  Plus,
  FolderOpen,
  Globe,
  Sparkles,
  BookOpen,
  AlertTriangle,
  ExternalLink,
  Newspaper,
  Clock,
  ChevronRight,
  MessagesSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import Link from 'next/link';
import { DISCUSSIONS_URL } from '@/lib/constants/links';
import { vfs } from '@/lib/vfs';
import { templateService } from '@/lib/vfs/template-service';
import { logger } from '@/lib/utils';
import { skillsService } from '@/lib/vfs/skills';
import pkg from '@/package.json';
import { PageShell, PageHeader, PageBody } from '@/components/ui/page-shell';
import { apiFetch } from '@/lib/api/backend-status';

const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';

interface DashboardData {
  system: {
    version: string;
    nodeVersion: string;
    uptime: number;
    memoryUsed: number;
    memoryTotal: number;
  };
  content: {
    projects: number;
    templates: number;
    skills: number;
    totalFiles: number;
  };
  hosting: {
    publishedDeployments: number;
    deploymentsWithDb: number;
    storageUsed: number;
  };
  traffic: {
    requestsLastHour: number;
    requestsLastDay: number;
    errorCount: number;
    topDeployments: Array<{ deploymentId: string; deploymentName: string; count: number }>;
    recentErrors: Array<{ deploymentId: string; path: string; statusCode: number; timestamp: string }>;
  };
  whatsNew: {
    version: string;
    title: string;
    highlights: string[];
  };
  recentProjects: Array<{
    id: string;
    name: string;
    description: string | null;
    updatedAt: string;
  }>;
  recentDeployments: Array<{
    id: string;
    name: string;
    slug: string;
    publishedAt: string | null;
    updatedAt: string;
  }>;
}

// Browser mode data (subset of server mode)
interface BrowserDashboardData {
  content: {
    projects: number;
    templates: number;
    skills: number;
  };
  whatsNew: {
    version: string;
    title: string;
    highlights: string[];
  } | null;
  recentProjects: Array<{
    id: string;
    name: string;
    description: string | null;
    updatedAt: string;
  }>;
}

// Fetch and parse the latest What's New entry from WHATS_NEW.md
async function fetchWhatsNew(): Promise<BrowserDashboardData['whatsNew']> {
  try {
    const response = await fetch('/api/docs/WHATS_NEW.md');
    if (!response.ok) return null;

    const content = await response.text();
    const versionMatch = content.match(/^## v(\d+\.\d+\.\d+)\s*-\s*(.+)$/m);
    if (!versionMatch) return null;

    const version = versionMatch[1];
    const title = versionMatch[2].trim();
    const versionIndex = content.indexOf(versionMatch[0]);
    const afterVersion = content.substring(versionIndex + versionMatch[0].length);
    const nextSectionMatch = afterVersion.match(/^(?:## |---)/m);
    const sectionContent = nextSectionMatch
      ? afterVersion.substring(0, nextSectionMatch.index)
      : afterVersion;

    const bulletRegex = /^[-*]\s+\*\*(.+?)\*\*\s*[-–]?\s*(.*)$/gm;
    const highlights: string[] = [];
    let match;

    while ((match = bulletRegex.exec(sectionContent)) !== null && highlights.length < 4) {
      const boldTitle = match[1].trim();
      const description = match[2]?.trim();
      highlights.push(description ? `${boldTitle} - ${description}` : boldTitle);
    }

    if (highlights.length === 0) {
      const simpleBulletRegex = /^[-*]\s+(.+)$/gm;
      while ((match = simpleBulletRegex.exec(sectionContent)) !== null && highlights.length < 4) {
        const text = match[1].trim();
        if (!text.match(/^\[.*\]\(.*\)$/)) {
          highlights.push(text.replace(/\*\*/g, ''));
        }
      }
    }

    return { version, title, highlights };
  } catch {
    return null;
  }
}

// Fetch dashboard data for browser mode (IndexedDB)
async function fetchBrowserModeData(): Promise<BrowserDashboardData> {
  await vfs.init();

  const projects = await vfs.listProjects();
  const templates = await templateService.listCustomTemplates();
  const skills = await skillsService.getAllSkills();
  const whatsNew = await fetchWhatsNew();

  return {
    content: {
      projects: projects.length,
      templates: templates.length,
      skills: skills.length,
    },
    whatsNew,
    recentProjects: projects
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 3)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || null,
        updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
      })),
  };
}

type NumberFormat = ReturnType<typeof useLocalFormat>['number'];

export function formatUptime(seconds: number, number: NumberFormat): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const unit = (value: number, name: 'day' | 'hour' | 'minute') =>
    number(value, { style: 'unit', unit: name, unitDisplay: 'narrow' });

  if (days > 0) {
    return `${unit(days, 'day')} ${unit(hours, 'hour')}`;
  }
  if (hours > 0) {
    return `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
  }
  return unit(minutes, 'minute');
}

function formatNumber(num: number, number: NumberFormat): string {
  return number(num, { notation: 'compact', maximumFractionDigits: 1 });
}

// Quick Actions Bar
function QuickActionsBar({
  onStartTour,
  onNavigate,
}: {
  onStartTour?: () => void;
  onNavigate?: (view: string) => void;
}) {
  const t = useTranslations();
  // In browser mode, use onNavigate callback; in server mode, use Link
  const projectsHref = isServerMode ? '/admin/projects?action=create' : '#';
  const projectsListHref = isServerMode ? '/admin/projects' : '#';
  const docsHref = isServerMode ? '/admin/docs' : '#';

  const handleNewProjectClick = (e: React.MouseEvent) => {
    if (!isServerMode && onNavigate) {
      e.preventDefault();
      onNavigate('projects:create');
    }
  };

  const handleProjectsClick = (e: React.MouseEvent) => {
    if (!isServerMode && onNavigate) {
      e.preventDefault();
      onNavigate('projects');
    }
  };

  const handleDocsClick = (e: React.MouseEvent) => {
    if (!isServerMode && onNavigate) {
      e.preventDefault();
      onNavigate('docs');
    }
  };

  return (
    <div className="bg-card rounded-lg border border-border p-4 mb-6">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild className="gap-1.5">
          <Link href={projectsHref} onClick={handleNewProjectClick}>
            <Plus className="w-4 h-4" />
            {t('dashboard.newProject')}
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild className="gap-1.5">
          <Link href={projectsListHref} onClick={handleProjectsClick}>
            <FolderOpen className="w-4 h-4" />
            {t('common.terms.projects')}
          </Link>
        </Button>
        {isServerMode && (
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <Link href="/admin/deployments">
              <Globe className="w-4 h-4" />
              {t('common.terms.deployments')}
            </Link>
          </Button>
        )}
        {onStartTour && (
          <Button variant="outline" size="sm" onClick={onStartTour} className="gap-1.5">
            <Sparkles className="w-4 h-4" />
            {t('nav.items.tour')}
          </Button>
        )}
        <Button variant="outline" size="sm" asChild className="gap-1.5">
          <a href={DISCUSSIONS_URL} target="_blank" rel="noopener noreferrer">
            <MessagesSquare className="w-4 h-4" />
            {t('nav.discussions')}
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild className="gap-1.5">
          <Link href={docsHref} onClick={handleDocsClick}>
            <BookOpen className="w-4 h-4" />
            {t('common.terms.docs')}
          </Link>
        </Button>
      </div>
    </div>
  );
}

// What's New Card - always visible, links to full changelog
type WhatsNewProps = {
  version: string;
  title: string;
  highlights?: string[];
};

function WhatsNewCard({
  whatsNew,
  onNavigate,
}: {
  whatsNew: WhatsNewProps;
  onNavigate?: (view: string) => void;
}) {
  const t = useTranslations();
  if (!whatsNew) return null;

  const handleReadAll = (e: React.MouseEvent) => {
    if (!isServerMode && onNavigate) {
      e.preventDefault();
      window.history.pushState({}, '', '/?doc=whats-new');
      onNavigate('docs');
    }
  };

  const docsHref = isServerMode ? '/admin/docs?doc=whats-new' : '#';

  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-medium text-foreground">
            {t('dashboard.whatsNewIn', { version: whatsNew.version })}
          </h3>
        </div>
        <Link
          href={docsHref}
          onClick={handleReadAll}
          className="text-xs text-orange-500 hover:text-orange-400 flex items-center gap-1"
        >
          {t('common.actions.readAll')}
          <ExternalLink className="w-3 h-3" />
        </Link>
      </div>
      <p className="text-sm font-medium text-foreground mb-2">{whatsNew.title}</p>
      {whatsNew.highlights && whatsNew.highlights.length > 0 && (
        <ul className="space-y-1 flex-1">
          {whatsNew.highlights.map((highlight, i) => (
            <li key={i} className="text-xs text-foreground flex items-start gap-2">
              <span className="text-orange-500/70 mt-0.5">•</span>
              <span>{highlight}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Compact System Overview (server mode - full stats)
function CompactOverview({
  data,
  loading,
  onRefresh,
}: {
  data: DashboardData;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const { number, bytes } = useLocalFormat();
  const stats = [
    { label: t('common.labels.version'), value: `v${data.system.version}` },
    { label: t('common.terms.projects'), value: formatNumber(data.content.projects, number) },
    { label: t('common.terms.deployments'), value: formatNumber(data.hosting.publishedDeployments, number) },
    { label: t('dashboard.trafficHour'), value: formatNumber(data.traffic.requestsLastHour, number) },
    { label: t('dashboard.trafficDay'), value: formatNumber(data.traffic.requestsLastDay, number) },
    { label: t('dashboard.errors'), value: formatNumber(data.traffic.errorCount, number), highlight: data.traffic.errorCount > 0 },
    { label: t('dashboard.memory'), value: bytes(data.system.memoryUsed, 1) },
    { label: t('dashboard.uptime'), value: formatUptime(data.system.uptime, number) },
  ];

  const half = Math.ceil(stats.length / 2);
  const leftColumn = stats.slice(0, half);
  const rightColumn = stats.slice(half);

  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">{t('dashboard.systemOverview')}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="h-7 px-2"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 flex-1 content-start">
        <div className="space-y-1.5">
          {leftColumn.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className={`text-sm font-medium ${stat.highlight ? 'text-yellow-500' : 'text-foreground'}`}>
                {stat.value}
              </span>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          {rightColumn.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className={`text-sm font-medium ${stat.highlight ? 'text-yellow-500' : 'text-foreground'}`}>
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Browser mode Overview (subset of stats)
function BrowserOverview({
  data,
  loading,
  onRefresh,
}: {
  data: BrowserDashboardData;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const { number } = useLocalFormat();
  const stats = [
    { label: t('common.labels.version'), value: `v${pkg.version}` },
    { label: t('common.terms.projects'), value: formatNumber(data.content.projects, number) },
    { label: t('common.terms.templates'), value: formatNumber(data.content.templates, number) },
    { label: t('common.terms.skills'), value: formatNumber(data.content.skills, number) },
  ];

  const half = Math.ceil(stats.length / 2);
  const leftColumn = stats.slice(0, half);
  const rightColumn = stats.slice(half);

  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">{t('dashboard.contentOverview')}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          className="h-7 px-2"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 flex-1 content-start">
        <div className="space-y-1.5">
          {leftColumn.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className="text-sm font-medium text-foreground">{stat.value}</span>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          {rightColumn.map((stat) => (
            <div key={stat.label} className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className="text-sm font-medium text-foreground">{stat.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Recent Projects Card
function RecentProjectsCard({
  projects,
  onNavigate,
  onProjectSelect,
}: {
  projects: DashboardData['recentProjects'] | BrowserDashboardData['recentProjects'];
  onNavigate?: (view: string) => void;
  onProjectSelect?: (projectId: string) => void;
}) {
  const t = useTranslations();
  const when = useLocalFormat();
  const handleViewAll = (e: React.MouseEvent) => {
    if (!isServerMode && onNavigate) {
      e.preventDefault();
      onNavigate('projects');
    }
  };

  const handleProjectClick = (e: React.MouseEvent, projectId: string) => {
    if (!isServerMode && onProjectSelect) {
      e.preventDefault();
      onProjectSelect(projectId);
    }
  };

  const viewAllHref = isServerMode ? '/admin/projects' : '#';

  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.recentProjects')}</h3>
        </div>
        <Link
          href={viewAllHref}
          onClick={handleViewAll}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
        >
          {t('common.actions.viewAll')}
          <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-2 flex-1 flex items-center justify-center">
          {t('dashboard.noProjects')}
        </p>
      ) : (
        <div className="space-y-1.5 flex-1">
          {projects.slice(0, 3).map((project) => (
            <Link
              key={project.id}
              // Opened over the dashboard rather than over the projects list, so Back returns here.
              href={isServerMode ? `/admin/dashboard?project=${project.id}` : '#'}
              onClick={(e) => handleProjectClick(e, project.id)}
              className="flex items-center justify-between text-xs py-1.5 px-2 bg-muted/50 rounded hover:bg-muted transition-colors"
            >
              <span className="text-foreground truncate flex-1 mr-2">{project.name}</span>
              <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {when.recent(project.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Recent Deployments Card
function RecentDeploymentsCard({ deployments }: { deployments: DashboardData['recentDeployments'] }) {
  const when = useLocalFormat();
  const t = useTranslations();
  return (
    <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.recentDeployments')}</h3>
        </div>
        <Link
          href="/admin/deployments"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
        >
          {t('common.actions.viewAll')}
          <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      {deployments.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-2 flex-1 flex items-center justify-center">
          {t('dashboard.noDeployments')}
        </p>
      ) : (
        <div className="space-y-1.5 flex-1">
          {deployments.slice(0, 3).map((deployment) => (
            <Link
              key={deployment.id}
              href={'/admin/deployments'}
              className="flex items-center justify-between text-xs py-1.5 px-2 bg-muted/50 rounded hover:bg-muted transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    deployment.publishedAt ? 'bg-green-500' : 'bg-muted-foreground'
                  }`}
                />
                <span className="text-foreground truncate">{deployment.name}</span>
              </div>
              <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {when.recent(deployment.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact Top Deployments & Errors
function TrafficLists({ data }: { data: DashboardData }) {
  const t = useTranslations();
  const { number, dateTime } = useLocalFormat();
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Top Deployments */}
      <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.topDeployments')}</h3>
        </div>
        {data.traffic.topDeployments.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2 flex-1 flex items-center justify-center">
            {t('dashboard.noTraffic')}
          </p>
        ) : (
          <div className="space-y-1.5 flex-1">
            {data.traffic.topDeployments.slice(0, 5).map((deployment, i) => (
              <div
                key={deployment.deploymentId}
                className="flex items-center justify-between text-xs py-1 px-2 bg-muted/50 rounded"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground w-4">{i + 1}.</span>
                  <span className="text-foreground truncate">{deployment.deploymentName}</span>
                </div>
                <span className="text-muted-foreground shrink-0">{formatNumber(deployment.count, number)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Errors */}
      <div className="bg-card rounded-lg border border-border p-4 flex flex-col">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-orange-500" />
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.recentErrors')}</h3>
        </div>
        {data.traffic.recentErrors.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2 flex-1 flex items-center justify-center">
            {t('dashboard.noErrors')}
          </p>
        ) : (
          <div className="space-y-1.5 flex-1">
            {data.traffic.recentErrors.slice(0, 5).map((error, i) => (
              <div
                key={`${error.deploymentId}-${error.path}-${i}`}
                className="flex items-center justify-between text-xs py-1 px-2 bg-muted/50 rounded"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`font-mono px-1 py-0.5 rounded text-[10px] ${
                      error.statusCode >= 500
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                    }`}
                  >
                    {error.statusCode}
                  </span>
                  <span className="text-muted-foreground truncate max-w-[140px]">{error.path}</span>
                </div>
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {dateTime(error.timestamp, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface DashboardViewProps {
  workspaceId?: string;
  onNavigate?: (view: string) => void;
  onProjectSelect?: (projectId: string) => void;
  onStartTour?: () => void;
}

// Fetch workspace-scoped data for non-admin server mode users
async function fetchWorkspaceData(workspaceId: string): Promise<BrowserDashboardData> {
  const response = await apiFetch(`/api/w/${workspaceId}/sync/status`);
  if (!response.ok) throw new Error('Failed to fetch workspace data');
  const data = await response.json();
  const whatsNew = await fetchWhatsNew();

  return {
    content: {
      projects: data.summary?.projectCount || 0,
      templates: data.summary?.templateCount || 0,
      skills: data.summary?.skillCount || 0,
    },
    whatsNew,
    recentProjects: (data.projects || [])
      .sort((a: { updatedAt: string }, b: { updatedAt: string }) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 3)
      .map((p: { id: string; name: string; updatedAt: string }) => ({
        id: p.id,
        name: p.name,
        description: null,
        updatedAt: p.updatedAt,
      })),
  };
}

export function DashboardView({ workspaceId, onNavigate, onProjectSelect, onStartTour }: DashboardViewProps) {
  const t = useTranslations();
  // Server mode admin data
  const [serverData, setServerData] = useState<DashboardData | null>(null);
  // Browser mode / workspace mode data
  const [browserData, setBrowserData] = useState<BrowserDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (isServerMode && workspaceId) {
        // Server mode with workspace: use workspace-scoped data
        const result = await fetchWorkspaceData(workspaceId);
        setBrowserData(result);
      } else if (isServerMode) {
        // Server mode without workspace (legacy admin path)
        const response = await apiFetch('/api/admin/dashboard');
        if (!response.ok) throw new Error('Failed to fetch dashboard data');
        const result = await response.json();
        setServerData(result);
      } else {
        // Browser mode: fetch from IndexedDB
        const result = await fetchBrowserModeData();
        setBrowserData(result);
      }
    } catch (err) {
      logger.error('[DashboardView] Failed to load dashboard data:', err);
      setError(t('dashboard.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleProjectSelect = useCallback((projectId: string) => {
    if (!isServerMode && onProjectSelect) {
      onProjectSelect(projectId);
    }
  }, [onProjectSelect]);

  // Loading state
  const hasData = !!serverData || !!browserData;
  if (loading && !hasData) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Spinner size={32} color="#f97316" className="mx-auto" />
          <p className="mt-3 text-sm text-muted-foreground">{t('dashboard.loading')}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && !hasData) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-muted-foreground text-sm">{error}</p>
          <Button variant="outline" size="sm" onClick={fetchData} className="mt-4">
            {t('common.actions.retry')}
          </Button>
        </div>
      </div>
    );
  }

  if (!hasData) return null;

  // Server mode admin render (full system dashboard)
  if (isServerMode && serverData) {
    const hasWhatsNew = serverData.whatsNew?.highlights?.length > 0;

    return (
      <PageShell>
        <PageHeader title={t('common.terms.dashboard')} />
        <PageBody innerClassName="">
          {/* Quick Actions */}
          <QuickActionsBar onStartTour={onStartTour} />

          {/* Row 1: System Overview + What's New */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 [&>*]:min-h-[160px]">
            <CompactOverview data={serverData} loading={loading} onRefresh={fetchData} />
            {hasWhatsNew && <WhatsNewCard whatsNew={serverData.whatsNew} />}
          </div>

          {/* Row 2: Recent Projects + Recent Deployments */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 [&>*]:min-h-[160px]">
            <RecentProjectsCard projects={serverData.recentProjects} />
            <RecentDeploymentsCard deployments={serverData.recentDeployments} />
          </div>

          {/* Row 3: Top Deployments + Recent Errors */}
          <div className="[&>*>*]:min-h-[140px]">
            <TrafficLists data={serverData} />
          </div>
        </PageBody>
      </PageShell>
    );
  }

  // Browser mode render OR server mode non-admin workspace render
  if (browserData) {
    const hasWhatsNew = browserData.whatsNew !== null;

    return (
      <PageShell>
        <PageHeader title={t('common.terms.dashboard')} />
        <PageBody innerClassName="">
          {/* Quick Actions */}
          <QuickActionsBar onStartTour={onStartTour} onNavigate={onNavigate} />

          {/* Row 1: Content Overview + What's New */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 [&>*]:min-h-[160px]">
            <BrowserOverview data={browserData} loading={loading} onRefresh={fetchData} />
            {hasWhatsNew && (
              <WhatsNewCard
                whatsNew={browserData.whatsNew!}
                onNavigate={onNavigate}
              />
            )}
          </div>

          {/* Row 2: Recent Projects (no Deployments in browser mode) */}
          <div className="mb-4 lg:w-1/2">
            <RecentProjectsCard
              projects={browserData.recentProjects}
              onNavigate={onNavigate}
              onProjectSelect={handleProjectSelect}
            />
          </div>
        </PageBody>
      </PageShell>
    );
  }

  return null;
}
