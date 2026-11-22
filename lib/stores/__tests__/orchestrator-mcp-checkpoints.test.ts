// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

const sync = vi.hoisted(() => ({
  pullProjectWithFiles: vi.fn(),
  pullBackendFeatures: vi.fn(),
}));
const checkpoints = vi.hoisted(() => ({
  createCheckpoint: vi.fn(),
  getCheckpoints: vi.fn(),
}));
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: () => sync }));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { runWithSuppressedDirty: (_id: string, fn: () => Promise<void>) => fn() } }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: checkpoints }));
vi.mock('@/lib/vfs/auto-sync', () => ({ localHasUnackedEdits: () => false, markSyncNeedsRetry: vi.fn() }));

/**
 * A connector's change reaches the tab as a pull, one per file it writes. Each pull that brings
 * something is recorded at once, so nothing is lost if a later one fails, but a burst of them is one
 * checkpoint: a pull within a minute of the connector's last checkpoint, with nothing in between,
 * replaces it.
 */
describe('orchestrator slice: checkpoints for MCP changes', () => {
  let store: ReturnType<typeof createTestStore>;
  const now = new Date();
  let localFiles: { path: string; content: string }[];
  let serverFiles: { path: string; content: string }[];

  async function change(clientLabel = 'Claude Code') {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    const onEvent = ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent;
    onEvent('mcp_project_changed', { projectId: 'p1', projectName: 'Site', created: false, clientLabel });
    await vi.waitFor(() => expect(sync.pullProjectWithFiles).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const connectorCheckpoint = (over: Record<string, unknown> = {}) => ({
    id: 'cp_mcp', projectId: 'p1', kind: 'auto', description: 'After changes from Claude Code',
    label: { key: 'afterConnector', values: { client: 'Claude Code' } },
    timestamp: new Date(Date.now() - 10_000).toISOString(), pinned: false, ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    localFiles = [{ path: '/index.html', content: 'one' }];
    serverFiles = [{ path: '/index.html', content: 'one' }];
    sync.pullProjectWithFiles.mockImplementation(async () => ({
      success: true, project: { id: 'p1', name: 'Site', updatedAt: now.toISOString(), revision: 1 }, files: serverFiles,
    }));
    sync.pullBackendFeatures.mockResolvedValue({ success: true, changed: false });
    checkpoints.createCheckpoint.mockImplementation(async (_p: string, description: string, opts: { replaces?: string }) => ({
      id: opts?.replaces ?? 'cp_new', description, timestamp: new Date().toISOString(),
    }));
    checkpoints.getCheckpoints.mockResolvedValue([]);
    const { vfs } = await import('@/lib/vfs');
    Object.assign(vfs, {
      getProject: vi.fn(async () => ({ id: 'p1', name: 'Site', createdAt: now, updatedAt: now, lastSyncedAt: now, lastSavedAt: now, lastSavedCheckpointId: 'cp_saved' })),
      getAllFilesAndDirectories: vi.fn(async () => localFiles),
      updateFile: vi.fn(async () => {}),
      createFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
      updateProject: vi.fn(async () => {}),
    });
    store = createTestStore();
    store.setState({ projectId: 'p1' } as never);
  });

  it('makes no checkpoint, and leaves the project saved, when the pull brings nothing', async () => {
    const markDirty = vi.spyOn(store.getState(), 'markDirty');
    store.setState({ markDirty } as never);

    await change();

    expect(checkpoints.createCheckpoint).not.toHaveBeenCalled();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('records a file the connector changed, named for the connector', async () => {
    serverFiles = [{ path: '/index.html', content: 'two' }];

    await change();

    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
    const [, , options] = checkpoints.createCheckpoint.mock.calls[0];
    expect(options).toMatchObject({ kind: 'auto', label: { key: 'afterConnector', values: { client: 'Claude Code' } } });
    expect(options.replaces).toBeUndefined();
    expect(store.getState().debugEvents.filter((e) => e.event === 'checkpoint_created')).toHaveLength(1);
  });

  it('records a change to backend features alone', async () => {
    sync.pullBackendFeatures.mockResolvedValue({ success: true, changed: true });

    await change();

    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('replaces the connector\'s own checkpoint from a moment ago', async () => {
    serverFiles = [{ path: '/index.html', content: 'two' }];
    checkpoints.getCheckpoints.mockResolvedValue([connectorCheckpoint()]);

    const refreshBefore = store.getState().checkpointRefreshKey;

    await change();

    expect(checkpoints.createCheckpoint.mock.calls[0][2]).toMatchObject({ replaces: 'cp_mcp' });
    // The chat already marks this checkpoint; the panel and Undo re-read it instead.
    expect(store.getState().debugEvents.filter((e) => e.event === 'checkpoint_created')).toHaveLength(0);
    expect(store.getState().checkpointRefreshKey).toBe(refreshBefore + 1);
  });

  it.each([
    ['another checkpoint came after it', [{ id: 'cp_run', projectId: 'p1', kind: 'auto', description: 'After: x', timestamp: new Date().toISOString() }, connectorCheckpoint()]],
    ['it is more than a minute old', [connectorCheckpoint({ timestamp: new Date(Date.now() - 61_000).toISOString() })]],
    ['another connector made it', [connectorCheckpoint({ label: { key: 'afterConnector', values: { client: 'Cursor' } } })]],
    ['it is pinned', [connectorCheckpoint({ pinned: true, pinnedBy: 'user' })]],
    ['it is the last save', [connectorCheckpoint({ id: 'cp_saved' })]],
  ])('makes a new checkpoint when %s', async (_why, list) => {
    serverFiles = [{ path: '/index.html', content: 'two' }];
    checkpoints.getCheckpoints.mockResolvedValue(list);

    await change();

    expect(checkpoints.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(checkpoints.createCheckpoint.mock.calls[0][2].replaces).toBeUndefined();
  });
});
