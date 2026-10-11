// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Dialogs leave for another view by dispatching `nav-to-view` (Deploy to Deployments or Settings,
 * the template browser to Templates). StudioApp hears it in Browser Mode; in Server Mode each view
 * is its own route, so PageWrapper turns the event into that route or the button does nothing.
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

describe('PageWrapper — nav-to-view', () => {
  const navTo = (detail: unknown) =>
    act(() => { window.dispatchEvent(new CustomEvent('nav-to-view', { detail })); });

  it.each([
    ['deployments', '/w/w1/deployments'],
    ['settings', '/w/w1/settings'],
    ['templates', '/w/w1/templates'],
  ])('routes %s to its page in the workspace', (view, route) => {
    render('projects');
    navTo({ view });
    expect(push).toHaveBeenCalledWith(route);
  });

  it('ignores an event without a view', () => {
    render('projects');
    navTo({});
    navTo(null);
    expect(push).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    render('projects');
    act(() => root.unmount());
    navTo({ view: 'deployments' });
    expect(push).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
