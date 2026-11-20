// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

const pullProjectWithFiles = vi.hoisted(() => vi.fn(async () => ({ success: false })));
vi.mock('@/lib/vfs/sync-manager', () => ({ getSyncManager: () => ({ pullProjectWithFiles, pullBackendFeatures: vi.fn() }) }));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { runWithSuppressedDirty: (_id: string, fn: () => Promise<void>) => fn() } }));
vi.mock('@/lib/vfs/checkpoint', () => ({ checkpointManager: { createCheckpoint: vi.fn() } }));
vi.mock('@/lib/vfs/auto-sync', () => ({ localHasUnackedEdits: () => false, markSyncNeedsRetry: vi.fn() }));

/**
 * Every server run ends with the tab pulling the server's copy. The run's files reach the tab as
 * they are written, but the project record, with the revision the next push is checked against,
 * comes only with this pull: a tab that skips it pushes a stale revision and is refused (409).
 */
describe('orchestrator slice — the pull at the end of a server run', () => {
  let store: ReturnType<typeof createTestStore>;

  async function end(data: Record<string, unknown>) {
    store.setState({
      generationTasks: new Map([['p1', {
        projectId: 'p1', projectName: '', prompt: 'q', model: 'm', startedAt: 0, result: null, paused: false,
        orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
      }]]),
    });
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent('task_complete', { sourceProjectId: 'p1', sourceTaskId: 't1', ...data });
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalled());
  }

  beforeEach(() => {
    pullProjectWithFiles.mockClear();
    store = createTestStore();
    store.setState({ projectId: 'p1' });
  });

  it.each([
    ['finished', { result: 'success', exitReason: 'status_complete' }],
    ['stopped', { result: 'stopped', exitReason: 'stopped' }],
    ['failed', { result: 'failed', exitReason: 'nudge_exhaustion', error: 'Exited after 3 nudge attempts without status' }],
  ])('pulls the project when the run %s', async (_label, data) => {
    await end(data);
    expect(pullProjectWithFiles).toHaveBeenCalledWith('p1');
  });

  it('pulls the project of a run that failed while the tab was away', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tasks: [{ taskId: 't9', projectId: 'p9', status: 'failed', startedAt: 1, failureReason: 'Exited after 3 nudge attempts without status' }] }),
    }));
    try {
      store.setState({ connectSSE: vi.fn(), disconnectSSE: vi.fn() });
      await store.getState().reattachServerTasks();
      expect(store.getState().generationTasks.get('p9')?.result).toBe('failed');
      expect(pullProjectWithFiles).toHaveBeenCalledWith('p9');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

/**
 * Every pull ends the run on a checkpoint, which Retry and Undo count back from, and refreshes the
 * open project. It marks the project dirty for Save only when the run changed files: ones the pull
 * brought, or ones that reached the tab during the run (`files_changed`).
 */
describe('orchestrator slice — what the end-of-run pull marks', () => {
  let store: ReturnType<typeof createTestStore>;
  let markDirty: ReturnType<typeof vi.fn>;
  let bumpRefreshTrigger: ReturnType<typeof vi.fn>;
  const local = new Map<string, string | ArrayBuffer>();
  const now = new Date();

  async function deliver(event: string, data: Record<string, unknown>) {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent(event, { sourceProjectId: 'p1', sourceTaskId: 't1', ...data });
  }

  async function failedRun(serverFiles: Record<string, string | ArrayBuffer>) {
    pullProjectWithFiles.mockResolvedValueOnce({
      success: true,
      project: { id: 'p1', name: 'Site', updatedAt: now.toISOString(), revision: 5 },
      files: Object.entries(serverFiles).map(([path, content]) => ({ path, content })),
    } as never);
    store.setState({
      generationTasks: new Map([['p1', {
        projectId: 'p1', projectName: '', prompt: 'q', model: 'm', startedAt: 0, result: null, paused: false,
        orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
      }]]),
    });
    await deliver('task_complete', { result: 'failed', exitReason: 'error_stop', error: 'Invalid API key' });
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  beforeEach(async () => {
    pullProjectWithFiles.mockClear();
    local.clear();
    local.set('/index.html', '<h1>hi</h1>');
    const { vfs } = await import('@/lib/vfs');
    Object.assign(vfs, {
      getProject: vi.fn(async () => ({ id: 'p1', name: 'Site', createdAt: now, updatedAt: now, lastSyncedAt: now })),
      getAllFilesAndDirectories: vi.fn(async () => [...local].map(([path, content]) => ({ id: path, path, content }))),
      updateFile: vi.fn(async (_p: string, path: string, content: string | ArrayBuffer) => { local.set(path, content); }),
      createFile: vi.fn(async (_p: string, path: string, content: string | ArrayBuffer) => { local.set(path, content); }),
      deleteFile: vi.fn(async (_p: string, path: string) => { local.delete(path); }),
      updateProject: vi.fn(async () => {}),
    });
    const { checkpointManager } = await import('@/lib/vfs/checkpoint');
    vi.mocked(checkpointManager.createCheckpoint).mockReset().mockResolvedValue({ id: 'cp', description: '', timestamp: 0 } as never);
    store = createTestStore();
    markDirty = vi.fn();
    bumpRefreshTrigger = vi.fn();
    store.setState({ projectId: 'p1', markDirty, bumpRefreshTrigger } as never);
  });

  it('ends a run that wrote nothing on a checkpoint, without marking it dirty', async () => {
    await failedRun({ '/index.html': '<h1>hi</h1>' });
    const { checkpointManager } = await import('@/lib/vfs/checkpoint');
    expect(checkpointManager.createCheckpoint).toHaveBeenCalledTimes(1);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('still refreshes the open project after a pull that changed no file', async () => {
    // The pull also brings the project's settings and backend features, which the open views re-read.
    const heard = vi.fn();
    window.addEventListener('filesChanged', heard);
    try {
      await failedRun({ '/index.html': '<h1>hi</h1>' });
    } finally {
      window.removeEventListener('filesChanged', heard);
    }
    expect(bumpRefreshTrigger).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('refreshes only the project on screen', async () => {
    store.setState({ projectId: 'other' });
    await failedRun({ '/index.html': '<h1>changed</h1>' });
    expect(bumpRefreshTrigger).not.toHaveBeenCalled();
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('marks a run whose files the pull brought', async () => {
    await failedRun({ '/index.html': '<h1>changed</h1>' });
    expect(markDirty).toHaveBeenCalled();
  });

  it('marks a run that only added a file', async () => {
    await failedRun({ '/index.html': '<h1>hi</h1>', '/about.html': '<h1>about</h1>' });
    expect(markDirty).toHaveBeenCalled();
  });

  it('marks a run that only removed a file', async () => {
    local.set('/old.html', '<h1>old</h1>');
    await failedRun({ '/index.html': '<h1>hi</h1>' });
    expect(local.has('/old.html')).toBe(false);
    expect(markDirty).toHaveBeenCalled();
  });

  it('tells a changed image from the same one', async () => {
    const bytes = (...b: number[]) => new Uint8Array(b).buffer;
    local.set('/logo.png', bytes(1, 2, 3));
    await failedRun({ '/index.html': '<h1>hi</h1>', '/logo.png': bytes(1, 2, 3) });
    expect(markDirty).not.toHaveBeenCalled();

    pullProjectWithFiles.mockClear();
    await failedRun({ '/index.html': '<h1>hi</h1>', '/logo.png': bytes(1, 2, 4) });
    expect(markDirty).toHaveBeenCalled();
    expect(new Uint8Array(local.get('/logo.png') as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 4]));
  });

  it('marks a run whose files reached the tab while it ran', async () => {
    await deliver('files_changed', { paths: ['/index.html'], taskId: 't1' });
    markDirty.mockClear();
    await failedRun({ '/index.html': '<h1>hi</h1>' });
    expect(markDirty).toHaveBeenCalled();
  });
});

/**
 * A push made while a server run is writing the project waits, and goes out when the run's end has
 * been pulled: sent earlier it carries a revision the run has moved past.
 */
describe('orchestrator slice — pushes during a server run', () => {
  let store: ReturnType<typeof createTestStore>;
  let sent: string[];
  const task = (over: Record<string, unknown> = {}) => ({
    projectId: 'p1', projectName: '', prompt: 'q', model: 'm', startedAt: 0, result: null, paused: false,
    orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1', ...over,
  });

  async function end(data: Record<string, unknown>) {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent('task_complete', { sourceProjectId: 'p1', sourceTaskId: 't1', ...data });
  }

  beforeEach(async () => {
    pullProjectWithFiles.mockClear();
    store = createTestStore();
    store.setState({ projectId: 'p1' });
    sent = [];
    const { setHeldPushSender } = await import('@/lib/vfs/push-gate');
    setHeldPushSender((projectId) => { sent.push(projectId); });
  });

  it('holds the project a server run is writing, and no other', async () => {
    const { holdPush } = await import('@/lib/vfs/push-gate');
    store.setState({ generationTasks: new Map([['p1', task()], ['local', task({ projectId: 'local', serverTaskId: undefined })]]) as never });
    expect(holdPush('p1')).toBe(true);
    expect(holdPush('local')).toBe(false);
    expect(holdPush('idle')).toBe(false);
  });

  it('sends the push that waited once the run has ended and been pulled', async () => {
    const { holdPush } = await import('@/lib/vfs/push-gate');
    store.setState({ generationTasks: new Map([['p1', task()]]) as never });
    expect(holdPush('p1')).toBe(true);
    let finishPull!: (value: { success: boolean }) => void;
    pullProjectWithFiles.mockImplementationOnce(() => new Promise(resolve => { finishPull = resolve; }));

    await end({ result: 'failed', exitReason: 'error_stop', error: 'x' });
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalled());
    expect(sent).toEqual([]);

    finishPull({ success: false });
    await vi.waitFor(() => expect(sent).toEqual(['p1']));
  });

  it('sends it when the run pauses for approval, which has no pull', async () => {
    const { holdPush } = await import('@/lib/vfs/push-gate');
    store.setState({ generationTasks: new Map([['p1', task()]]) as never });
    holdPush('p1');

    await end({ result: 'success', exitReason: 'awaiting_user' });
    await vi.waitFor(() => expect(sent).toEqual(['p1']));
    expect(pullProjectWithFiles).not.toHaveBeenCalled();
  });

  it('waits for the run\'s files to finish arriving before it pulls', async () => {
    const { whenFilesSynced } = await import('@/lib/server-generate/file-sync-handler');
    let arrived!: () => void;
    vi.mocked(whenFilesSynced).mockImplementationOnce(() => new Promise<void>(resolve => { arrived = resolve; }));
    store.setState({ generationTasks: new Map([['p1', task()]]) as never });

    await end({ result: 'success', exitReason: 'status_complete' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pullProjectWithFiles).not.toHaveBeenCalled();

    arrived();
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalledWith('p1'));
  });

  it('sends nothing when no push waited', async () => {
    store.setState({ generationTasks: new Map([['p1', task()]]) as never });
    await end({ result: 'success', exitReason: 'status_complete' });
    await vi.waitFor(() => expect(pullProjectWithFiles).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });
});
