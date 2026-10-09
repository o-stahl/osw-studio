'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useTemplateCatalog, type TemplateCopy } from '@/lib/i18n/use-template-catalog';
import { useRouter } from 'next/navigation';
import { Project, CustomTemplate, type BackendFeatures, type PromptSuggestion, type TemplateIntent } from '@/lib/vfs/types';
import { getRuntimeBadge } from '@/lib/runtimes/registry';
import { vfs } from '@/lib/vfs';
import { templateService } from '@/lib/vfs/template-service';
import { clearLegacyProjectSchema } from '@/lib/vfs/project-schema';
import { TemplateBrowserPanel, runtimeForTemplate } from '@/components/template-browser';
import { logger } from '@/lib/utils';
import { sweepTemplatePreviewProjects } from '@/lib/vfs/templates/preview-project';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ProjectCard } from './project-card';
import { ProjectTableRow } from './project-table-row';
import { MultipagePreview } from '@/components/preview/multipage-preview';
import { AboutModal } from '@/components/about-modal';
import {
  Plus,
  FileArchive,
  FolderOpen,
  Upload,
  Search,
  ArrowUpDown,
  Info,
  TestTube,
  Github,
  MessageSquare,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { ViewModeToggle, useViewMode } from '@/components/ui/view-mode-toggle';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ImportDialog, type ImportDialogSource } from '@/components/import-dialog';
import { pickFolderSource } from '@/components/import-dialog/pick';
import type { ApplyResult } from '@/lib/vfs/archive';
import { toast } from 'sonner';
import { pushProjectToServer } from '@/lib/vfs/push-project-to-server';
import { SERVER_PROJECTS_CHANGED } from '@/lib/vfs/sync-events';
import { refreshProjectSyncState } from '@/lib/vfs/project-sync-state';
import { provisionBackendFeatures } from '@/lib/vfs/provision-backend-features';
import { seedPromptSuggestions } from '@/lib/vfs/prompt-suggestions';
import {
  createProjectFromTemplate,
  customTemplateToProjectTemplate,
  getBuiltInTemplateDefinition,
  loadBuiltInProjectTemplate,
  BUILT_IN_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  type ProjectTemplate,
} from '@/lib/vfs/project-templates';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { migrateBackendKey } from '@/lib/config/storage';
import { TemplateExportDialog } from '@/components/templates/template-export-dialog';
import { ProjectSettingsModal } from '@/components/project-backend';
import { DescribeMode } from '@/components/describe-mode';
import { track } from '@/lib/telemetry';
import { usePagination } from '@/lib/hooks/use-pagination';
import { Pagination, PaginationRange } from '@/components/ui/pagination';
import { COMPACT_ROW_WIDTH } from '@/lib/constants/layout';
import { useNarrowContainer } from '@/lib/hooks/use-narrow-container';
import { REPO_URL } from '@/lib/constants/links';
import { ServerDeleteRefused, deleteProjectServerFirst } from '@/lib/vfs/auto-sync';

interface ProjectManagerProps {
  onProjectSelect: (project: Project) => void;
  hideHeader?: boolean; // Hide header when used in PageLayout
  hideFooter?: boolean; // Hide footer when used in PageLayout
  autoCreate?: boolean; // Auto-open create dialog when navigating from dashboard
  workspaceId?: string;
}

type SortOption = 'updated' | 'created' | 'name';

/** A template id as the create dialog names it: a custom template by its name, a built-in in the interface language. */
export function templateDisplayName(
  templateId: string,
  customTemplates: CustomTemplate[],
  templateCatalog: Record<string, TemplateCopy>,
  t: (key: 'customTemplate' | 'selectTemplate') => string,
): string {
  if (templateId.startsWith('custom:')) {
    const customId = templateId.replace('custom:', '');
    const template = customTemplates.find(t => t.id === customId);
    return template?.name || t('customTemplate');
  }
  const builtIn = BUILT_IN_TEMPLATES.find(t => t.id === templateId);
  if (!builtIn) return t('selectTemplate');
  return templateCatalog[builtIn.id]?.name ?? builtIn.name;
}

/** A template id's description, translated for a built-in; empty when there is none. */
export function templateDescription(
  templateId: string,
  customTemplates: CustomTemplate[],
  templateCatalog: Record<string, TemplateCopy>,
): string {
  if (templateId.startsWith('custom:')) {
    const customId = templateId.replace('custom:', '');
    return customTemplates.find(t => t.id === customId)?.description || '';
  }
  const builtIn = BUILT_IN_TEMPLATES.find(t => t.id === templateId);
  if (!builtIn) return '';
  return templateCatalog[builtIn.id]?.description ?? builtIn.description ?? '';
}

export function ProjectManager({ onProjectSelect, hideHeader = false, hideFooter = false, autoCreate = false, workspaceId }: ProjectManagerProps) {
  const t = useTranslations('projects');
  const templateCatalog = useTemplateCatalog();
  const tSort = useTranslations('common.sort');
  const tNav = useTranslations('nav');
  const tc = useTranslations('common');
  const router = useRouter();
  // Offered only where the route exists. In the simple view the row already opens quick edit, so
  // this is the studio's way in: the fast path for a small change without opening four panels.
  const openQuickEdit = workspaceId && process.env.NEXT_PUBLIC_SERVER_MODE === 'true'
    ? (project: Project) => router.push(`/w/${workspaceId}/quick/${project.id}`)
    : undefined;
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  // Handlebars rather than static: partials mean a nav or footer is written once instead of
  // copied into every page, which is the difference the assistant pays for on a multi-page site.
  const [newProjectTemplate, setNewProjectTemplate] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [customTemplates, setCustomTemplates] = useState<CustomTemplate[]>([]);
  const [createMode, setCreateMode] = useState<'quick' | 'describe' | 'template'>('quick');
  const [templatePending, setTemplatePending] = useState<string | null>(null);
  const [describeDirty, setDescribeDirty] = useState(false);

  // The template owns the runtime now, so there is nothing separate to pick or reset.
  const newProjectRuntime = useMemo(
    () => runtimeForTemplate(newProjectTemplate, customTemplates),
    [newProjectTemplate, customTemplates]
  );

  const isQuickDirty = createMode !== 'describe' && (
    newProjectName !== '' || newProjectDescription !== '' ||
    newProjectTemplate !== DEFAULT_TEMPLATE_ID
  );
  const isCreateDirty = createMode === 'describe' ? describeDirty : isQuickDirty;

  const confirmDiscard = useCallback((action: () => void) => {
    if (!isCreateDirty || window.confirm(t('discardUnsavedConfirm'))) {
      action();
    }
  }, [isCreateDirty, t]);

  // Auto-open create dialog when navigated from dashboard "New Project"
  useEffect(() => {
    if (autoCreate) {
      setCreateDialogOpen(true);
    }
  }, [autoCreate]);

  // Helper to get template name from ID for display
  const getTemplateDisplayName = (templateId: string): string =>
    templateDisplayName(templateId, customTemplates, templateCatalog, t);

  const getTemplateDescription = (templateId: string): string =>
    templateDescription(templateId, customTemplates, templateCatalog);
  const [sortBy, setSortBy] = useState<SortOption>('updated');
  const [viewMode, setViewMode] = useViewMode('projects');
  const [previewProject, setPreviewProject] = useState<Project | null>(null);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [templateExportProject, setTemplateExportProject] = useState<Project | null>(null);
  const [backendProject, setBackendProject] = useState<Project | null>(null);
  const [importSource, setImportSource] = useState<ImportDialogSource | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { state: tourState, setProjectList, start: startTour } = useGuidedTour();
  const tourStep = tourState.currentStep?.id;
  const tourRunning = tourState.status === 'running';
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [backgroundPullDone, setBackgroundPullDone] = useState(
    process.env.NEXT_PUBLIC_SERVER_MODE !== 'true'
  );
  const [tourActionProjectId, setTourActionProjectId] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const demoCreationRef = useRef(false);
  const listScrollRef = useRef<HTMLElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [compactRows, measureRowsRef] = useNarrowContainer(COMPACT_ROW_WIDTH);

  // Derive backend enabled state from localStorage
  const backendProjectEnabled = backendProject ? migrateBackendKey(backendProject.id) : true;

  const loadCustomTemplates = useCallback(async () => {
    try {
      const templates = await templateService.listCustomTemplates();
      setCustomTemplates(templates);
    } catch (error) {
      logger.error('Failed to load custom templates:', error);
      // Don't show error toast - this is background loading
    }
  }, []);

  const loadProjects = useCallback(async () => {
    // Prevent concurrent executions
    if (loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    setLoading(true);
    let localLoadOk = false;

    try {
      await vfs.init();

      // A tab closed mid-preview leaves its scratch project behind, and the list has no filter of
      // its own, so it would show up here as a project called "Preview: something".
      await sweepTemplatePreviewProjects(vfs);

      // Load local projects immediately — don't block on server sync
      const projectList = await vfs.listProjects();
      const sorted = projectList.sort((a, b) =>
        b.updatedAt.getTime() - a.updatedAt.getTime()
      );
      setProjects(sorted);
      setProjectList(sorted);

      // Also load custom templates
      await loadCustomTemplates();
      localLoadOk = true;

    } catch (error) {
      logger.error('Failed to load projects:', error);
      toast.error(t('loadFailed'));

    } finally {
      setLoading(false);
      setInitialLoadComplete(true);
      loadingRef.current = false;
    }

    // In server mode, pull updates in the background and merge silently
    if (localLoadOk && process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
      try {
        const { autoPullAllProjects, reconcileProjectsToServer, setAutoSyncWorkspaceId } = await import('@/lib/vfs/auto-sync');
        if (workspaceId) {
          setAutoSyncWorkspaceId(workspaceId);
        }
        const result = await autoPullAllProjects();
        // Reconcile projects the server is behind on (imports, an earlier failed push, or a local
        // edit that does not sync itself) so they stay deployable without a manual Server Sync.
        // Self-heals every load.
        const reconcile = await reconcileProjectsToServer(workspaceId);
        if (result.pulled > 0 || reconcile.pushed > 0) {
          // Silently refresh the project list with newly pulled/pushed data
          const updated = await vfs.listProjects();
          const sortedUpdated = updated.sort((a, b) =>
            b.updatedAt.getTime() - a.updatedAt.getTime()
          );
          setProjects(sortedUpdated);
          setProjectList(sortedUpdated);
        }
        if (result.conflicts.length > 0) {
          toast.warning(
            t('conflictsEdited', { count: result.conflicts.length }),
            { duration: 8000 }
          );
        }
        // Compute sync status once for every project, after the pull and reconcile have settled,
        // so the card badges and the sidebar count reflect the final state rather than the
        // mid-reconcile one. This view owns the refresh; other consumers only subscribe.
        await refreshProjectSyncState();
      } catch (syncErr) {
        logger.warn('[ProjectManager] Background sync failed:', syncErr);
      } finally {
        setBackgroundPullDone(true);
      }
    }
  }, [setProjectList, loadCustomTemplates, t]);

  // Separate function for reloading projects without demo creation logic
  const reloadProjects = useCallback(async () => {
    try {
      await vfs.init();
      const projectList = await vfs.listProjects();
      const sorted = projectList.sort((a, b) => 
        b.updatedAt.getTime() - a.updatedAt.getTime()
      );
      setProjects(sorted);
      setProjectList(sorted);
    } catch (error) {
      logger.error('Failed to reload projects:', error);
      toast.error(t('reloadFailed'));
    }
  }, [setProjectList, t]);

  const createDemoProject = async () => {
    if (demoCreationRef.current) {
      return; // Prevent multiple demo creations
    }
    
    demoCreationRef.current = true;
    
    try {
      const demo = await loadBuiltInProjectTemplate('demo');
      // The project's own name from here on, so it is written in the language of the person creating it.
      const demoProject = await vfs.createProject(
        templateCatalog.demo.name,
        templateCatalog.demo.description
      );
      await createProjectFromTemplate(vfs, demoProject.id, demo, demo.assets);
      toast.success(t('demoCreated'));
      await reloadProjects();
      onProjectSelect(demoProject);
      return demoProject;
    } catch (error) {
      logger.error('Failed to create demo project:', error);
      toast.error(t('demoCreateFailed'));
      demoCreationRef.current = false; // Reset on failure
      throw error;
    }
  };

  // The tour creates its own demo project when it starts.
  const handleStartTour = () => {
    void startTour();
  };

  // Initial load only - no dependency on loadProjects to prevent re-runs
  useEffect(() => {
    if (!initialLoadComplete) {
      loadProjects();
    }
  }, []);

  // Keep the new-project template picker current when a template is imported/saved/deleted
  // (e.g. from the Templates view), without relying on a remount or a full app reload.
  // The guided tour adds and removes its demo project; show the change.
  useEffect(() => {
    const handleProjectsChanged = () => { void reloadProjects(); };
    window.addEventListener('projectsChanged', handleProjectsChanged);
    return () => window.removeEventListener('projectsChanged', handleProjectsChanged);
  }, [reloadProjects]);

  useEffect(() => {
    const handleTemplatesChanged = () => { loadCustomTemplates(); };
    window.addEventListener('templatesChanged', handleTemplatesChanged);
    return () => window.removeEventListener('templatesChanged', handleTemplatesChanged);
  }, [loadCustomTemplates]);

  // A push or pull from the Server Sync dialog changes the local projects it touched; re-read
  // rather than leaving the gallery on the list it mounted with.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
    const handleServerProjectsChanged = () => { void reloadProjects(); };
    window.addEventListener(SERVER_PROJECTS_CHANGED, handleServerProjectsChanged);
    return () => window.removeEventListener(SERVER_PROJECTS_CHANGED, handleServerProjectsChanged);
  }, [reloadProjects]);

  useEffect(() => {
    if (tourRunning && tourStep !== 'create-project') {
      if (createDialogOpen) {
        setCreateDialogOpen(false);
      }
    }
  }, [tourRunning, tourStep, createDialogOpen]);

  useEffect(() => {
    if (tourRunning && tourStep === 'project-controls' && projects.length > 0) {
      setTourActionProjectId(projects[0].id);
    } else {
      setTourActionProjectId(null);
    }
  }, [tourRunning, tourStep, projects]);

  const createProject = async () => {
    if (!newProjectName.trim()) {
      toast.error(t('nameRequired'));
      return;
    }

    if (newProjectName.length > 50) {
      toast.error(t('nameTooLong'));
      return;
    }

    if (newProjectDescription.length > 200) {
      toast.error(t('descTooLong'));
      return;
    }

    if (process.env.NEXT_PUBLIC_SERVER_MODE === 'true') {
      try {
        const { getAutoSyncApiUrl } = await import('@/lib/vfs/auto-sync');
        const { apiFetch } = await import('@/lib/api/backend-status');
        const res = await apiFetch(getAutoSyncApiUrl('/sync/status'));
        if (res.ok) {
          const data = await res.json();
          const quota = data.quota?.projects;
          if (quota && quota.used >= quota.max) {
            toast.error(t('limitReached', { max: quota.max }));
            return;
          }
        }
      } catch (e) { logger.warn('[ProjectManager] Quota check failed:', e); }
    }

    try {
      // Resolved before the project exists. A built-in's files are a lazily imported chunk, so a
      // failure here would otherwise land between creating the project and filling it, leaving an
      // empty project behind with no way to tell it apart from a deliberate one.
      let projectTemplate: ProjectTemplate | undefined;
      let backendFeatures: BackendFeatures | undefined;
      let templateIntent: TemplateIntent | undefined;
      let promptSuggestions: PromptSuggestion[] | undefined;

      if (newProjectTemplate.startsWith('custom:')) {
        const customTemplateId = newProjectTemplate.replace('custom:', '');
        const customTemplate = customTemplates.find(t => t.id === customTemplateId);
        if (customTemplate) {
          projectTemplate = customTemplateToProjectTemplate(customTemplate);
          templateIntent = customTemplate.metadata?.intent;
          promptSuggestions = seedPromptSuggestions(customTemplate.metadata?.promptSuggestions);
        }
      } else {
        // An id the catalog no longer knows falls back to blank, the same way the switch this
        // replaced did: it can come from a stale selection rather than from a bug.
        const definition =
          getBuiltInTemplateDefinition(newProjectTemplate) ?? getBuiltInTemplateDefinition('blank');
        if (definition) {
          projectTemplate = await definition.loadProjectTemplate();
          backendFeatures = projectTemplate.backendFeatures;
          templateIntent = definition.metadata?.intent;
          promptSuggestions = seedPromptSuggestions(definition.promptSuggestions);
        }
      }

      const project = await vfs.createProject(
        newProjectName.trim().slice(0, 50),
        newProjectDescription.trim().slice(0, 200) || undefined
      );

      // Persist runtime in project settings and keep updated object for onProjectSelect
      const finalProject: Project = {
        ...project,
        settings: { ...project.settings, runtime: newProjectRuntime, promptSuggestions },
      };
      await vfs.updateProject(finalProject);

      if (projectTemplate) {
        await createProjectFromTemplate(
          vfs,
          finalProject.id,
          projectTemplate,
          projectTemplate.assets
        );
      }

      // Provision backend features if the selected template has them
      {
        if (backendFeatures) {
          try {
            await provisionBackendFeatures(finalProject.id, backendFeatures);
          } catch (provisionError) {
            logger.error('Failed to provision backend features:', provisionError);
            toast.warning(t('backendProvisionFailed'));
          }
        }
      }

      // Trigger auto-sync so new project is pushed to server immediately
      vfs.scheduleAutoSync(finalProject.id);

      track('project_create', {
        method: 'quick',
        runtime: newProjectRuntime,
        template: newProjectTemplate.startsWith('custom:') ? 'custom' : newProjectTemplate,
        // Absent for an imported template, which does not declare one. Reported rather than
        // guessed: the point of recording it is to learn which section people actually pick from.
        template_intent: templateIntent,
      });

      toast.success(t('created'));
      setCreateDialogOpen(false);
      setCreateMode('quick');
      setNewProjectName('');
      setNewProjectDescription('');
      setNewProjectTemplate('blank');
      await reloadProjects();
      onProjectSelect(finalProject);
    } catch (error) {
      logger.error('Failed to create project:', error);
      toast.error(t('createFailed'));
    }
  };

  const deleteProject = useCallback(async (project: Project) => {
    if (!confirm(t('confirmDelete', { name: project.name }))) {
      return;
    }

    try {
      await deleteProjectServerFirst(project.id);
      clearLegacyProjectSchema(project.id);
      toast.success(t('deleted'));
      track('project_delete');
      await reloadProjects();
    } catch (error) {
      logger.error('Failed to delete project:', error);
      toast.error(error instanceof ServerDeleteRefused ? error.message : t('deleteFailed'));
    }
  }, [reloadProjects, t]);

  const duplicateProject = useCallback(async (project: Project) => {
    try {
      const newProject = await vfs.duplicateProject(project.id);
      await pushProjectToServer(newProject.id, workspaceId);
      toast.success(t('duplicated'));
      await reloadProjects();
      onProjectSelect(newProject);
    } catch (error) {
      logger.error('Failed to duplicate project:', error);
      toast.error(t('duplicateFailed'));
    }
  }, [reloadProjects, onProjectSelect, workspaceId, t]);

  const exportProject = useCallback(async (project: Project) => {
    try {
      const data = await vfs.exportProject(project.id);
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/\s+/g, '-')}-export.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t('exported'));
      track('project_export', { format: 'json' });
    } catch (error) {
      logger.error('Failed to export project:', error);
      toast.error(t('exportFailed'));
    }
  }, [t]);

  const exportProjectAsZip = useCallback(async (project: Project) => {
    try {
      const blob = await vfs.exportProjectAsZip(project.id);
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/\s+/g, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(t('exportedZip'));
      track('project_export', { format: 'zip' });
    } catch (error) {
      logger.error('Failed to export project as ZIP:', error);
      toast.error(t('exportZipFailed'));
    }
  }, [t]);

  // A fresh object every time, so the dialog re-analyses whenever the user picks something new.
  const openImport = useCallback((source: ImportDialogSource) => {
    setImportSource(source);
    setImportOpen(true);
  }, []);

  /**
   * The legacy format: a `.json` export parses and writes straight through, with no preview, as it
   * always has. People have those files, so it stays exactly as it was.
   */
  const importProjectJson = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.project || !data.files) {
        throw new Error('Invalid project file');
      }

      const imported = await vfs.importProject(data);
      await pushProjectToServer(imported.id, workspaceId);
      toast.success(t('imported'));
      track('project_import', { format: 'json' });
      await reloadProjects();
      onProjectSelect(imported);
    } catch (error) {
      logger.error('Failed to import project:', error);
      toast.error(t('importFailed'));
    }
  };

  const importProjectFromFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.json';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      // `.json` is the one legacy format, and the only thing that may be handed to JSON.parse.
      // Everything else goes to the preview, which reads the zip and says which importer a
      // workspace backup or a template needs — `accept` is advisory, and this is exactly where
      // someone reaching for a backup file starts.
      if (/\.json$/i.test(file.name)) {
        await importProjectJson(file);
        return;
      }
      openImport({ kind: 'zip', file });
    };

    input.click();
  };

  const handleImportComplete = useCallback(async (result: ApplyResult) => {
    try {
      // Throws rather than returning null when the project is not there.
      const imported = await vfs.getProject(result.projectId);
      await pushProjectToServer(imported.id, workspaceId);
      track('project_import', { format: importSource?.kind === 'folder' ? 'folder' : 'archive' });
      await reloadProjects();
      onProjectSelect(imported);
    } catch (error) {
      logger.error('Failed to open the imported project:', error);
      toast.error(t('importedNotOpened'));
      await reloadProjects();
    }
  }, [importSource, workspaceId, reloadProjects, onProjectSelect, t]);

  const sortProjects = (projects: Project[], sortBy: SortOption): Project[] => {
    const sorted = [...projects];
    switch (sortBy) {
      case 'updated':
        return sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      case 'created':
        return sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      case 'name':
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
      default:
        return sorted;
    }
  };

  const handleProjectUpdate = useCallback(async (updatedProject: Project) => {
    await vfs.updateProject(updatedProject);
    vfs.scheduleAutoSync(updatedProject.id);
    setProjects(prev => prev.map(p =>
      p.id === updatedProject.id ? updatedProject : p
    ));
  }, []);

  const filteredProjects = sortProjects(
    projects.filter(project =>
      project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      project.description?.toLowerCase().includes(searchQuery.toLowerCase())
    ),
    sortBy
  );

  const projectsPagination = usePagination(filteredProjects, {
    perPage: 24,
    resetOn: [searchQuery, sortBy],
  });

  if (loading && !initialLoadComplete) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <Spinner size={48} className="mx-auto text-primary" />
          <p className="mt-4">{t('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${hideHeader ? 'h-full' : 'h-[100dvh]'}`} style={{ background: `linear-gradient(var(--project-background-tint), var(--project-background-tint)), var(--background)` }}>
      {/* Main Content */}
      <main ref={listScrollRef} className="flex-1 min-h-0 overflow-auto">
        <div className="h-full flex flex-col">
            {/* Toolbar */}
            <div className="pt-4 px-4 pb-3 sm:pt-6 sm:px-6 sm:pb-3 shrink-0">
              <div className="mx-auto max-w-7xl flex flex-col sm:flex-row sm:items-center gap-3" data-tour-id="projects-actions">
                <h1 className="text-lg font-semibold shrink-0">{tc('terms.projects')}</h1>
                {/* New Project */}
                <div className="flex items-center shrink-0">
                  <Button onClick={() => setCreateDialogOpen(true)} size="sm" className="gap-2" data-tour-id="new-project-button">
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
                        <h4 className="font-semibold text-sm">{tSort('by')}</h4>
                        <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortOption)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="updated">{tSort('lastUpdated')}</SelectItem>
                            <SelectItem value="created">{tSort('dateCreated')}</SelectItem>
                            <SelectItem value="name">{tc('labels.name')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </PopoverContent>
                  </Popover>

                  {/* View Mode */}
                  <ViewModeToggle value={viewMode} onChange={setViewMode} />

                  {/* Import — a file or a folder, since one input cannot offer both */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2">
                        <Upload className="h-4 w-4" />
                        <span>{tc('actions.import')}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={importProjectFromFile}>
                        <FileArchive className="h-4 w-4 mr-2" />
                        {t('fromFile')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => pickFolderSource(openImport)}>
                        <FolderOpen className="h-4 w-4 mr-2" />
                        {t('fromFolder')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {/* Projects Grid/List */}
            <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="mx-auto w-full max-w-7xl flex-1 min-h-0 flex flex-col">
                {filteredProjects.length === 0 && !backgroundPullDone ? (
                  <div className="flex items-center justify-center py-12">
                    <Spinner size={24} className="text-muted-foreground" />
                    <span className="ml-3 text-muted-foreground">{t('loading')}</span>
                  </div>
                ) : filteredProjects.length === 0 ? (
                  <div className="text-center py-12">
                    <FolderOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h2 className="text-xl font-semibold mb-2">
                      {searchQuery ? t('noProjectsFound') : t('noProjectsYet')}
                    </h2>
                    <p className="text-muted-foreground mb-6">
                      {searchQuery
                        ? t('tryDifferentSearch')
                        : t('createFirstProjectHint')}
                    </p>
                    {!searchQuery && (
                      <div className="flex gap-3 justify-center">
                        <Button onClick={() => setCreateDialogOpen(true)}>
                          <Plus className="mr-2 h-4 w-4" />
                          {t('createProject')}
                        </Button>
                        <Button variant="outline" onClick={createDemoProject}>
                          <FolderOpen className="mr-2 h-4 w-4" />
                          {t('createDemoProject')}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {projectsPagination.totalPages > 1 && (
                      <div className="flex items-center justify-between gap-3 mb-2 shrink-0">
                        <PaginationRange
                          total={projectsPagination.total}
                          rangeStart={projectsPagination.rangeStart}
                          rangeEnd={projectsPagination.rangeEnd}
                          totalPages={projectsPagination.totalPages}
                        />
                        <Pagination
                          page={projectsPagination.page}
                          totalPages={projectsPagination.totalPages}
                          onPageChange={projectsPagination.setPage}
                          scrollTarget={contentScrollRef}
                          className="pt-0 pb-0"
                        />
                      </div>
                    )}
                    {/* The tour points at the grid's cards and their menu, which the table rows lack. */}
                    {viewMode === 'table' && !tourRunning ? (
                      <div ref={(el) => { contentScrollRef.current = el; measureRowsRef(el); }} className="@container flex-1 min-h-0 overflow-auto border rounded-lg" data-tour-id="projects-list">
                        <table className="w-full table-auto border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none"></th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none w-full">{tc('labels.name')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.runtime')}</th>
                              <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('columns.files')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('columns.size')}</th>
                              <th className="@max-5xl:hidden bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('columns.cost')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.updated')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {projectsPagination.pageItems.map(project => {
                              if (typeof project !== 'object' || !project.id || !project.name) return null;
                              return (
                                <ProjectTableRow
                                  compactRows={compactRows}
                                  key={project.id}
                                  project={project}
                                  onSelect={onProjectSelect}
                                  onDelete={deleteProject}
                                  onExport={exportProject}
                                  onExportZip={exportProjectAsZip}
                                  onDuplicate={duplicateProject}
                                  onPreview={setPreviewProject}
                                  onExportAsTemplate={setTemplateExportProject}
                                  onBackend={setBackendProject}
                                  onQuickEdit={openQuickEdit}
                                  onUpdate={handleProjectUpdate}
                                />
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-auto" data-tour-id="projects-list">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {projectsPagination.pageItems.map(project => {
                            if (typeof project !== 'object' || !project.id || !project.name) {
                              logger.error('Invalid project object:', project);
                              return null;
                            }
                            return (
                              <ProjectCard
                                key={project.id}
                                project={project}
                                onSelect={onProjectSelect}
                                onDelete={deleteProject}
                                onExport={exportProject}
                                onExportZip={exportProjectAsZip}
                                onDuplicate={duplicateProject}
                                onPreview={setPreviewProject}
                                onExportAsTemplate={setTemplateExportProject}
                                onBackend={setBackendProject}
                                onUpdate={handleProjectUpdate}
                                viewMode="grid"
                                forceMenuOpen={tourActionProjectId === project.id}
                                highlightExport={tourRunning && tourStep === 'project-controls' && tourActionProjectId === project.id}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
      </main>

      {/* Footer with Navigation Buttons - Hidden on mobile */}
      {!hideFooter && (
        <footer className="hidden md:block border-t bg-card/50 py-3 px-6">
          <div className="flex justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleStartTour}
              disabled={tourRunning}
              data-tour-id="footer-guided-tour"
            >
              <Info className="mr-2 h-4 w-4" />
              {tNav('items.tour')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/test-generation')}
            >
              <TestTube className="mr-2 h-4 w-4" />
              {tNav('items.tester')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAboutModalOpen(true)}
            >
              <Info className="mr-2 h-4 w-4" />
              {t('about')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild
            >
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="mr-2 h-4 w-4" />
                GitHub
              </a>
            </Button>
          </div>
        </footer>
      )}

      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        if (!open) {
          confirmDiscard(() => {
            setCreateDialogOpen(false);
            setCreateMode('quick');
            setDescribeDirty(false);
          });
        } else {
          setCreateDialogOpen(true);
        }
      }}>
        <DialogContent
          className={
            createMode === 'describe'
              ? "sm:max-w-5xl h-[80vh] flex flex-col p-0 gap-0"
              : createMode === 'template'
                ? "sm:max-w-2xl h-[80vh] flex flex-col p-0 gap-0"
                : "sm:max-w-md"
          }
          onInteractOutside={(e) => { if (isCreateDirty) e.preventDefault(); }}
          onEscapeKeyDown={(e) => {
            if (isCreateDirty) {
              e.preventDefault();
              confirmDiscard(() => {
                setCreateDialogOpen(false);
                setCreateMode('quick');
                setDescribeDirty(false);
              });
            }
          }}
        >
          {createMode === 'describe' ? (
            /* ── Describe mode header ── */
            <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => confirmDiscard(() => { setCreateMode('quick'); setDescribeDirty(false); })}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <DialogTitle className="text-sm">{t('describeProject')}</DialogTitle>
                <DialogDescription className="sr-only">{t('describeProjectSr')}</DialogDescription>
              </div>
            </DialogHeader>
          ) : createMode === 'template' ? (
            /* ── Template mode header ── */
            <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCreateMode('quick')}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-0 flex items-baseline gap-2">
                  <DialogTitle className="text-sm shrink-0">{t('chooseTemplate')}</DialogTitle>
                  <span className="text-xs text-muted-foreground truncate">
                    {getTemplateDisplayName(templatePending ?? newProjectTemplate)}
                  </span>
                </div>
                <DialogDescription className="sr-only">
                  {t('templateHint')}
                </DialogDescription>
              </div>
            </DialogHeader>
          ) : (
            /* ── Quick mode header ── */
            <DialogHeader>
              <DialogTitle>{t('createTitle')}</DialogTitle>
              <DialogDescription className="sr-only">{t('setUpNewProjectSr')}</DialogDescription>
            </DialogHeader>
          )}
          {createMode === 'quick' ? (
            <>
              {/* Describe CTA — top card */}
              <button
                type="button"
                onClick={() => setCreateMode('describe')}
                className="w-full flex items-center gap-3 px-3.5 py-3 rounded-lg border border-primary/30 bg-primary/5 text-left hover:bg-primary/10 transition-colors group"
              >
                <div className="h-9 w-9 rounded-md bg-primary/15 flex items-center justify-center shrink-0">
                  <MessageSquare className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-primary">{t('planFirst')}</p>
                  <p className="text-xs text-muted-foreground">{t('planFirstHint')}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-primary/60 shrink-0 group-hover:translate-x-0.5 transition-transform" />
              </button>

              {/* min-w-0: this is a grid item of DialogContent, so its automatic minimum is its
                  min-content — which the template row's nowrap description would otherwise push
                  past the dialog's max width, stretching every sibling with it. */}
              <div className="space-y-4 min-w-0">
                <div>
                  <div className="flex justify-between items-center">
                    <Label htmlFor="name">{t('nameLabel')}</Label>
                    <span className="text-xs text-muted-foreground">
                      {newProjectName.length}/50
                    </span>
                  </div>
                  <Input
                    id="name"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value.slice(0, 50))}
                    placeholder={t('namePlaceholder')}
                    className="mt-2"
                    maxLength={50}
                  />
                </div>
                <div>
                  <Label htmlFor="template">{t('templateLabel')}</Label>
                  <button
                    id="template"
                    type="button"
                    onClick={() => { setTemplatePending(newProjectTemplate); setCreateMode('template'); }}
                    className="mt-2 w-full flex items-center gap-3 rounded-md border border-input bg-background px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {getTemplateDisplayName(newProjectTemplate)}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground mt-0.5">
                        {getTemplateDescription(newProjectTemplate) || t('browseTemplates')}
                      </span>
                    </span>
                    <Badge
                      className={`text-[10px] px-1.5 py-0 h-auto shrink-0 ${getRuntimeBadge(newProjectRuntime).className}`}
                    >
                      {getRuntimeBadge(newProjectRuntime).label}
                    </Badge>
                    <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {t('templateSetsRuntime')}
                  </p>
                </div>
                <div>
                  <div className="flex justify-between items-center">
                    <Label htmlFor="description">{tc('labels.descriptionOptional')}</Label>
                    <span className="text-xs text-muted-foreground">
                      {newProjectDescription.length}/200
                    </span>
                  </div>
                  <Textarea
                    id="description"
                    value={newProjectDescription}
                    onChange={(e) => setNewProjectDescription(e.target.value.slice(0, 200))}
                    placeholder={t('descriptionPlaceholder')}
                    className="mt-2 resize-none"
                    rows={3}
                    maxLength={200}
                  />
                </div>
              </div>
              <DialogFooter className="sm:justify-between">
                <Button variant="outline" onClick={() => confirmDiscard(() => { setCreateDialogOpen(false); setCreateMode('quick'); })}>
                  {tc('actions.cancel')}
                </Button>
                <Button onClick={createProject}>
                  {t('create')}
                </Button>
              </DialogFooter>
            </>
          ) : createMode === 'template' ? (
            <TemplateBrowserPanel
              customTemplates={customTemplates}
              value={newProjectTemplate}
              onConfirm={(value) => { setNewProjectTemplate(value); setCreateMode('quick'); }}
              onCancel={() => setCreateMode('quick')}
              onPendingChange={setTemplatePending}
              workspaceId={workspaceId}
            />
          ) : (
            <div className="flex-1 min-h-0">
              <DescribeMode
                onProjectCreated={(project) => {
                  setCreateDialogOpen(false);
                  setCreateMode('quick');
                  setDescribeDirty(false);
                  reloadProjects();
                  onProjectSelect(project);
                }}
                onDirtyChange={setDescribeDirty}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Preview Modal */}
      {previewProject && (
        <Dialog open={!!previewProject} onOpenChange={() => setPreviewProject(null)}>
          <DialogContent className="max-w-[90vw] sm:max-w-[85vw] lg:max-w-[80vw] 2xl:max-w-[1400px] max-h-[90vh] w-full h-full p-0 flex flex-col">
            <DialogHeader className="p-4 border-b">
              <DialogTitle>{t('preview', { name: previewProject.name })}</DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-hidden">
              <MultipagePreview
                projectId={previewProject.id}
                runtime={previewProject.settings?.runtime}
                entryPoint={previewProject.settings?.previewEntryPoint}
                standalone
              />
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Template Export Dialog */}
      <TemplateExportDialog
        project={templateExportProject}
        open={!!templateExportProject}
        onOpenChange={(open) => {
          if (!open) setTemplateExportProject(null);
        }}
      />

      {/* Project Settings Modal */}
      {backendProject && (
        <ProjectSettingsModal
          project={backendProject}
          isOpen={true}
          onClose={() => setBackendProject(null)}
          onProjectUpdate={(updated: Project) => setBackendProject(updated)}
          workspaceId={workspaceId}
          enabled={backendProjectEnabled}
          onToggleEnabled={(enabled: boolean) => {
            localStorage.setItem(`osw-backend-${backendProject.id}`, String(enabled));
            setBackendProject({ ...backendProject }); // Force re-derive enabled state
          }}
        />
      )}

      {/* Import Dialog — a zip or a folder becomes a new project */}
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        source={importSource}
        target={{ kind: 'new-project' }}
        onComplete={handleImportComplete}
      />

      {/* About Modal */}
      <AboutModal
        open={aboutModalOpen}
        onOpenChange={setAboutModalOpen}
      />

      <GuidedTourOverlay location="project-manager" />
    </div>
  );
}
