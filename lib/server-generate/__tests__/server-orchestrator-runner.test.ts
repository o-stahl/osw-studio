import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runServerGeneration, awaitBuildResult, awaitImageResult } from '../server-orchestrator-runner';
import { imageDelegationTimeoutMs } from '@/lib/llm/image-gen-timeout';
import { claimImageRequest, settleImageRequest } from '../image-requests';
import { TaskManager } from '../task-manager';
import { SSEEventBus } from '../sse-event-bus';
import type { StartGenerationRequest, BuildResult } from '../types';
import type { VirtualFileSystem } from '@/lib/vfs';
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';

const mockExecute = vi.fn().mockResolvedValue({ success: true });
const mockStop = vi.fn();
const mockImportConversation = vi.fn();

vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    stop: mockStop,
    importConversation: mockImportConversation,
  })),
}));

vi.mock('../vfs-context', () => ({
  runWithVFS: (_vfs: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@/lib/vfs', () => ({
  VirtualFileSystem: vi.fn(),
  registerContextVFSProvider: vi.fn(),
}));

function createMockVFS(): VirtualFileSystem {
  return {
    createFile: vi.fn(),
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    moveFile: vi.fn(),
    deleteDirectory: vi.fn(),
    createDirectory: vi.fn(),
    getAllFilesAndDirectories: vi.fn().mockResolvedValue([]),
  } as unknown as VirtualFileSystem;
}

function makeRequest(overrides?: Partial<StartGenerationRequest>): StartGenerationRequest {
  return {
    projectId: 'proj-1',
    prompt: 'add a button',
    model: 'gpt-4',
    apiKey: 'sk-test',
    conversationHistory: [],
    generationParams: {},
    ...overrides,
  };
}

describe('runServerGeneration', () => {
  let tm: TaskManager;
  let bus: SSEEventBus;
  let mockVFS: VirtualFileSystem;

  beforeEach(() => {
    tm = new TaskManager({ maxConcurrentPerScope: 5, keyTTLMs: 30 * 60 * 1000 });
    bus = new SSEEventBus({ maxBufferSize: 500 });
    mockVFS = createMockVFS();
    vi.clearAllMocks();
  });

  afterEach(() => {
    tm.dispose();
  });

  function makeDeps() {
    return {
      taskManager: tm,
      eventBus: bus,
      createVFS: vi.fn().mockResolvedValue(mockVFS),
      apiBaseUrl: 'http://localhost:3000',
    };
  }

  it('emits task_complete with result=success on happy path', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete).toBeDefined();
    expect(complete!.data.result).toBe('success');
    expect(tm.getTask(taskId)?.status).toBe('completed');
  });

  it('emits task_complete with result=failed when the loop reports failure without throwing', async () => {
    mockExecute.mockResolvedValueOnce({
      success: false,
      summary: 'Reached maximum iterations (40)',
      exitReason: 'max_iterations',
    });
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('failed');
    expect(complete!.data.error).toBe('Reached maximum iterations (40)');
    expect(tm.getTask(taskId)?.status).toBe('failed');
  });

  it('emits task_complete with result=stopped when the loop reports a user stop', async () => {
    mockExecute.mockResolvedValueOnce({
      success: false,
      summary: 'Stopped by user',
      exitReason: 'stopped',
    });
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('stopped');
    expect(tm.getTask(taskId)?.status).toBe('cancelled');
  });

  it('emits task_complete with result=failed when orchestrator throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('LLM API failed'));
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const errorEvt = emitted.find((e) => e.event === 'error');
    expect(errorEvt).toBeDefined();
    expect(errorEvt!.data.message).toBe('LLM API failed');

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('failed');
    expect(tm.getTask(taskId)?.status).toBe('failed');
  });

  it('emits task_complete with result=stopped when task is cancelled', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    mockExecute.mockImplementationOnce(async () => {
      tm.getTask(taskId)!.status = 'cancelled';
      throw new Error('Stopped');
    });
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('stopped');
    expect(tm.getTask(taskId)?.status).toBe('cancelled');
  });

  it('emits task_complete with result=stopped when task is paused', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    mockExecute.mockImplementationOnce(async () => {
      tm.getTask(taskId)!.status = 'paused';
      throw new Error('Paused');
    });
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('stopped');
    expect(tm.getTask(taskId)?.status).toBe('cancelled');
  });

  it('reports stopped (not success) when task paused without throw', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    mockExecute.mockImplementationOnce(async () => {
      tm.getTask(taskId)!.status = 'paused';
      return { success: true };
    });
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const complete = emitted.find((e) => e.event === 'task_complete');
    expect(complete!.data.result).toBe('stopped');
  });

  it('throws when task does not exist', async () => {
    await expect(runServerGeneration('nonexistent', makeRequest(), makeDeps()))
      .rejects.toThrow('Task nonexistent not found');
  });

  it('calls importConversation when conversationHistory is provided', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const history = [{ role: 'user', content: 'hello' }];

    await runServerGeneration(taskId, makeRequest({ conversationHistory: history }), makeDeps());

    expect(mockImportConversation).toHaveBeenCalledWith(history);
  });

  it('does not call importConversation when history is empty', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');

    await runServerGeneration(taskId, makeRequest({ conversationHistory: [] }), makeDeps());

    expect(mockImportConversation).not.toHaveBeenCalled();
  });

  // The agent only offers `generate-image` when the tab said it has an image model, and the
  // generation itself has to travel back to that tab.
  it('wires image generation through to the browser that asked for the run', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    await runServerGeneration(taskId, makeRequest({ imageGenAvailable: true }), makeDeps());

    const options = vi.mocked(MultiAgentOrchestrator).mock.calls[0][3] as { serverContext: {
      imageGenAvailable?: boolean;
      onImageRequested?: (prompt: string, opts: { aspectRatio?: string }) => Promise<unknown>;
    } };
    expect(options.serverContext.imageGenAvailable).toBe(true);

    const answer = options.serverContext.onImageRequested!('a lighthouse', { aspectRatio: '16:9' });
    const request = bus.getBuffer(taskId).find((e) => e.event === 'image_requested')!.data as unknown as { requestId: string; prompt: string; aspectRatio: string };
    expect(request).toMatchObject({ prompt: 'a lighthouse', aspectRatio: '16:9' });
    settleImageRequest(tm.getTask(taskId)!, request.requestId, { base64: 'iVBOR', mimeType: 'image/png' });
    await expect(answer).resolves.toEqual({ base64: 'iVBOR', mimeType: 'image/png' });
  });

  it('does not advertise image generation when the tab has no image model', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    await runServerGeneration(taskId, makeRequest(), makeDeps());
    const options = vi.mocked(MultiAgentOrchestrator).mock.calls[0][3] as { serverContext: { imageGenAvailable?: boolean } };
    expect(options.serverContext.imageGenAvailable).toBeFalsy();
  });

  it('flushes dirty paths as files_changed on tool_status completed', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const { MultiAgentOrchestrator } = await import('@/lib/llm/multi-agent-orchestrator');
    (MultiAgentOrchestrator as any).mockImplementationOnce(
      (_projId: string, _role: string, progressCb: (event: string, data?: unknown) => void) => ({
        execute: vi.fn().mockImplementation(async () => {
          // trackVFSMutations wraps createFile to add paths to dirtyPaths.
          // Call the wrapped createFile to populate dirtyPaths, then trigger flush via tool_status.
          await mockVFS.createFile('proj-1', '/new-file.html', '<h1>hi</h1>');
          progressCb('tool_status', { status: 'completed' });
          return { success: true };
        }),
        stop: vi.fn(),
        importConversation: vi.fn(),
      }),
    );

    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    await runServerGeneration(taskId, makeRequest(), makeDeps());

    const filesChanged = emitted.find((e) => e.event === 'files_changed');
    expect(filesChanged).toBeDefined();
    expect((filesChanged!.data.paths as string[])).toContain('/new-file.html');
  });
});

describe('awaitBuildResult', () => {
  let tm: TaskManager;
  let bus: SSEEventBus;

  beforeEach(() => {
    tm = new TaskManager({ maxConcurrentPerScope: 5, keyTTLMs: 30 * 60 * 1000 });
    bus = new SSEEventBus({ maxBufferSize: 500 });
    vi.clearAllMocks();
  });

  afterEach(() => {
    tm.dispose();
  });

  function makeDeps() {
    const mockVFS = createMockVFS();
    return {
      taskManager: tm,
      eventBus: bus,
      createVFS: vi.fn().mockResolvedValue(mockVFS),
      apiBaseUrl: 'http://localhost:3000',
    };
  }

  it('returns task-not-found error for nonexistent task', async () => {
    const result = await awaitBuildResult('nonexistent', makeDeps());
    expect(result).toEqual({ success: false, errors: ['Task not found'] });
  });

  it('resolves when pendingBuildResolve is called', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const deps = makeDeps();

    const resultPromise = awaitBuildResult(taskId, deps);

    // Simulate the client posting build-result
    const task = tm.getTask(taskId)!;
    await vi.waitFor(() => expect(task.pendingBuildResolve).not.toBeNull());
    task.pendingBuildResolve!({ success: true });

    const result = await resultPromise;
    expect(result).toEqual({ success: true });
  });

  it('resolves with deferred result after 30s timeout', async () => {
    vi.useFakeTimers();
    try {
      const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
      const deps = makeDeps();

      const resultPromise = awaitBuildResult(taskId, deps);

      // Flush microtasks so the Promise.race and setTimeout are set up
      await vi.advanceTimersByTimeAsync(30_000);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.errors).toContain('Build deferred — client disconnected');

      const task = tm.getTask(taskId)!;
      expect(task.buildDeferred).toBe(true);
      expect(task.pendingBuildResolve).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits build_requested event with file manifest', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const deps = makeDeps();
    const mockVFS = await deps.createVFS('proj-1');
    (mockVFS.getAllFilesAndDirectories as any).mockResolvedValue([
      { id: 'f1', path: '/index.html', name: 'index.html', updatedAt: new Date('2026-01-01') },
      { path: '/src', name: 'src', type: 'directory' },
    ]);

    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    bus.addListener('sess-1', (e) => emitted.push(e));

    const resultPromise = awaitBuildResult(taskId, deps);

    // Resolve immediately to not hang the test
    const task = tm.getTask(taskId)!;
    await vi.waitFor(() => expect(task.pendingBuildResolve).not.toBeNull());
    task.pendingBuildResolve!({ success: true });
    await resultPromise;

    const buildReq = emitted.find((e) => e.event === 'build_requested');
    expect(buildReq).toBeDefined();
    expect(buildReq!.data.fileManifest).toBeDefined();
    const manifest = buildReq!.data.fileManifest as Record<string, number>;
    expect(manifest['/index.html']).toBeDefined();
    expect(manifest['/src']).toBeUndefined();
  });

  it('clears timeout when build resolves before 30s', async () => {
    vi.useFakeTimers();
    try {
      const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
      const deps = makeDeps();

      const resultPromise = awaitBuildResult(taskId, deps);

      // Let microtasks flush so pendingBuildResolve is set
      await vi.advanceTimersByTimeAsync(0);

      const task = tm.getTask(taskId)!;
      expect(task.pendingBuildResolve).not.toBeNull();
      task.pendingBuildResolve!({ success: true });
      await resultPromise;

      // Advance past timeout — should NOT set buildDeferred since we already resolved
      await vi.advanceTimersByTimeAsync(30_000);
      expect(task.buildDeferred).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('awaitImageResult', () => {
  let tm: TaskManager;
  let bus: SSEEventBus;

  beforeEach(() => {
    tm = new TaskManager({ maxConcurrentPerScope: 5, keyTTLMs: 30 * 60 * 1000 });
    bus = new SSEEventBus({ maxBufferSize: 500 });
  });
  afterEach(() => tm.dispose());

  const deps = () => ({ taskManager: tm, eventBus: bus, createVFS: vi.fn(), apiBaseUrl: 'http://localhost:3000' });
  const requests = (taskId: string) =>
    bus.getBuffer(taskId).filter((e) => e.event === 'image_requested').map((e) => e.data as unknown as { requestId: string; prompt: string });

  it('asks the browser for the image and returns what it posts back', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const result = awaitImageResult(taskId, deps(), 'a lighthouse', { aspectRatio: '16:9' });
    const [request] = requests(taskId);
    expect(request).toMatchObject({ taskId, prompt: 'a lighthouse', aspectRatio: '16:9', requestId: expect.any(String) });
    const task = tm.getTask(taskId)!;
    expect(settleImageRequest(task, request.requestId, { base64: 'iVBOR', mimeType: 'image/png' })).toBe(true);
    await expect(result).resolves.toEqual({ base64: 'iVBOR', mimeType: 'image/png' });
    expect(task.pendingImages?.size ?? 0).toBe(0);
  });

  it('gives parallel requests each their own answer, whichever finishes first', async () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    const a = awaitImageResult(taskId, deps(), 'A', {});
    const b = awaitImageResult(taskId, deps(), 'B', {});
    const [reqA, reqB] = requests(taskId);
    const task = tm.getTask(taskId)!;
    settleImageRequest(task, reqB.requestId, { base64: 'BBBB', mimeType: 'image/png' });
    settleImageRequest(task, reqA.requestId, { base64: 'AAAA', mimeType: 'image/png' });
    await expect(a).resolves.toMatchObject({ base64: 'AAAA' });
    await expect(b).resolves.toMatchObject({ base64: 'BBBB' });
  });

  it('answers with an error for a task that no longer exists', async () => {
    await expect(awaitImageResult('missing', deps(), 'x', {})).resolves.toEqual({ error: 'task not found' });
  });

  it('lets one tab claim a request and turns the others away', () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
    void awaitImageResult(taskId, deps(), 'x', {});
    const [request] = requests(taskId);
    const task = tm.getTask(taskId)!;
    expect(claimImageRequest(task, request.requestId)).toBe(true);
    expect(claimImageRequest(task, request.requestId)).toBe(false);
    expect(claimImageRequest(task, 'unknown')).toBe(false);
  });

  it('tells the agent to continue without it when no browser answers, and forgets only that request', async () => {
    vi.useFakeTimers();
    try {
      const taskId = tm.createTask('proj-1', 'sess-1', 'sk-test');
      const wait = imageDelegationTimeoutMs();
      let firstSettled = false;
      const first = awaitImageResult(taskId, deps(), 'x', {});
      void first.then(() => { firstSettled = true; });
      await vi.advanceTimersByTimeAsync(wait - 80_000);
      expect(firstSettled).toBe(false);
      const second = awaitImageResult(taskId, deps(), 'y', {});
      await vi.advanceTimersByTimeAsync(80_000);
      await expect(first).resolves.toMatchObject({ error: expect.stringContaining('Continue without it') });
      const task = tm.getTask(taskId)!;
      const [reqX, reqY] = requests(taskId);
      expect(task.pendingImages?.has(reqX.requestId)).toBe(false);
      expect(settleImageRequest(task, reqY.requestId, { base64: 'YYYY', mimeType: 'image/png' })).toBe(true);
      await expect(second).resolves.toMatchObject({ base64: 'YYYY' });
    } finally {
      vi.useRealTimers();
    }
  });
});
