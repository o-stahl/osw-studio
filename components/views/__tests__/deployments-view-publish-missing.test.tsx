// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import en from '@/messages/en.json';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Publishing a deployment whose project was deleted on the server. This browser may still hold a
 * copy, and the server refuses to bring a deleted project back, so the push would fail with a bare
 * "conflict". The view stops before syncing and says what to do instead.
 *
 * The children are stubs, as in deployments-view-swap-cancel.test.tsx.
 */

const calls = vi.hoisted(() => ({
  fetches: [] as Array<{ url: string; method: string }>,
  onPublish: null as null | ((deploymentId: string) => Promise<void>),
  projectMissing: true,
}));

const vfsMock = vi.hoisted(() => ({ init: vi.fn(async () => {}), getProject: vi.fn(async () => null) }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: vi.fn() }));
vi.mock('@/lib/vfs/sync-progress-toast', () => ({ createSyncProgressToast: vi.fn() }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/utils/deployment-thumbnail', () => ({ captureDeploymentPage: vi.fn() }));
vi.mock('@/lib/deployments/pending-create', () => ({ takePendingDeploymentRequest: () => null }));
vi.mock('@/components/ui/view-mode-toggle', () => ({ ViewModeToggle: () => null, useViewMode: () => ['grid', () => {}] }));
vi.mock('@/lib/api/backend-status', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.fetches.push({ url, method });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (method === 'GET' && url.endsWith('/deployments')) {
      return json([{
        id: 'd1', projectId: 'p1', name: 'Site', settingsVersion: 1, lastPublishedVersion: 1,
        publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01', updatedAt: '2026-01-01',
        ...(calls.projectMissing ? { projectMissing: true } : {}),
      }]);
    }
    if (method === 'GET' && url.includes('/projects')) return json([{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }]);
    if (method === 'GET' && url.endsWith('/hosting')) return json({ sitesMode: 'proxy' });
    return json({ settingsVersion: 2, lastPublishedVersion: 1 });
  }),
}));
vi.mock('../../deployment-card', () => ({
  DeploymentCard: ({ deployment, onClick }: { deployment: { id: string }; onClick: (d: unknown) => void }) => (
    <button data-testid={`open-${deployment.id}`} onClick={() => onClick(deployment)} />
  ),
}));
vi.mock('../../deployment-detail', () => ({
  DeploymentDetail: ({ onPublish }: { onPublish: typeof calls.onPublish }) => {
    calls.onPublish = onPublish;
    return <div data-testid="detail" />;
  },
}));
vi.mock('../../project-swap-dialog', () => ({
  ProjectSwapDialog: ({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) => (
    <div>
      <button data-testid="swap-cancel" onClick={onClose} />
      <button data-testid="swap-confirm" onClick={onConfirm} />
    </div>
  ),
}));
vi.mock('../../analytics-dashboard', () => ({ AnalyticsDashboard: () => null }));
vi.mock('../../templates/template-export-dialog', () => ({ TemplateExportDialog: () => null }));
vi.mock('../../create-deployment-modal', () => ({ CreateDeploymentModal: () => null }));

import { DeploymentsView } from '../deployments-view';

let container: HTMLElement;
let root: Root;

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const writes = () => calls.fetches.filter((f) => f.method !== 'GET');

async function openDetail(projectMissing: boolean) {
  calls.projectMissing = projectMissing;
  await act(async () => {
    root.render(withMessages(<DeploymentsView onProjectSelect={() => {}} workspaceId="ws" />));
  });
  await act(async () => { byTestId('open-d1')!.click(); });
  expect(byTestId('detail')).not.toBeNull();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  calls.fetches = [];
  calls.onPublish = null;
  vfsMock.init.mockClear();
  vfsMock.getProject.mockClear();
  toastMock.error.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

describe('DeploymentsView publishing a deployment whose project was deleted', () => {
  it('says so and syncs nothing', async () => {
    await openDetail(true);
    await act(async () => { await calls.onPublish!('d1'); });

    expect(toastMock.error).toHaveBeenCalledWith(en.deployments.publishProjectMissing);
    expect(vfsMock.getProject).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('goes on to the local project when the project exists', async () => {
    await openDetail(false);
    await act(async () => { await calls.onPublish!('d1'); });

    expect(vfsMock.getProject).toHaveBeenCalledWith('p1');
    expect(toastMock.error).not.toHaveBeenCalledWith(en.deployments.publishProjectMissing);
  });
});
