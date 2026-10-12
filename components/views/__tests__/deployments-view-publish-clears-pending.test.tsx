// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Publishing from an open deployment's detail view. The view renders its own copy of the
 * deployment, and the publish updated only the list's copy, so the detail stayed on "Pending
 * Changes" (settingsVersion ahead of lastPublishedVersion) until it was closed and reopened.
 *
 * The children are stubs, as in deployments-view-swap-cancel.test.tsx; the publish runs for real.
 */

type Seen = { settingsVersion?: number; lastPublishedVersion?: number };

const calls = vi.hoisted(() => ({
  onPublish: null as null | ((deploymentId: string) => Promise<void>),
  detail: null as null | Seen,
}));

const vfsMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getProject: vi.fn(async () => ({ id: 'p1', name: 'One', settings: { runtime: 'static' } })),
  flushSyncTimeout: vi.fn(async () => {}),
  listFiles: vi.fn(async () => [{ path: '/index.html', content: '<h1>hi</h1>' }]),
  getStorageAdapter: vi.fn(async () => ({})),
}));

vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/flush-editor', () => ({ flushEditorToVfs: vi.fn(async () => {}) }));
vi.mock('@/lib/vfs/sync-manager', () => ({
  getSyncManager: () => ({ pushProjectWithFiles: vi.fn(async () => ({ success: true })) }),
}));
vi.mock('@/lib/vfs/sync-progress-toast', () => ({ createSyncProgressToast: () => ({ update: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/utils/deployment-thumbnail', () => ({ captureDeploymentPage: vi.fn() }));
vi.mock('@/lib/deployments/pending-create', () => ({ takePendingDeploymentRequest: () => null }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ ViewModeToggle: () => null, useViewMode: () => ['grid', () => {}] }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/api/backend-status', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (method === 'GET' && url.endsWith('/deployments')) {
      return json([{
        id: 'd1', projectId: 'p1', name: 'Site', settingsVersion: 2, lastPublishedVersion: 1,
        publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01', updatedAt: '2026-01-01',
      }]);
    }
    if (method === 'GET' && url.includes('/projects')) return json([{ id: 'p1', name: 'One' }]);
    if (method === 'GET' && url.endsWith('/hosting')) return json({ sitesMode: 'proxy' });
    if (method === 'POST' && url.endsWith('/publish')) return json({ success: true, filesWritten: 1, lastPublishedVersion: 2 });
    return json({});
  }),
}));
vi.mock('../../deployment-card', () => ({
  DeploymentCard: ({ deployment, onClick }: { deployment: { id: string }; onClick: (d: unknown) => void }) => (
    <button data-testid={`open-${deployment.id}`} onClick={() => onClick(deployment)} />
  ),
}));
vi.mock('../../deployment-detail', () => ({
  DeploymentDetail: ({ deployment, onPublish }: { deployment: Seen; onPublish: typeof calls.onPublish }) => {
    calls.onPublish = onPublish;
    calls.detail = deployment;
    return <div data-testid="detail" />;
  },
}));
vi.mock('../../project-swap-dialog', () => ({ ProjectSwapDialog: () => null }));
vi.mock('../../analytics-dashboard', () => ({ AnalyticsDashboard: () => null }));
vi.mock('../../templates/template-export-dialog', () => ({ TemplateExportDialog: () => null }));
vi.mock('../../create-deployment-modal', () => ({ CreateDeploymentModal: () => null }));

import { DeploymentsView } from '../deployments-view';

let container: HTMLElement;
let root: Root;

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  calls.onPublish = null;
  calls.detail = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(withMessages(<DeploymentsView onProjectSelect={() => {}} workspaceId="ws" />));
  });
  await act(async () => { byTestId('open-d1')!.click(); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

describe('DeploymentsView publishing from the open detail view', () => {
  it('hands the detail view the published version, so it no longer reads as pending', async () => {
    expect(calls.detail).toMatchObject({ settingsVersion: 2, lastPublishedVersion: 1 });

    await act(async () => { await calls.onPublish!('d1'); });

    expect(calls.detail).toMatchObject({ settingsVersion: 2, lastPublishedVersion: 2 });
  });
});
