'use client';

import React, { useState, useCallback, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Project } from '@/lib/vfs/types';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { PageLayout } from '@/components/page-layout';
import { ContentArea } from '@/components/views/content-area';
import { Workspace } from '@/components/workspace';
import { GuidedTourProvider, useGuidedTour } from '@/components/guided-tour/context';
import { GuidedTourOverlay } from '@/components/guided-tour/overlay';
import { AboutModal } from '@/components/about-modal';
import { GenerationShelf } from '@/components/generation-shelf';
import { vfs } from '@/lib/vfs';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';
import { TelemetryBootstrap } from '@/components/telemetry-bootstrap';
import { useProviderAutoAssign } from '@/lib/hooks/use-provider-auto-assign';
import { useProviderSignInReturn } from '@/lib/hooks/use-provider-sign-in-return';
import { useTourOffer } from '@/lib/hooks/use-tour-offer';
import { useModelConfigSignal } from '@/lib/hooks/use-model-config-signal';
import { Spinner } from '@/components/ui/spinner';
import { useStudioView } from '@/components/view-mode-provider';
import { signInReturnProject } from '@/lib/auth/provider-sign-in';
import { shouldAutoCreateFirstProject, opensFirstProject, createFirstProject } from '@/lib/first-run';
import { detectDeploymentType } from '@/lib/telemetry/config';
import { fetchSyncStatus } from '@/lib/vfs/auto-sync';
import { logger } from '@/lib/utils';

type View = 'dashboard' | 'projects' | 'templates' | 'skills' | 'interviews' | 'deployments' | 'users' | 'workspaces' | 'mail' | 'docs' | 'settings';

interface PageWrapperProps {
  view: View;
  workspaceId?: string;
  settingsTab?: string;
  autoCreateProject?: boolean;
  /** Set by the quick-edit route: open this project straight into the fullscreen dock. */
  quickEditProjectId?: string;
}

function getViewRoute(view: string, workspaceId?: string): string {
  const base = workspaceId ? `/w/${workspaceId}` : '/admin';
  const routes: Record<string, string> = {
    dashboard: `${base}/dashboard`,
    projects: `${base}/projects`,
    deployments: `${base}/deployments`,
    settings: `${base}/settings`,
    skills: `${base}/skills`,
    interviews: `${base}/interviews`,
    templates: `${base}/templates`,
    docs: `${base}/docs`,
    mail: `${base}/mail`,
    // System-wide routes (always /admin/)
    users: '/admin/users',
    workspaces: '/admin/workspaces',
  };
  return routes[view] || `${base}/projects`;
}

// A first visit is checked once per page load, like StudioApp's.
let firstRunCheckDone = false;

function PageWrapperInner({ view, workspaceId, settingsTab, autoCreateProject, quickEditProjectId }: PageWrapperProps) {
  const twx = useTranslations('workspace');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Quick edit names its project in the path rather than a search param, but everything downstream,
  // the restore, the spinner, the sidebar suppression, is the same, so it joins here.
  const quickEdit = !!quickEditProjectId;
  const studioView = useStudioView();
  // A sign-in's return opens the project it started from; closing it lets that go.
  const [signInProject, setSignInProject] = useState(signInReturnProject);
  const projectParam = quickEditProjectId ?? searchParams.get('project') ?? signInProject;

  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  /**
   * True while a `?project=` link is still resolving.
   *
   * Without it the list for `view` renders first and is replaced a moment later, so a link straight
   * to a project flashes the projects page on the way in. Initialised from the param so the very
   * first render already knows a project is coming.
   */
  const [restoringProject, setRestoringProject] = useState(() => !!projectParam);
  // Which page the preview should open on, when whoever opened the project cared. Cleared on every
  // open so a page carried in from one comment does not stick to the next project opened.
  const [initialPreviewPath, setInitialPreviewPath] = useState<string | undefined>(undefined);
  const [showAboutModal, setShowAboutModal] = useState(false);

  // Global model auto-assign on provider connect. Mounted here (always-present root) so the
  // Connections UI works both inside and outside a workspace (dashboard -> Settings -> Connections).
  useProviderAutoAssign();
  useProviderSignInReturn();

  // Reactive model-config signal + one-time model migration. Mounted here (always-present root)
  // so ANY ChatPanel (workspace, describe-mode, project-manager) reacts to model picks.
  useModelConfigSignal();

  useEffect(() => {
    useWorkspaceStore.getState().reattachServerTasks();
  }, []);

  // The route decides the surface; the agent's mode is the person's own setting and stays put.
  useEffect(() => {
    if (!quickEdit) return;
    useWorkspaceStore.getState().setQuickEdit(true);
    return () => { useWorkspaceStore.getState().setQuickEdit(false); };
  }, [quickEdit]);

  // Track pageview on view/project changes
  useEffect(() => {
    const path = selectedProject ? 'workspace' : view;
    track('pageview', { path });
  }, [view, selectedProject]);

  const handleNavigate = useCallback((targetView: string) => {
    const route = getViewRoute(targetView, workspaceId);
    router.push(route);
  }, [router, workspaceId]);

  // Dialogs that leave for another view (Deploy to Deployments or Settings, the template browser to
  // Templates) announce it with `nav-to-view`, which StudioApp hears in Browser Mode.
  useEffect(() => {
    const onNavToView = (event: Event) => {
      const target = (event as CustomEvent<{ view?: unknown }>).detail?.view;
      if (typeof target === 'string') handleNavigate(target);
    };
    window.addEventListener('nav-to-view', onNavToView);
    return () => window.removeEventListener('nav-to-view', onNavToView);
  }, [handleNavigate]);

  /**
   * The tour runs on the projects page. Every route mounts its own tour provider, so from anywhere
   * else it travels as `?tour=start` and the projects page starts it on arrival.
   */
  const { state: tourState, start: startTour } = useGuidedTour();
  const handleStartTour = useCallback(() => {
    if (view === 'projects') startTour();
    else router.push(`${getViewRoute('projects', workspaceId)}?tour=start`);
  }, [view, startTour, router, workspaceId]);

  useEffect(() => {
    if (view !== 'projects' || searchParams.get('tour') !== 'start') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('tour');
    window.history.replaceState({}, '', url.toString());
    startTour();
  }, [view, searchParams, startTour]);

  /**
   * The open project lives in `?project=<id>`, so a reload or a shared link returns to it and Back
   * leaves it. pushState rather than router.push: this is the same route either way, and a Next
   * navigation would remount the whole shell to change one search param.
   */
  const writeProjectParam = useCallback((id: string) => {
    // The quick-edit route already carries the project in its path; adding the parameter as well
    // would leave two ids in one URL that could disagree.
    if (quickEdit) return;
    const url = new URL(window.location.href);
    url.searchParams.set('project', id);
    window.history.pushState({}, '', url.toString());
  }, [quickEdit]);

  const clearProjectParam = useCallback(() => {
    setSignInProject(null);
    if (quickEdit) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.history.replaceState({}, '', url.toString());
  }, [quickEdit]);

  const handleProjectOpen = useCallback((project: Project, previewPath?: string) => {
    // In the simple view a project opens into quick edit, which is the whole point of that view:
    // the person it is for has no use for a four-panel editor. Every entry point, the projects
    // list, the dashboard's recent link and the sidebar, comes through here, so this is the only
    // place that has to know.
    if (!studioView && workspaceId) {
      track('project_open');
      router.push(`/w/${workspaceId}/quick/${project.id}`);
      return;
    }
    setSelectedProject(project);
    setInitialPreviewPath(previewPath);
    writeProjectParam(project.id);
    track('project_open');
  }, [writeProjectParam, studioView, workspaceId, router]);

  const handleProjectClose = useCallback(() => {
    if (quickEdit) {
      router.push(getViewRoute('projects', workspaceId));
      return;
    }
    setSelectedProject(null);
    clearProjectParam();
  }, [clearProjectParam, quickEdit, router, workspaceId]);

  /**
   * Restore the project named in the URL, and honour Back: when the param goes away, close.
   *
   * An id that no longer resolves clears the param rather than leaving a URL that reopens nothing on
   * every reload.
   */
  useEffect(() => {
    let cancelled = false;

    if (!projectParam) {
      if (selectedProject) setSelectedProject(null);
      setRestoringProject(false);
      return;
    }
    if (selectedProject?.id === projectParam) {
      setRestoringProject(false);
      return;
    }

    setRestoringProject(true);
    (async () => {
      try {
        await vfs.init();
        const project = await vfs.getProject(projectParam);
        if (cancelled) return;
        if (project) setSelectedProject(project);
        else clearProjectParam();
      } catch {
        // An id from another workspace is not in this workspace's store, so the lookup throws
        // rather than returning null.
        if (!cancelled) clearProjectParam();
      } finally {
        if (!cancelled) setRestoringProject(false);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectParam]);

  /**
   * The tour's workspace steps run inside its demo project, and its earlier steps on the projects
   * page: open and close the project as the steps move, as the browser-mode app does.
   */
  const tourLocation = tourState.status === 'running' ? tourState.currentStep?.location : undefined;
  useEffect(() => {
    if (!tourLocation) return;
    if (tourLocation !== 'workspace') {
      if (selectedProject) handleProjectClose();
      return;
    }
    if (selectedProject) return;
    const tourProject = tourState.tourDemoProjectId
      ? tourState.projectList.find(p => p.id === tourState.tourDemoProjectId)
      : tourState.projectList[0];
    if (tourProject) handleProjectOpen(tourProject);
  }, [tourLocation, selectedProject, tourState.projectList, tourState.tourDemoProjectId, handleProjectOpen, handleProjectClose]);

  /**
   * First visit on hosted and desktop: with no project on the server or in this browser, open a new
   * starter project. A self-hosted server shows the projects page instead (`opensFirstProject`).
   */
  const tp = useTranslations('projects');
  useEffect(() => {
    if (firstRunCheckDone || quickEdit || !workspaceId || !opensFirstProject(detectDeploymentType())) return;
    if (!shouldAutoCreateFirstProject({ search: window.location.search, projectCount: 0 })) return;
    firstRunCheckDone = true;
    (async () => {
      try {
        const status = await fetchSyncStatus();
        if (!status || (status.projects?.length ?? 0) > 0) return;
        await vfs.init();
        if ((await vfs.listProjects()).length > 0) return;
        const project = await createFirstProject(tp('firstSiteName'));
        vfs.scheduleAutoSync(project.id);
        track('project_create', { method: 'first_run_auto', runtime: 'static', template: 'blank' });
        handleProjectOpen(project);
      } catch (err) {
        logger.warn('[FirstRun] auto-create failed:', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  // "Create a project" on the first-visit offer: a new starter project, opened at once.
  const handleCreateFromOffer = useCallback(async () => {
    try {
      const project = await createFirstProject(tp('firstSiteName'));
      vfs.scheduleAutoSync(project.id);
      track('project_create', { method: 'tour_offer', runtime: 'static', template: 'blank' });
      handleProjectOpen(project);
    } catch (err) {
      logger.warn('[TourOffer] create failed:', err);
      toast.error(tp('createFailed'));
    }
  }, [tp, handleProjectOpen]);
  useTourOffer(handleStartTour, studioView && !quickEdit, selectedProject ? undefined : handleCreateFromOffer);

  // The tour sends this after removing its demo project, which may be the one open here.
  useEffect(() => {
    const onTourHome = () => handleProjectClose();
    window.addEventListener('tour-navigate-home', onTourHome);
    return () => window.removeEventListener('tour-navigate-home', onTourHome);
  }, [handleProjectClose]);

  const handleShelfNavigate = useCallback(async (info: { id: string; name: string }) => {
    try {
      const project = await vfs.getProject(info.id);
      if (project) handleProjectOpen(project);
    } catch {
      toast.error(twx('openProjectFailed'));
    }
  }, [handleProjectOpen, twx]);

  const content = restoringProject && !selectedProject ? (
    <div className="h-full flex items-center justify-center">
      <Spinner size={48} color="#f97316" className="mx-auto" />
    </div>
  ) : selectedProject ? (
    // Back names the page the workspace returns to: `?project=` works on any of these routes, so
    // from Deployments, Back lands on Deployments (`workspace.backToView` selects by view).
    <Workspace
      project={selectedProject}
      onBack={handleProjectClose}
      backLabel={quickEdit ? twx('backToProjects') : twx('backToView', { view })}
      workspaceId={workspaceId}
      initialPreviewPath={initialPreviewPath}
    />
  ) : (
    <ContentArea
      view={view}
      workspaceId={workspaceId}
      onProjectSelect={handleProjectOpen}
      settingsTab={settingsTab}
      onNavigate={handleNavigate}
      onStartTour={handleStartTour}
      autoCreateProject={autoCreateProject}
    />
  );

  return (
    <>
      <PageLayout
        currentView={view}
        workspaceId={workspaceId}
        onNavigate={handleNavigate}
        onProjectSelect={handleProjectOpen}
        onStartTour={handleStartTour}
        onOpenAbout={() => setShowAboutModal(true)}
        showSidebar={!selectedProject && !restoringProject}
      >
        {content}
      </PageLayout>
      <GuidedTourOverlay location="global" />
      <AboutModal
        open={showAboutModal}
        onOpenChange={setShowAboutModal}
      />
      <TelemetryBootstrap />
      <GenerationShelf
        selectedProject={selectedProject}
        onNavigateToProject={handleShelfNavigate}
      />
    </>
  );
}

export function PageWrapper({ view, workspaceId, settingsTab, autoCreateProject, quickEditProjectId }: PageWrapperProps) {
  return (
    <GuidedTourProvider>
      {/* useSearchParams needs a boundary, and only the projects route provided one. */}
      <Suspense>
        <PageWrapperInner view={view} workspaceId={workspaceId} settingsTab={settingsTab} autoCreateProject={autoCreateProject} quickEditProjectId={quickEditProjectId} />
      </Suspense>
    </GuidedTourProvider>
  );
}
