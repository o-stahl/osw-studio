// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Browser-mode entry (`StudioApp`): the HF Space opens a new starter project on a first visit and a
 * plain browser install shows the projects page; a provider sign-in returns to the project it started
 * from, and its `?code=` is not mistaken for HuggingFace's; the guided tour moves in and out of its
 * demo project; and the tour is offered only in the studio view.
 */
let surface = 'hf_space';
let localProjects: unknown[] = [];
let tourState: Record<string, unknown> = { status: 'idle', projectList: [], tourDemoProjectId: null };
let studio = true;
const createFirstProject = vi.fn(async (name: string) => ({ id: 'first', name }));
const hfRedirect = vi.fn(async () => null);
const tourOffer = vi.fn();
let workspaceProps: { onBack?: () => void } = {};
let contentProps: { view?: string; onProjectSelect?: (p: { id: string; name: string }) => void } = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/lib/telemetry/config', () => ({ detectDeploymentType: () => surface }));
vi.mock('@/lib/first-run', async (orig) => ({ ...(await orig<object>()), createFirstProject: (n: string) => createFirstProject(n) }));
vi.mock('@/lib/auth/hf-auth', () => ({ oauthHandleRedirectIfPresent: () => hfRedirect() }));
vi.mock('@/lib/vfs', () => ({
  vfs: {
    init: async () => {},
    listProjects: async () => localProjects,
    getProject: async (id: string) => (['started-here', 'other', 'demo'].includes(id) ? { id, name: 'Mine' } : null),
    flushAllSyncTimeouts: vi.fn(),
  },
}));
vi.mock('@/components/view-mode-provider', () => ({
  ViewModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useStudioView: () => studio,
}));
vi.mock('@/components/sidebar', () => ({ STUDIO_ONLY_VIEWS: ['templates', 'skills', 'interviews'] }));
vi.mock('@/components/guided-tour/context', () => ({
  GuidedTourProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useGuidedTour: () => ({ start: vi.fn(), state: tourState, setActiveProjectId: vi.fn() }),
}));
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/views/content-area', () => ({
  ContentArea: (props: typeof contentProps) => { contentProps = props; return <div data-view={props.view} />; },
}));
vi.mock('@/components/workspace', () => ({
  Workspace: (props: { project: { id: string }; onBack: () => void }) => {
    workspaceProps = props;
    return <div data-open={props.project.id} />;
  },
}));
vi.mock('@/lib/hooks/use-tour-offer', () => ({ useTourOffer: (_start: () => void, enabled: boolean) => tourOffer(enabled) }));
vi.mock('@/components/guided-tour/overlay', () => ({ GuidedTourOverlay: () => null }));
vi.mock('@/components/about-modal', () => ({ AboutModal: () => null }));
vi.mock('@/components/generation-shelf', () => ({ GenerationShelf: () => null }));
vi.mock('@/components/telemetry-bootstrap', () => ({ TelemetryBootstrap: () => null }));
vi.mock('@/lib/hooks/use-provider-auto-assign', () => ({ useProviderAutoAssign: () => {} }));
vi.mock('@/lib/hooks/use-provider-sign-in-return', () => ({ useProviderSignInReturn: () => {} }));
vi.mock('@/lib/hooks/use-model-config-signal', () => ({ useModelConfigSignal: () => {} }));
vi.mock('@/lib/stores/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ setQuickEdit: vi.fn() }) },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

const SIGN_INS = 'osw_provider_sign_ins';
const signInPending = () => localStorage.setItem(SIGN_INS, JSON.stringify({
  n1: { provider: 'openrouter', verifier: 'v'.repeat(43), redirectUri: 'http://localhost/', returnProject: 'started-here', startedAt: Date.now() },
}));

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The first-run and OAuth guards are module-level, once per page load.
  vi.resetModules();
  window.history.replaceState({}, '', '/');
  surface = 'hf_space';
  localProjects = [{ id: 'existing' }];
  tourState = { status: 'idle', projectList: [], tourDemoProjectId: null };
  studio = true;
  createFirstProject.mockClear();
  hfRedirect.mockClear();
  tourOffer.mockClear();
  workspaceProps = {};
  contentProps = {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(SIGN_INS);
});

async function render() {
  const { StudioApp } = await import('../index');
  await act(async () => {
    root.render(withMessages(<StudioApp />));
  });
}
const opened = () => container.querySelector('[data-open]')?.getAttribute('data-open') ?? null;
const view = () => container.querySelector('[data-view]')?.getAttribute('data-view') ?? null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe('StudioApp — first visit', () => {
  it('opens a new starter project on the HF Space, named in the interface language', async () => {
    localProjects = [];
    await render();
    await vi.waitFor(() => expect(opened()).toBe('first'));
    expect(createFirstProject).toHaveBeenCalledWith('My First Site');
    expect(new URLSearchParams(window.location.search).get('project')).toBe('first');
  });

  it('shows the projects page in a plain browser install, and creates nothing', async () => {
    surface = 'browser';
    localProjects = [];
    await render();
    await settle();
    expect(createFirstProject).not.toHaveBeenCalled();
    expect(opened()).toBeNull();
    expect(view()).toBe('projects');
  });
});

describe('StudioApp — returning from a provider sign-in', () => {
  it('opens the project the sign-in started from, before the code is exchanged', async () => {
    signInPending();
    window.history.replaceState({}, '', '/?code=abc');
    await render();
    await vi.waitFor(() => expect(opened()).toBe('started-here'));
  });

  it('leaves the ?code= to the provider sign-in rather than handing it to HuggingFace', async () => {
    signInPending();
    window.history.replaceState({}, '', '/?code=abc');
    await render();
    await settle();
    expect(hfRedirect).not.toHaveBeenCalled();
    // The provider's own hook strips it; this one must not.
    expect(new URLSearchParams(window.location.search).get('code')).toBe('abc');
  });

  it('still handles a HuggingFace return when no provider sign-in is pending', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=hf');
    await render();
    await settle();
    expect(hfRedirect).toHaveBeenCalledTimes(1);
  });

  it('lets the sign-in project go once it is closed', async () => {
    signInPending();
    window.history.replaceState({}, '', '/?code=abc');
    await render();
    await vi.waitFor(() => expect(opened()).toBe('started-here'));

    await act(async () => workspaceProps.onBack?.());
    expect(opened()).toBeNull();
    await act(async () => contentProps.onProjectSelect?.({ id: 'other', name: 'Other' }));
    expect(opened()).toBe('other');
    await act(async () => workspaceProps.onBack?.());
    await settle();
    expect(opened()).toBeNull();
  });
});

describe('StudioApp — guided tour steps', () => {
  it('opens the demo project for a workspace step and closes it for a project-manager step', async () => {
    tourState = {
      status: 'running', currentStep: { id: 'workspace-focus', location: 'workspace' },
      projectList: [{ id: 'other' }, { id: 'demo' }], tourDemoProjectId: 'demo',
    };
    await render();
    await vi.waitFor(() => expect(opened()).toBe('demo'));

    tourState = { ...tourState, currentStep: { id: 'projects-list', location: 'project-manager' } };
    const { StudioApp } = await import('../index');
    await act(async () => { root.render(withMessages(<StudioApp />)); });
    await vi.waitFor(() => expect(opened()).toBeNull());
  });
});

describe('StudioApp — offering the tour', () => {
  it('offers it in the studio', async () => {
    await render();
    expect(tourOffer).toHaveBeenLastCalledWith(true);
  });

  it('does not offer it in the simple view', async () => {
    studio = false;
    await render();
    expect(tourOffer).toHaveBeenLastCalledWith(false);
  });
});
