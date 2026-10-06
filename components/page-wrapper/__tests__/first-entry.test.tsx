// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Server-mode entry: hosted and desktop open a new starter project on a first visit, a self-hosted
 * server shows the projects page; and the guided tour moves in and out of its demo project.
 */
let surface = 'desktop';
let serverProjects: unknown[] = [];
let localProjects: unknown[] = [];
let tourState: Record<string, unknown> = { status: 'idle', projectList: [], tourDemoProjectId: null };
const createFirstProject = vi.fn(async (name: string) => ({ id: 'first', name }));
const scheduleAutoSync = vi.fn();
const tourOffer = vi.fn();
let studio = true;
let workspaceProps: { onBack?: () => void } = {};
let contentProps: { onProjectSelect?: (p: { id: string; name: string }) => void } = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/lib/telemetry/config', () => ({ detectDeploymentType: () => surface }));
vi.mock('@/lib/first-run', async (orig) => ({ ...(await orig<object>()), createFirstProject: (n: string) => createFirstProject(n) }));
vi.mock('@/lib/vfs/auto-sync', () => ({ fetchSyncStatus: async () => ({ projects: serverProjects }) }));
vi.mock('@/lib/vfs', () => ({
  vfs: { init: async () => {}, listProjects: async () => localProjects, scheduleAutoSync: (id: string) => scheduleAutoSync(id), getProject: async (id: string) => (['started-here', 'other'].includes(id) ? { id, name: 'Mine' } : null) },
}));
vi.mock('@/components/guided-tour/context', () => ({
  GuidedTourProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useGuidedTour: () => ({ start: vi.fn(), state: tourState }),
}));
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/views/content-area', () => ({
  ContentArea: (props: typeof contentProps) => { contentProps = props; return null; },
}));
vi.mock('@/components/workspace', () => ({
  Workspace: (props: { project: { id: string }; onBack: () => void }) => {
    workspaceProps = props;
    return <div data-open={props.project.id} />;
  },
}));
vi.mock('@/lib/hooks/use-tour-offer', () => ({ useTourOffer: (start: () => void, enabled: boolean) => tourOffer(enabled) }));
vi.mock('@/components/view-mode-provider', () => ({ useStudioView: () => studio }));
vi.mock('@/components/guided-tour/overlay', () => ({ GuidedTourOverlay: () => null }));
vi.mock('@/components/about-modal', () => ({ AboutModal: () => null }));
vi.mock('@/components/generation-shelf', () => ({ GenerationShelf: () => null }));
vi.mock('@/components/telemetry-bootstrap', () => ({ TelemetryBootstrap: () => null }));
vi.mock('@/lib/hooks/use-provider-auto-assign', () => ({ useProviderAutoAssign: () => {} }));
vi.mock('@/lib/hooks/use-provider-sign-in-return', () => ({ useProviderSignInReturn: () => {} }));
vi.mock('@/lib/hooks/use-model-config-signal', () => ({ useModelConfigSignal: () => {} }));
vi.mock('@/lib/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ reattachServerTasks: vi.fn(), setQuickEdit: vi.fn() }) },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetModules();
  window.history.replaceState({}, '', '/w/w1/projects');
  surface = 'desktop';
  serverProjects = [];
  localProjects = [];
  tourState = { status: 'idle', projectList: [], tourDemoProjectId: null };
  createFirstProject.mockClear();
  scheduleAutoSync.mockClear();
  tourOffer.mockClear();
  studio = true;
  workspaceProps = {};
  contentProps = {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('osw_provider_sign_ins');
});

async function render(props: { quickEditProjectId?: string } = {}) {
  const { PageWrapper } = await import('../index');
  await act(async () => {
    root.render(withMessages(<PageWrapper view="projects" workspaceId="w1" {...props} />));
  });
}
const opened = () => container.querySelector('[data-open]')?.getAttribute('data-open') ?? null;

describe('PageWrapper — first visit', () => {
  it.each(['desktop', 'managed'])('opens a new starter project on %s', async (s) => {
    surface = s;
    await render();
    await vi.waitFor(() => expect(opened()).toBe('first'));
    expect(createFirstProject).toHaveBeenCalledWith('My First Site');
  });

  it('shows the projects page on a self-hosted server', async () => {
    surface = 'server';
    await render();
    await new Promise((r) => setTimeout(r, 20));
    expect(createFirstProject).not.toHaveBeenCalled();
    expect(opened()).toBeNull();
  });

  it('syncs the starter project it creates', async () => {
    await render();
    await vi.waitFor(() => expect(opened()).toBe('first'));
    expect(scheduleAutoSync).toHaveBeenCalledWith('first');
  });

  it('leaves a browser that already holds projects alone, even with an empty server', async () => {
    localProjects = [{ id: 'local' }];
    await render();
    await new Promise((r) => setTimeout(r, 20));
    expect(createFirstProject).not.toHaveBeenCalled();
    expect(opened()).toBeNull();
  });

  it('creates nothing from the quick-edit route', async () => {
    await render({ quickEditProjectId: 'q1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(createFirstProject).not.toHaveBeenCalled();
  });

  it('leaves a workspace that already has projects on the server alone', async () => {
    serverProjects = [{ id: 'x' }];
    await render();
    await new Promise((r) => setTimeout(r, 20));
    expect(createFirstProject).not.toHaveBeenCalled();
  });
});

describe('PageWrapper — guided tour steps', () => {
  it('opens the demo project for the workspace steps', async () => {
    surface = 'server';
    tourState = {
      status: 'running', currentStep: { id: 'workspace-focus', location: 'workspace' },
      projectList: [{ id: 'other' }, { id: 'demo' }], tourDemoProjectId: 'demo',
    };
    await render();
    await vi.waitFor(() => expect(opened()).toBe('demo'));
  });

  it('closes the project when the tour moves back to the projects page', async () => {
    surface = 'server';
    tourState = {
      status: 'running', currentStep: { id: 'workspace-focus', location: 'workspace' },
      projectList: [{ id: 'demo' }], tourDemoProjectId: 'demo',
    };
    await render();
    await vi.waitFor(() => expect(opened()).toBe('demo'));

    tourState = { ...tourState, currentStep: { id: 'projects-list', location: 'projects' } };
    await render();
    await vi.waitFor(() => expect(opened()).toBeNull());
  });

  it('closes the open project when the tour sends everyone home', async () => {
    surface = 'server';
    tourState = {
      status: 'running', currentStep: { id: 'workspace-focus', location: 'workspace' },
      projectList: [{ id: 'demo' }], tourDemoProjectId: 'demo',
    };
    await render();
    await vi.waitFor(() => expect(opened()).toBe('demo'));

    // The tour has ended by the time it sends this, so nothing reopens the demo.
    tourState = { status: 'idle', projectList: [], tourDemoProjectId: null };
    await render();
    await act(async () => { window.dispatchEvent(new Event('tour-navigate-home')); });
    expect(opened()).toBeNull();
  });
});

describe('PageWrapper — offering the tour', () => {
  it('offers it in the studio', async () => {
    surface = 'server';
    await render();
    expect(tourOffer).toHaveBeenLastCalledWith(true);
  });

  it('does not offer it in quick edit', async () => {
    surface = 'server';
    await render({ quickEditProjectId: 'q1' });
    expect(tourOffer).toHaveBeenLastCalledWith(false);
  });

  it('does not offer it in the simple view', async () => {
    surface = 'server';
    studio = false;
    await render();
    expect(tourOffer).toHaveBeenLastCalledWith(false);
  });
});

describe('PageWrapper — returning from a provider sign-in', () => {
  it('opens the project the sign-in started from, before the code is exchanged', async () => {
    surface = 'server';
    localStorage.setItem('osw_provider_sign_ins', JSON.stringify({
      n1: { provider: 'openrouter', verifier: 'v'.repeat(43), redirectUri: 'http://localhost/', returnProject: 'started-here', startedAt: Date.now() },
    }));
    window.history.replaceState({}, '', '/w/w1/projects?code=abc');
    await render();
    await vi.waitFor(() => expect(opened()).toBe('started-here'));
  });

  it('lets the sign-in project go once it is closed', async () => {
    surface = 'server';
    localStorage.setItem('osw_provider_sign_ins', JSON.stringify({
      n1: { provider: 'openrouter', verifier: 'v'.repeat(43), redirectUri: 'http://localhost/', returnProject: 'started-here', startedAt: Date.now() },
    }));
    window.history.replaceState({}, '', '/w/w1/projects?code=abc');
    await render();
    await vi.waitFor(() => expect(opened()).toBe('started-here'));

    // Close it, open another project, and close that one: Back must land on the projects page,
    // not reopen the project the sign-in started from.
    await act(async () => workspaceProps.onBack?.());
    expect(opened()).toBeNull();
    await act(async () => contentProps.onProjectSelect?.({ id: 'other', name: 'Other' }));
    expect(opened()).toBe('other');
    await act(async () => workspaceProps.onBack?.());
    await new Promise((r) => setTimeout(r, 20));
    expect(opened()).toBeNull();
  });
});

