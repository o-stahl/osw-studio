// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * Saving a published deployment onto another project waits on the swap dialog. Cancelled, nothing
 * is written (neither the project change nor the other settings in the same save) and the save
 * reports false, which is what keeps the detail view's edits marked unsaved. Confirmed, it goes on.
 *
 * The children are stubs: what is under test is the view's save, between the dialog and the API.
 */

const calls = vi.hoisted(() => ({
  fetches: [] as Array<{ url: string; method: string }>,
  onSave: null as null | ((settings: Record<string, unknown>) => Promise<boolean | void>),
}));

vi.mock('@/lib/vfs', () => ({ vfs: {} }));
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
  DeploymentDetail: ({ onSave }: { onSave: typeof calls.onSave }) => {
    calls.onSave = onSave;
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

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  calls.fetches = [];
  calls.onSave = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(withMessages(<DeploymentsView onProjectSelect={() => {}} workspaceId="ws" />));
  });
  await act(async () => { byTestId('open-d1')!.click(); });
  expect(byTestId('detail')).not.toBeNull();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

async function saveOntoOtherProject(answer: 'swap-cancel' | 'swap-confirm') {
  let saved!: Promise<boolean | void>;
  await act(async () => { saved = calls.onSave!({ projectId: 'p2', underConstruction: true }); });
  // The dialog is up and nothing has been written while it asks.
  expect(byTestId(answer)).not.toBeNull();
  expect(writes()).toEqual([]);
  await act(async () => { byTestId(answer)!.click(); });
  return saved;
}

describe('DeploymentsView saving a published deployment onto another project', () => {
  it('writes nothing and reports false when the swap is cancelled', async () => {
    expect(await saveOntoOtherProject('swap-cancel')).toBe(false);
    expect(writes()).toEqual([]);
    expect(byTestId('swap-cancel')).toBeNull();
  });

  it('writes the project and the settings when the swap is confirmed', async () => {
    expect(await saveOntoOtherProject('swap-confirm')).not.toBe(false);
    expect(writes()).toEqual([
      { url: '/api/w/ws/deployments/d1', method: 'PUT' },
      { url: '/api/w/ws/deployments/d1/settings', method: 'PUT' },
    ]);
  });
});
