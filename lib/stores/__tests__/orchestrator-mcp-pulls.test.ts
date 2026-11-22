// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

const pullProjectWithFiles = vi.hoisted(() => vi.fn());
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: () => ({ pullProjectWithFiles, pullBackendFeatures: vi.fn() }) }));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { runWithSuppressedDirty: (_id: string, fn: () => Promise<void>) => fn() } }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: { createCheckpoint: vi.fn(async () => ({ id: 'cp', description: '', timestamp: 0 })) } }));
vi.mock('@/lib/vfs/auto-sync', () => ({ localHasUnackedEdits: () => false, markSyncNeedsRetry: vi.fn() }));

/**
 * An MCP client writing many files sends one `mcp_project_changed` per write. Each pulls the whole
 * project and ends on a checkpoint, so the tab runs one pull at a time per project and folds the
 * notices that arrive meanwhile into a single pull after it.
 */
describe('orchestrator slice — pulls for MCP changes', () => {
  let store: ReturnType<typeof createTestStore>;
  const now = new Date();
  let active = 0;
  let peak = 0;
  let release: Array<() => void> = [];

  async function deliver(count: number) {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    const onEvent = ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent;
    for (let i = 0; i < count; i++) {
      onEvent('mcp_project_changed', { projectId: 'p1', projectName: 'Site', created: false });
      // Apart, as separate uploads arrive. Fired in one tick, vitest resolves only the first
      // handler's dynamic import of the mocked sync manager, which hides the others.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  beforeEach(async () => {
    active = 0;
    peak = 0;
    release = [];
    pullProjectWithFiles.mockReset().mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return { success: true, project: { id: 'p1', name: 'Site', updatedAt: now.toISOString(), revision: 1 }, files: [] };
    });
    const { vfs } = await import('@/lib/vfs');
    Object.assign(vfs, {
      getProject: vi.fn(async () => ({ id: 'p1', name: 'Site', createdAt: now, updatedAt: now, lastSyncedAt: now })),
      getAllFilesAndDirectories: vi.fn(async () => []),
      updateProject: vi.fn(async () => {}),
    });
    store = createTestStore();
    store.setState({ projectId: null } as never);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('runs one pull at a time and folds a burst of notices into one more pull', async () => {
    await deliver(5);
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalledTimes(1));
    await settle();
    expect(pullProjectWithFiles).toHaveBeenCalledTimes(1);

    release.shift()!();
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalledTimes(2));
    release.shift()!();
    await settle();

    expect(pullProjectWithFiles).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it('pulls again for a notice that arrives after the last pull started', async () => {
    await deliver(1);
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalledTimes(1));
    await deliver(1);
    release.shift()!();
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalledTimes(2));
    release.shift()!();
    await settle();
    expect(pullProjectWithFiles).toHaveBeenCalledTimes(2);
  });
});
