import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

let pullDelay = 0;
vi.mock('@/lib/vfs/sync-manager', () => ({
  getSyncManager: () => ({
    pullProjectWithFiles: async () => {
      await new Promise(r => setTimeout(r, pullDelay));
      return { success: true, project: { id: 'p1', name: 'renamed on server', updatedAt: new Date().toISOString() }, files: [] };
    },
    pullBackendFeatures: vi.fn(async () => {}),
  }),
}));
vi.mock('@/lib/vfs/save-manager', () => ({
  saveManager: { runWithSuppressedDirty: (_id: string, fn: () => Promise<void>) => fn() },
}));
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { createCheckpoint: vi.fn(async () => ({ id: 'c', description: '', timestamp: 0 })) },
}));
vi.mock('@/lib/vfs/auto-sync', () => ({ localHasUnackedEdits: () => false, markSyncNeedsRetry: vi.fn() }));
const handleImageRequested = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/server-generate/image-delegation-handler', () => ({ handleImageRequested }));

/**
 * A server run records its spend in the server's copy of the project, so the header, which reads
 * this browser's copy, never moved. The tab now counts each usage report into its own record.
 */
describe('orchestrator slice — cost of a server run', () => {
  let store: ReturnType<typeof createTestStore>;
  let recordServerTaskCost: ReturnType<typeof vi.fn>;

  async function deliver(data: Record<string, unknown>, event = 'usage') {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent(event, { sourceProjectId: 'p1', sourceTaskId: 't1', ...data });
  }

  beforeEach(async () => {
    store = createTestStore();
    store.setState({ projectId: 'p1' });
    const { vfs } = await import('@/lib/vfs');
    recordServerTaskCost = vi.fn().mockResolvedValue(1.25);
    (vfs as unknown as { recordServerTaskCost: typeof recordServerTaskCost }).recordServerTaskCost = recordServerTaskCost;
  });

  it('records the task total and shows the project total', async () => {
    await deliver({ usage: { provider: 'openrouter', promptTokens: 100, completionTokens: 10 }, totalCost: 0.25, taskCost: 0.25 });
    await vi.waitFor(() => expect(store.getState().projectCost).toBe(1.25));
    expect(recordServerTaskCost).toHaveBeenCalledWith('p1', {
      taskId: 't1', taskCost: 0.25, provider: 'openrouter', tokenUsage: { input: 100, output: 10 },
    });
  });

  it("skips the provider's own per-call report, which would count the call twice", async () => {
    await deliver({ usage: { provider: 'openrouter' }, cost: 0.25 });
    await new Promise(r => setTimeout(r, 0));
    expect(recordServerTaskCost).not.toHaveBeenCalled();
  });

  it('leaves the header alone for a project this tab is not showing', async () => {
    store.setState({ projectId: 'other', projectCost: 3 });
    await deliver({ usage: {}, totalCost: 0.25, taskCost: 0.25 });
    await vi.waitFor(() => expect(recordServerTaskCost).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 0));
    expect(store.getState().projectCost).toBe(3);
  });

  // A run started after a Stop takes the project's slot while the stopped run's last reports are
  // still arriving; those belong to the task that sent them, not to whichever task holds the slot.
  it('counts a report against the task that sent it, not the one now running', async () => {
    store.setState({
      generationTasks: new Map([['p1', {
        projectId: 'p1', projectName: 'P', prompt: 'x', model: 'm', startedAt: 1, result: null,
        paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't-new',
      }]]) as never,
    });
    await deliver({ usage: {}, taskCost: 0.25 });
    await vi.waitFor(() => expect(recordServerTaskCost).toHaveBeenCalled());
    expect(recordServerTaskCost.mock.calls[0][1]).toMatchObject({ taskId: 't1' });
  });

  it('hands an image request to the browser-side handler', async () => {
    const request = { taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' };
    await deliver(request, 'image_requested');
    expect(handleImageRequested).toHaveBeenCalledWith(expect.objectContaining(request));
  });

  it('keeps both a cost written during a pull and the pull itself', async () => {
    type Rec = { id: string; name: string; costTracking: { totalCost: number }; syncStatus?: string };
    let stored: Rec = { id: 'p1', name: 'old name', costTracking: { totalCost: 1 } };
    const { vfs } = await import('@/lib/vfs');
    Object.assign(vfs, {
      getProject: async () => structuredClone(stored),
      updateProject: async (rec: Rec) => { stored = structuredClone(rec); },
      getAllFilesAndDirectories: async () => [],
      // A read-modify-write that is still in flight when the pull writes back.
      recordServerTaskCost: async (_id: string, u: { taskCost: number }) => {
        const rec = structuredClone(stored);
        await new Promise(r => setTimeout(r, 30));
        rec.costTracking.totalCost += u.taskCost;
        stored = rec;
        return rec.costTracking.totalCost;
      },
    });
    pullDelay = 10;
    store.setState({ projectId: 'other' });
    const { pullAndCheckpointServerFiles } = await import('@/lib/stores/slices/orchestrator');

    const pull = pullAndCheckpointServerFiles('p1', store.getState as never);
    await deliver({ usage: {}, totalCost: 0.5, taskCost: 0.5 });
    await pull;
    await vi.waitFor(() => expect(stored.costTracking.totalCost).toBe(1.5));
    expect(stored.name).toBe('renamed on server');
    expect(stored.syncStatus).toBe('synced');
    const { checkpointManager } = await import('@/lib/vfs/checkpoint');
    expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
      'p1', 'After server generation', { kind: 'auto', label: { key: 'afterServerGeneration' } },
    );
  });
});
