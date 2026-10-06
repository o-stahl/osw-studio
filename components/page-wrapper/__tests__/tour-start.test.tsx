// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * In server mode every route mounts its own tour provider, so the tour can only start on the
 * projects page. The sidebar's Guided Tour did nothing there, and the dashboard's sent the person to
 * a route nothing read.
 */
const push = vi.fn();
let search = new URLSearchParams();
const start = vi.fn();
let layoutProps: { onStartTour?: () => void } = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => search,
}));
vi.mock('@/components/guided-tour/context', () => ({
  GuidedTourProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useGuidedTour: () => ({ start, state: { status: 'idle', projectList: [], tourDemoProjectId: null } }),
}));
vi.mock('@/components/page-layout', () => ({
  PageLayout: (props: { onStartTour?: () => void; children: React.ReactNode }) => {
    layoutProps = props;
    return <>{props.children}</>;
  },
}));
vi.mock('@/components/views/content-area', () => ({ ContentArea: () => null }));
vi.mock('@/components/workspace', () => ({ Workspace: () => null }));
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
vi.mock('@/lib/vfs', () => ({ vfs: {} }));

import { PageWrapper } from '../index';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  push.mockClear();
  start.mockClear();
  search = new URLSearchParams();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(view: 'dashboard' | 'projects') {
  act(() => {
    root.render(withMessages(<PageWrapper view={view} workspaceId="w1" />));
  });
}

describe('PageWrapper — starting the guided tour', () => {
  it('starts the tour in place on the projects page', () => {
    render('projects');
    act(() => layoutProps.onStartTour?.());
    expect(start).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('sends any other page to the projects page with the tour requested', () => {
    render('dashboard');
    act(() => layoutProps.onStartTour?.());
    expect(start).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/w/w1/projects?tour=start');
  });

  it('starts the requested tour on arrival and drops the parameter', () => {
    window.history.replaceState({}, '', '/w/w1/projects?tour=start');
    search = new URLSearchParams('tour=start');
    render('projects');
    expect(start).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
  });
});
