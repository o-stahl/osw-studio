'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Deployment, Project } from '@/lib/vfs/types';
import { vfs } from '@/lib/vfs';
import { getLoginUrl } from '@/lib/config/storage';
import { getSyncManager } from '@/lib/vfs/sync-manager';
import { createSyncProgressToast } from '@/lib/vfs/sync-progress-toast';
import { SERVER_PROJECTS_CHANGED, SERVER_DEPLOYMENTS_CHANGED } from '@/lib/vfs/sync-events';
import { DeploymentCard } from '../deployment-card';
import { DeploymentDetail, type DeploymentSettingsUpdate } from '../deployment-detail';
import type { ReviewDraft } from '../publish-settings/review-tab';
import { CreateDeploymentModal } from '../create-deployment-modal';
import { takePendingDeploymentRequest } from '@/lib/deployments/pending-create';
import { AnalyticsDashboard } from '../analytics-dashboard';
import { TemplateExportDialog } from '../templates/template-export-dialog';
import { ProjectSwapDialog } from '../project-swap-dialog';
import { PageShell, PageHeader, PageBody } from '@/components/ui/page-shell';
import { Globe, Plus, Search, ArrowUpDown, MoreVertical, Settings, RefreshCw, EyeOff, Trash2, Copy, Pencil, ExternalLink } from 'lucide-react';
import { ViewModeToggle, useViewMode } from '@/components/ui/view-mode-toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { track } from '@/lib/telemetry';
import { usePagination } from '@/lib/hooks/use-pagination';
import { Pagination, PaginationRange } from '@/components/ui/pagination';
import { ThumbnailArea } from '@/components/ui/thumbnail-area';
import { captureDeploymentPage } from '@/lib/utils/deployment-thumbnail';
import { ReviewBadge } from '@/components/ui/review-badge';
import { useNarrowContainer } from '@/lib/hooks/use-narrow-container';
import { COMPACT_ROW_WIDTH } from '@/lib/constants/layout';
import { apiFetch } from '@/lib/api/backend-status';
import type { SitesMode } from '@/lib/web/site-origin';

type SortOption = 'updated' | 'created' | 'name' | 'published';

interface DeploymentsViewProps {
  /** `previewPath` opens the workspace preview on that page — used by the review comment inbox. */
  onProjectSelect: (project: Project, previewPath?: string) => void;
  workspaceId?: string;
}

/** Shared by the URL text and the copy button beside it, so the two cannot behave differently. */
function copyDeploymentUrl(url: string, copied: string): void {
  navigator.clipboard.writeText(url);
  toast.success(copied);
}

export function DeploymentsView({ onProjectSelect, workspaceId }: DeploymentsViewProps) {
  const when = useLocalFormat();
  const t = useTranslations('deployments');
  const tSort = useTranslations('common.sort');
  const tc = useTranslations('common');
  const tp = useTranslations('projects');
  const apiBase = workspaceId ? `/api/w/${workspaceId}` : '/api';
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [detailSection, setDetailSection] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishingStates, setPublishingStates] = useState<Record<string, boolean>>({});
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForProjectId, setCreateForProjectId] = useState<string | undefined>(undefined);
  const [showTemplateExportModal, setShowTemplateExportModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('updated');
  const [viewMode, setViewMode] = useViewMode('deployments');
  const [swapDialogState, setSwapDialogState] = useState<{
    deploymentId: string;
    deploymentName: string;
    currentProjectId: string;
    newProjectId: string;
    newProjectName: string;
    /** Settles the save waiting on the dialog: true carries it on, false leaves the edits unsaved. */
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  // How the install serves published sites; 'same-origin' gets a warning (lib/web/site-origin.ts).
  const [sitesMode, setSitesMode] = useState<SitesMode | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!isServerMode || !workspaceId) return;
    let cancelled = false;
    apiFetch(`${apiBase}/hosting`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancelled && data) setSitesMode(data.sitesMode); })
      .catch(() => { /* the warning is advisory */ });
    return () => { cancelled = true; };
  }, [apiBase, isServerMode, workspaceId]);

  const loadData = async () => {
    try {
      setLoading(true);

      if (!isServerMode) {
        setLoading(false);
        return;
      }

      const [deploymentsResponse, projectsResponse] = await Promise.all([
        apiFetch(`${apiBase}/deployments`),
        apiFetch(`${apiBase}/projects?fields=id,name`), // Only fetch id and name fields
      ]);

      // Redirect to login if unauthorized
      if (deploymentsResponse.status === 401 || projectsResponse.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }

      if (!deploymentsResponse.ok) {
        throw new Error('Failed to fetch deployments');
      }
      if (!projectsResponse.ok) {
        throw new Error('Failed to fetch projects');
      }

      const [fetchedDeployments, fetchedProjects] = await Promise.all([
        deploymentsResponse.json(),
        projectsResponse.json(),
      ]);

      setDeployments(fetchedDeployments);
      setProjects(fetchedProjects);
    } catch (error) {
      logger.error('[DeploymentsView] Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Re-read the server's project list. Cheap and side-effect free, so anything that opens a
  // project picker can call it.
  const fetchProjects = useCallback(async () => {
    if (!isServerMode) return;
    try {
      const res = await apiFetch(`${apiBase}/projects?fields=id,name`);
      if (res.status === 401) {
        window.location.href = getLoginUrl();
        return;
      }
      if (!res.ok) return;
      setProjects(await res.json());
    } catch (error) {
      logger.error('[DeploymentsView] Failed to refresh project list:', error);
    }
  }, [apiBase, isServerMode]);

  // Reconcile any project that has drifted from the server (imports, or an earlier failed push)
  // before re-reading the list, so a freshly imported project is deployable straight away.
  // Kept separate from fetchProjects: this pushes data, and running it on every picker open would
  // be a heavy, quota-consuming side effect. It also must not be able to skip the re-read, which
  // is why the reconcile has its own catch.
  const refreshProjectList = useCallback(async () => {
    if (!isServerMode) return;
    try {
      const { reconcileProjectsToServer } = await import('@/lib/vfs/auto-sync');
      await reconcileProjectsToServer(workspaceId);
    } catch (error) {
      logger.error('[DeploymentsView] Failed to reconcile projects before refresh:', error);
    }
    await fetchProjects();
  }, [isServerMode, workspaceId, fetchProjects]);

  const handleOpenCreate = () => {
    setShowCreateModal(true);
    // Refresh in the background; the dropdown updates reactively when it resolves.
    void refreshProjectList();
  };

  // Deploy in the workspace leaves the project here rather than passing a prop, because this view
  // is not mounted at the moment Deploy runs. Collect it once, on mount.
  useEffect(() => {
    const projectId = takePendingDeploymentRequest();
    if (!projectId) return;
    setCreateForProjectId(projectId);
    setShowCreateModal(true);
    void refreshProjectList();
  }, [refreshProjectList]);

  // A push from the Server Sync dialog happens in a sibling subtree (it is mounted by PageLayout),
  // so it cannot reach this view through props. It broadcasts instead.
  useEffect(() => {
    if (!isServerMode) return;
    const handler = () => { void fetchProjects(); };
    window.addEventListener(SERVER_PROJECTS_CHANGED, handler);
    return () => window.removeEventListener(SERVER_PROJECTS_CHANGED, handler);
  }, [isServerMode, fetchProjects]);

  // A deployment an MCP client created, published or unpublished. The projects signal above
  // refreshes only the picker, which says nothing about the deployment list this page is for.
  //
  // Held in a ref so the listener is attached once: `loadData` is redefined on every render, and
  // depending on it directly would tear the subscription down and rebuild it each time.
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;
  useEffect(() => {
    if (!isServerMode) return;
    const handler = () => { void loadDataRef.current(); };
    window.addEventListener(SERVER_DEPLOYMENTS_CHANGED, handler);
    return () => window.removeEventListener(SERVER_DEPLOYMENTS_CHANGED, handler);
  }, [isServerMode]);

  // Helper function to update a single deployment in state (optimistic updates)
  const updateDeploymentInState = (deploymentId: string, updates: Partial<Deployment>) => {
    setDeployments(prevDeployments =>
      prevDeployments.map(deployment =>
        deployment.id === deploymentId ? { ...deployment, ...updates } : deployment
      )
    );
  };

  const handleOpenDetail = (deployment: Deployment, section?: string) => {
    setSelectedDeployment(deployment);
    setDetailSection(section);
    void fetchProjects();
  };

  const handleViewAnalytics = (deployment: Deployment) => {
    setSelectedDeployment(deployment);
    setShowAnalyticsModal(true);
  };

  const handleEditProject = async (deployment: Deployment) => {
    try {
      await vfs.init();
      const project = await vfs.getProject(deployment.projectId);
      if (!project) {
        toast.error(t('projectNotFound'));
        return;
      }
      onProjectSelect(project);
    } catch (error) {
      logger.error('[DeploymentsView] Failed to load project:', error);
      toast.error(t('loadProjectFailed'));
    }
  };

  /** Open the deployment's project in the editor with the preview already on the commented page. */
  const [templateExportProject, setTemplateExportProject] = useState<Project | null>(null);

  const handleExportAsTemplate = async (deployment: Deployment) => {
    try {
      await vfs.init();
      const project = await vfs.getProject(deployment.projectId);
      if (!project) {
        toast.error(t('projectNotFound'));
        return;
      }
      setTemplateExportProject(project);
      setShowTemplateExportModal(true);
    } catch (error) {
      logger.error('[DeploymentsView] Failed to load project for template export:', error);
      toast.error(t('loadProjectFailed'));
    }
  };

  /**
   * Persist the review block, and answer with what the server actually stored.
   *
   * It goes to the deployment route rather than the settings one: only that handler runs
   * `mergeReviewConfig`, and the settings route deliberately drops `review` because writing a block
   * that has been through `toPublicDeployment` — no password hash on it — would unlock the review
   * copy. The response is what gets kept, so the plaintext password never lands in component state.
   */
  const saveReviewBlock = async (
    deploymentId: string,
    review: ReviewDraft
  ): Promise<Deployment['review']> => {
    const response = await apiFetch(`${apiBase}/deployments/${deploymentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || t('saveReviewFailed'));
    }

    const updated = await response.json();
    return updated.review;
  };

  const handleSaveSettings = async (settings: DeploymentSettingsUpdate): Promise<boolean | void> => {
    if (!selectedDeployment) return;

    try {
      // A published deployment changing project shows what that does to its backend features
      // first. Confirmed, the save goes on as any other; the live site changes on republish.
      const projectIdChanged = settings.projectId && settings.projectId !== selectedDeployment.projectId;
      if (projectIdChanged && isServerMode && selectedDeployment.publishedAt) {
        const newProject = projects.find(p => p.id === settings.projectId);
        const confirmed = await new Promise<boolean>((resolve) => setSwapDialogState({
          deploymentId: selectedDeployment.id,
          deploymentName: selectedDeployment.name,
          currentProjectId: selectedDeployment.projectId,
          newProjectId: settings.projectId!,
          newProjectName: newProject?.name || t('unknown'),
          resolve,
        }));
        setSwapDialogState(null);
        if (!confirmed) return false;
      }

      if (projectIdChanged) {
        const deploymentResponse = await apiFetch(`${apiBase}/deployments/${selectedDeployment.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: settings.projectId }),
        });

        if (!deploymentResponse.ok) {
          const error = await deploymentResponse.json();
          throw new Error(error.error || tp('updateFailed'));
        }
      }

      // Save publishing settings (exclude projectId and review — both handled separately)
      const { projectId: _projectId, review, ...publishSettings } = settings;

      // Ahead of the settings PUT: enabling review mode bumps settingsVersion server-side, and the
      // settings response is what this component then trusts for that counter.
      const savedReview = review
        ? await saveReviewBlock(selectedDeployment.id, review)
        : selectedDeployment.review;

      const response = await apiFetch(`${apiBase}/deployments/${selectedDeployment.id}/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(publishSettings),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('saveSettingsFailed'));
      }

      const result = await response.json();

      // Fire only on the empty -> set transition, never on every save and
      // never with the domain value itself.
      if (!selectedDeployment.customDomain && settings.customDomain) {
        track('custom_domain_set');
      }

      // Update local deployment state in the selected deployment modal
      setSelectedDeployment({
        ...selectedDeployment,
        ...settings,
        review: savedReview,
        settingsVersion: result.settingsVersion,
        lastPublishedVersion: result.lastPublishedVersion,
      });

      // Update the deployment in the main list (optimistic update - no full reload)
      updateDeploymentInState(selectedDeployment.id, {
        ...settings,
        review: savedReview,
        settingsVersion: result.settingsVersion,
        updatedAt: new Date(),
      });
    } catch (error) {
      logger.error('[DeploymentsView] Failed to save deployment settings:', error);
      throw error;
    }
  };

  const handlePublish = async (deploymentId: string) => {
    const deployment = deployments.find(s => s.id === deploymentId);
    if (!deployment) return;

    // Native confirm() blocks the renderer; an automated client that never accepts
    // the dialog never issues a publish request. The publishing spinner is the signal.

    // Set publishing state
    setPublishingStates(prev => ({ ...prev, [deploymentId]: true }));

    let trackedRuntime = 'unknown';

    try {
      // First, sync files from IndexedDB to server
      toast.info(t('syncingFiles'));

      await vfs.init();
      const project = await vfs.getProject(deployment.projectId);
      if (!project) {
        throw new Error(t('projectNotFound'));
      }

      // Block publishing for terminal-mode runtimes (Python, Lua) — they can't be
      // served as static sites. Use ZIP export instead.
      const { isRuntimeBundled, getRuntimeConfig } = await import('@/lib/runtimes/registry');
      const runtime = project.settings?.runtime;
      trackedRuntime = runtime ?? 'unknown';
      if (runtime && getRuntimeConfig(runtime).previewMode === 'terminal') {
        throw new Error(t('terminalNotPublishable', { runtime: getRuntimeConfig(runtime).label }));
      }

      const { flushEditorToVfs } = await import('@/lib/vfs/flush-editor');
      await flushEditorToVfs();
      await vfs.flushSyncTimeout(deployment.projectId);

      let files = await vfs.listFiles(deployment.projectId);
      if (files.length === 0) {
        throw new Error(t('noFilesToPublish'));
      }

      if (runtime && isRuntimeBundled(runtime)) {
        // Always compile fresh — generated files may be stale or absent
        // (e.g. user publishes without opening the preview first)
        toast.info(t('compilingBundles'));
        const { VirtualServer } = await import('@/lib/preview/virtual-server');
        const vs = new VirtualServer(vfs as any, deployment.projectId, { runtime, minify: true });
        await vs.compileProject();
        vs.cleanupBlobUrls();

        const generatedFiles = vfs.getGeneratedFiles();
        if (generatedFiles.length > 0) {
          const withProjectId = generatedFiles.map(f => ({ ...f, projectId: deployment.projectId }));
          files = [...files, ...withProjectId];
        }
      }

      const syncManager = getSyncManager(workspaceId);

      // Push project and files to server. A project too large for one request body goes in
      // batches, which is many sequential requests over however slow the link is, so it reports
      // where it is instead of sitting on "Building deployment..." for the duration.
      const uploadProgress = createSyncProgressToast(t('uploadingProject', { name: project.name }));
      const syncResult = await syncManager.pushProjectWithFiles(project, files, {
        onProgress: ({ batch, batches }) => uploadProgress.update(batch, batches),
      });
      if (!syncResult.success) {
        uploadProgress.dismiss();
        throw new Error(syncResult.error || t('syncFilesFailed'));
      }
      if (syncResult.project) {
        const { persistAcknowledgedRevision } = await import('@/lib/vfs/auto-sync');
        await persistAcknowledgedRevision(deployment.projectId, syncResult.project.revision, {
          lastSyncedAt: new Date(),
          serverUpdatedAt: syncResult.project.updatedAt
            ? new Date(syncResult.project.updatedAt)
            : new Date(),
          syncStatus: 'synced',
        });
      }
      uploadProgress.dismiss();

      // Sync backend features from IndexedDB to server
      const adapter = await vfs.getStorageAdapter();
      const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(deployment.projectId) : [];
      const serverFunctions = adapter.listServerFunctions ? await adapter.listServerFunctions(deployment.projectId) : [];
      const secrets = adapter.listSecrets ? await adapter.listSecrets(deployment.projectId) : [];
      const scheduledFunctions = adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(deployment.projectId) : [];

      if (edgeFunctions.length > 0 || serverFunctions.length > 0 ||
          secrets.length > 0 || scheduledFunctions.length > 0) {
        toast.info(t('syncingBackend'));
        const featuresSyncResult = await syncManager.pushBackendFeatures(deployment.projectId, {
          edgeFunctions,
          serverFunctions,
          secrets,
          scheduledFunctions,
        });
        if (!featuresSyncResult.success) {
          throw new Error(featuresSyncResult.error || t('syncBackendFailed'));
        }
      }

      toast.info(t('building'));

      // Call publish API to trigger build
      const response = await apiFetch(`${apiBase}/deployments/${deploymentId}/publish`, {
        method: 'POST',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('publishFailed'));
      }

      const result = await response.json();

      track('deployment_publish', {
        runtime: runtime ?? 'unknown',
        result: 'success',
        has_custom_domain: !!deployment.customDomain,
      });

      toast.success(t('publishedFiles', { count: result.filesWritten }));

      // Update state optimistically with publish data
      updateDeploymentInState(deploymentId, {
        lastPublishedVersion: result.lastPublishedVersion,
        publishedAt: new Date(),
        updatedAt: new Date(),
        databaseEnabled: true,
        ...(result.slug && { slug: result.slug }),
      });

      // Clear publishing state immediately after successful publish
      setPublishingStates(prev => ({ ...prev, [deploymentId]: false }));
    } catch (error) {
      logger.error('Failed to publish:', error);
      track('deployment_publish', {
        runtime: trackedRuntime,
        result: 'fail',
        has_custom_domain: !!deployment.customDomain,
      });
      toast.error(error instanceof Error ? error.message : t('publishFailed'));
      // Clear publishing state on error
      setPublishingStates(prev => ({ ...prev, [deploymentId]: false }));
    }
  };

  const handleDeploymentThumbnailChange = async (deploymentId: string, image: string | undefined) => {
    try {
      const response = await apiFetch(`${apiBase}/deployments/${deploymentId}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewImage: image ?? null }),
      });
      if (!response.ok) throw new Error('Failed to update thumbnail');

      updateDeploymentInState(deploymentId, {
        previewImage: image,
        previewUpdatedAt: image ? new Date() : undefined,
      });
    } catch (err) {
      logger.error('[DeploymentsView] Failed to update deployment thumbnail:', err);
      toast.error(t('thumbnailFailed'));
    }
  };

  const handleUnpublish = async (deploymentId: string) => {
    const deployment = deployments.find(s => s.id === deploymentId);
    if (!deployment) return;

    if (!confirm(t('confirmUnpublish', { name: deployment.name }))) {
      return;
    }

    try {
      const response = await apiFetch(`${apiBase}/deployments/${deploymentId}/publish`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('unpublishFailed'));
      }

      // Both fields drive the published badges, so clearing them here keeps the row honest
      // without a full reload.
      updateDeploymentInState(deploymentId, {
        publishedAt: undefined,
        lastPublishedVersion: undefined,
        updatedAt: new Date(),
      });
      toast.success(t('unpublishedName', { name: deployment.name }));
    } catch (error) {
      logger.error('Failed to unpublish deployment:', error);
      toast.error(error instanceof Error ? error.message : t('unpublishFailed'));
    }
  };

  const handleDelete = async (deploymentId: string) => {
    const deployment = deployments.find(s => s.id === deploymentId);
    if (!deployment) return;

    if (!confirm(t('confirmDelete', { name: deployment.name }))) {
      return;
    }

    try {
      const response = await apiFetch(`${apiBase}/deployments/${deploymentId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('deleteFailed'));
      }

      track('deployment_delete');

      await loadData();
    } catch (error) {
      logger.error('Failed to delete deployment:', error);
      alert(t('deleteFailed'));
    }
  };

  const handleCreateDeployment = async (data: { projectId: string; name: string; slug?: string }) => {
    try {
      const response = await apiFetch(`${apiBase}/deployments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('createFailed'));
      }

      track('deployment_create');

      await loadData();
      setShowCreateModal(false);
    } catch (error) {
      logger.error('Failed to create deployment:', error);
      throw error;
    }
  };

  // Filter and sort deployments
  const filteredAndSortedDeployments = useMemo(() => {
    let filtered = deployments;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = deployments.filter(deployment => {
        const project = projects.find(p => p.id === deployment.projectId);
        return (
          deployment.name.toLowerCase().includes(query) ||
          deployment.slug?.toLowerCase().includes(query) ||
          project?.name.toLowerCase().includes(query)
        );
      });
    }

    // Apply sorting
    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'created':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'published':
          if (!a.publishedAt && !b.publishedAt) return 0;
          if (!a.publishedAt) return 1;
          if (!b.publishedAt) return -1;
          return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
        case 'updated':
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });

    return sorted;
  }, [deployments, projects, searchQuery, sortBy]);

  const deploymentsPagination = usePagination(filteredAndSortedDeployments, {
    perPage: 24,
    resetOn: [searchQuery, sortBy],
  });
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [compactRows, measureRowsRef] = useNarrowContainer(COMPACT_ROW_WIDTH);

  if (!isServerMode) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p>{t('serverModeOnly')}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Spinner size={48} color="#f97316" className="mx-auto" />
          <p className="mt-4">{t('loading')}</p>
        </div>
      </div>
    );
  }

  // ── Detail view ──
  if (selectedDeployment && !showAnalyticsModal) {
    return (
      <>
        <DeploymentDetail
          deployment={selectedDeployment}
          projects={projects}
          isPublishing={publishingStates[selectedDeployment.id] || false}
          initialSection={detailSection}
          onBack={() => setSelectedDeployment(null)}
          onSave={handleSaveSettings}
          onPublish={handlePublish}
          workspaceId={workspaceId}
          sitesMode={sitesMode}
        />

        <TemplateExportDialog
          project={templateExportProject}
          open={showTemplateExportModal}
          onOpenChange={(open) => {
            setShowTemplateExportModal(open);
            if (!open) setTemplateExportProject(null);
          }}
        />

        {swapDialogState && (
          <ProjectSwapDialog
            isOpen={true}
            onClose={() => swapDialogState.resolve(false)}
            deploymentId={swapDialogState.deploymentId}
            deploymentName={swapDialogState.deploymentName}
            currentProjectId={swapDialogState.currentProjectId}
            newProjectId={swapDialogState.newProjectId}
            newProjectName={swapDialogState.newProjectName}
            onConfirm={() => swapDialogState.resolve(true)}
            workspaceId={workspaceId}
          />
        )}
      </>
    );
  }

  return (
    <>
      <PageShell>
        <PageHeader title={tc('terms.deployments')}>
          {/* New Deployment */}
          <div className="flex items-center shrink-0">
            <Button onClick={handleOpenCreate} size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              <span>{tc('actions.new')}</span>
            </Button>
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
            {/* Sort */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <ArrowUpDown className="h-4 w-4" />
                  <span className="hidden sm:inline">{tc('labels.sort')}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48" align="end">
                <div className="space-y-2">
                  <h4 className="font-semibold text-sm">{t('sortBy')}</h4>
                  <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="updated">{tSort('lastUpdated')}</SelectItem>
                      <SelectItem value="published">{tSort('lastPublished')}</SelectItem>
                      <SelectItem value="created">{tSort('dateCreated')}</SelectItem>
                      <SelectItem value="name">{tc('labels.name')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </PageHeader>

        {/* Deployments Grid/List */}
        <PageBody fill bodyRef={listScrollRef}>
            {sitesMode === 'same-origin' && (
              <div role="note" className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                {t.rich('sameOriginWarning', {
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                  link: (chunks) => (
                    <a className="underline" href={workspaceId ? `/w/${workspaceId}/docs?doc=server-mode` : '/admin/docs?doc=server-mode'}>{chunks}</a>
                  ),
                })}
              </div>
            )}
            {filteredAndSortedDeployments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Globe className="h-16 w-16 text-muted-foreground mb-4" />
                {deployments.length === 0 ? (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noneYet')}</h2>
                    <p className="text-muted-foreground mb-4 max-w-md">
                      {t('firstDeploymentHint')}
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-xl font-semibold mb-2">{t('noneFound')}</h2>
                    <p className="text-muted-foreground mb-4 max-w-md">
                      {t('adjustSearch')}
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                {deploymentsPagination.totalPages > 1 && (
                  <div className="flex items-center justify-between gap-3 mb-2 shrink-0">
                    <PaginationRange
                      total={deploymentsPagination.total}
                      rangeStart={deploymentsPagination.rangeStart}
                      rangeEnd={deploymentsPagination.rangeEnd}
                      totalPages={deploymentsPagination.totalPages}
                    />
                    <Pagination
                      page={deploymentsPagination.page}
                      totalPages={deploymentsPagination.totalPages}
                      onPageChange={deploymentsPagination.setPage}
                      scrollTarget={contentScrollRef}
                      className="pt-0 pb-0"
                    />
                  </div>
                )}
                {viewMode === 'table' ? (
                  <div ref={(el) => { contentScrollRef.current = el; measureRowsRef(el); }} className="@container flex-1 min-h-0 overflow-auto border rounded-lg">
                    {/* @container so the columns answer to the table's own width rather than the
                        viewport's. The sidebar is 240px pinned and 56px collapsed, so one viewport
                        width leaves the table nearly 200px apart, and a media query would drop the
                        URL while there was still room for it. */}
                    <table className="w-full table-auto border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr>
                          <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none"></th>
                          <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none w-full">{tc('labels.name')}</th>
                          <th className="@max-3xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">URL</th>
                          <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('ver')}</th>
                          <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('publishedHeader')}</th>
                          <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {deploymentsPagination.pageItems.map((deployment) => {
                          const project = projects.find(p => p.id === deployment.projectId);
                          const isPublished = deployment.lastPublishedVersion !== null && deployment.lastPublishedVersion !== undefined;
                          const hasPendingChanges = isPublished && Number(deployment.settingsVersion) > Number(deployment.lastPublishedVersion);
                          const publicUrl = deployment.publicUrl || `${typeof window !== 'undefined' ? window.location.origin : ''}/deployments/${deployment.id}`;
                          return (
                            <tr key={deployment.id} className="border-b border-border/50 hover:bg-muted/50 cursor-pointer h-[44px]" onClick={() => handleOpenDetail(deployment)}>
                              <td className="p-[4px_10px] align-middle">
                                <ThumbnailArea
                                  size="xs"
                                  image={deployment.previewImage || project?.previewImage}
                                  onCapture={isPublished ? async () => captureDeploymentPage(deployment.id) : undefined}
                                  onImageChange={(img) => handleDeploymentThumbnailChange(deployment.id, img)}
                                />
                              </td>
                              <td className="w-full p-[4px_10px] text-[13px] align-middle overflow-hidden" style={{ maxWidth: 0 }}>
                                {/* The badge sits beside the whole name block rather than inside the
                                    title row, so it centres against both lines and stays at the
                                    cell's right edge whatever the name's length. */}
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="font-medium text-foreground text-[13px] truncate">{deployment.name}</span>
                                    </div>
                                    <span className="block text-[11px] text-muted-foreground truncate">{deployment.slug || project?.name || ''}</span>
                                  </div>
                                  <ReviewBadge
                                    count={deployment.openReviewThreads ?? 0}
                                    onClick={(e) => { e.stopPropagation(); handleOpenDetail(deployment, 'review'); }}
                                  />
                                </div>
                              </td>
                              <td className="@max-3xl:hidden p-[4px_10px] text-[11px] text-muted-foreground align-middle">
                                {isPublished ? (
                                  // Capped on the div, not the td: under `table-auto` a cell's
                                  // max-width is a hint the layout algorithm may ignore, and this
                                  // column was taking width from the name and the actions, which are
                                  // what the row is actually for. A normal block box honours it.
                                  <div className="flex items-center gap-1 min-w-0 max-w-[220px]">
                                    {/* flex-1 so the buttons sit at the cell's right edge rather than
                                        against the text. `truncate` carries overflow-hidden, which
                                        drops the flex item's automatic minimum size to zero, so the
                                        URL ellipsises instead of pushing them out of the cell.

                                        Clicking the text copies rather than opening the row's detail
                                        view: the row is one big click target, and the URL is the one
                                        part of it a person points at meaning to take the address. The
                                        copy button beside it stays the keyboard-reachable path. */}
                                    <span
                                      onClick={(e) => { e.stopPropagation(); copyDeploymentUrl(publicUrl, t('urlCopied')); }}
                                      title={tc('actions.copyUrl')}
                                      className="@max-5xl:hidden flex-1 min-w-0 font-mono truncate cursor-copy hover:text-foreground transition-colors"
                                    >
                                      {publicUrl.replace(/^https?:\/\//, '')}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); copyDeploymentUrl(publicUrl, t('urlCopied')); }}
                                      className="shrink-0 h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 transition-colors"
                                      title={tc('actions.copyUrl')}
                                    >
                                      <Copy className="w-3 h-3" />
                                    </button>
                                    <a
                                      href={publicUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="shrink-0 h-5 w-5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 transition-colors"
                                      title={tc('actions.openLink')}
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  </div>
                                ) : '—'}
                              </td>
                              <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap font-mono tabular-nums">
                                {deployment.settingsVersion}{' / '}{deployment.lastPublishedVersion ?? '—'}
                              </td>
                              <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap overflow-hidden text-ellipsis">
                                {deployment.publishedAt ? when.age(deployment.publishedAt) : '—'}
                              </td>
                              <td className="p-[4px_10px] align-middle whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1">
                                  <Button variant="outline" size="xs" className="@max-3xl:hidden" onClick={() => handleOpenDetail(deployment)}>
                                    <Settings className="w-3 h-3" />{tc('actions.edit')}
                                  </Button>
                                  <Button
                                    variant={hasPendingChanges ? 'outline' : 'ghost'}
                                    size="xs"
                                    className="@max-3xl:hidden"
                                    onClick={() => handlePublish(deployment.id)}
                                    disabled={publishingStates[deployment.id]}
                                  >
                                    <RefreshCw className={`w-3 h-3 ${publishingStates[deployment.id] ? 'animate-spin' : ''}`} />
                                    {isPublished ? tc('actions.republish') : tc('actions.publish')}
                                  </Button>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="xs" className="px-1"><MoreVertical className="w-3.5 h-3.5" /></Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {/* What the row hides at COMPACT_ROW_WIDTH reappears here. The
                                          menu is portaled out of the table, so this is driven by the
                                          measured width rather than the same container query the
                                          cells use. */}
                                      {compactRows && (
                                        <>
                                          <DropdownMenuItem onClick={() => handleOpenDetail(deployment)}>
                                            <Settings className="w-4 h-4 mr-2" />{tc('actions.edit')}
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            onClick={() => handlePublish(deployment.id)}
                                            disabled={publishingStates[deployment.id]}
                                          >
                                            <RefreshCw className="w-4 h-4 mr-2" />
                                            {isPublished ? tc('actions.republish') : tc('actions.publish')}
                                          </DropdownMenuItem>
                                          {isPublished && (
                                            <DropdownMenuItem asChild>
                                              <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                                                <ExternalLink className="w-4 h-4 mr-2" />{tc('actions.openLink')}
                                              </a>
                                            </DropdownMenuItem>
                                          )}
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      <DropdownMenuItem onClick={() => handleEditProject(deployment)}>
                                        <Pencil className="w-4 h-4 mr-2" />{t('editProject')}
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator />
                                      {isPublished && (
                                        <DropdownMenuItem onClick={() => copyDeploymentUrl(publicUrl, t('urlCopied'))}>
                                          <Copy className="w-4 h-4 mr-2" />{tc('actions.copyUrl')}
                                        </DropdownMenuItem>
                                      )}
                                      {isPublished && (
                                        <DropdownMenuItem onClick={() => handleUnpublish(deployment.id)}>
                                          <EyeOff className="w-4 h-4 mr-2" />{tc('actions.unpublish')}
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem onClick={() => handleDelete(deployment.id)} className="text-destructive focus:text-destructive">
                                        <Trash2 className="w-4 h-4 mr-2" />{tc('actions.delete')}
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-auto">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {deploymentsPagination.pageItems.map((deployment) => {
                      const project = projects.find(p => p.id === deployment.projectId);
                      return (
                        <DeploymentCard
                          key={deployment.id}
                          deployment={deployment}
                          project={project}
                          isPublishing={publishingStates[deployment.id] || false}
                          onClick={handleOpenDetail}
                          onViewAnalytics={handleViewAnalytics}
                          onEditProject={handleEditProject}
                          onPublish={handlePublish}
                          onUnpublish={handleUnpublish}
                          onDelete={handleDelete}
                          onExportAsTemplate={handleExportAsTemplate}
                          onThumbnailChange={handleDeploymentThumbnailChange}
                        />
                      );
                    })}
                    </div>
                  </div>
                )}
              </div>
            )}
        </PageBody>
      </PageShell>

      {selectedDeployment && showAnalyticsModal && (
        <AnalyticsDashboard
          deployment={selectedDeployment}
          isOpen={showAnalyticsModal}
          onClose={() => {
            setShowAnalyticsModal(false);
            setSelectedDeployment(null);
          }}
        />
      )}

      <CreateDeploymentModal
        projects={projects}
        initialProjectId={createForProjectId}
        key={createForProjectId ?? 'new'}
        isOpen={showCreateModal}
        onClose={() => {
          setShowCreateModal(false);
          setCreateForProjectId(undefined);
        }}
        onCreate={handleCreateDeployment}
      />

      <TemplateExportDialog
        project={templateExportProject}
        open={showTemplateExportModal}
        onOpenChange={(open) => {
          setShowTemplateExportModal(open);
          if (!open) {
            setTemplateExportProject(null);
          }
        }}
      />

      {swapDialogState && (
        <ProjectSwapDialog
          isOpen={true}
          onClose={() => swapDialogState.resolve(false)}
          deploymentId={swapDialogState.deploymentId}
          deploymentName={swapDialogState.deploymentName}
          currentProjectId={swapDialogState.currentProjectId}
          newProjectId={swapDialogState.newProjectId}
          newProjectName={swapDialogState.newProjectName}
          onConfirm={() => swapDialogState.resolve(true)}
          workspaceId={workspaceId}
        />
      )}
    </>
  );
}
