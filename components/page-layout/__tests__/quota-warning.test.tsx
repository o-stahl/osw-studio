// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The workspace storage warning: from 80% used, worded with the real numbers, dismissable. */
const mocks = vi.hoisted(() => ({
  fetchSyncStatus: vi.fn(),
  setAutoSyncWorkspaceId: vi.fn(),
}));

vi.mock('@/components/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/ui/app-header', () => ({ AppHeader: () => null }));
vi.mock('@/components/project-manager/sync-dialog', () => ({ SyncDialog: () => null }));
vi.mock('@/lib/vfs/auto-sync', () => ({
  setAutoSyncWorkspaceId: mocks.setAutoSyncWorkspaceId,
  fetchSyncStatus: mocks.fetchSyncStatus,
  pullConnectionsIntoCache: vi.fn(async () => {}),
}));
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: vi.fn() }));
vi.mock('@/lib/vfs/project-sync-state', () => ({ refreshProjectSyncState: vi.fn(async () => {}) }));

import { PageLayout } from '..';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

const usage = (usedMb: number, maxMb: number) => ({ quota: { storage: { usedMb, maxMb } } });

async function mount(showSidebar = true) {
  await act(async () => {
    root.render(withMessages(
      <PageLayout currentView="projects" workspaceId="w1" onNavigate={() => {}} onProjectSelect={() => {}} showSidebar={showSidebar}>
        <div>page</div>
      </PageLayout>,
    ));
  });
}

describe('the storage warning', () => {
  it('names the share and the sizes once storage is mostly used', async () => {
    mocks.fetchSyncStatus.mockResolvedValue(usage(850, 1000));
    await mount();
    expect(container.textContent).toContain('You have used 85% of your workspace storage (850 MB / 1,000 MB)');
  });

  it('starts at 80%', async () => {
    mocks.fetchSyncStatus.mockResolvedValue(usage(80, 100));
    await mount();
    expect(container.textContent).toContain('You have used 80%');
  });

  it('says nothing below 80%', async () => {
    mocks.fetchSyncStatus.mockResolvedValue(usage(79, 100));
    await mount();
    expect(container.textContent).not.toContain('workspace storage');
  });

  it('goes away when dismissed', async () => {
    mocks.fetchSyncStatus.mockResolvedValue(usage(90, 100));
    await mount();
    const dismiss = container.querySelector('button[aria-label="Dismiss"]');
    await act(async () => { dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).not.toContain('workspace storage');
  });

  it('does not ask from inside a project, or in browser mode', async () => {
    await mount(false);
    expect(mocks.fetchSyncStatus).not.toHaveBeenCalled();

    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');
    await mount(true);
    expect(mocks.fetchSyncStatus).not.toHaveBeenCalled();
    // The workspace still scopes auto-sync in either mode.
    expect(mocks.setAutoSyncWorkspaceId).toHaveBeenCalledWith('w1');
  });
});
