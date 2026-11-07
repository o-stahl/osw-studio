import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { toast } from 'sonner';
import { debugEventsState } from '@/lib/llm/debug-events-state';

setupOrchestratorMocks();

// Tasks are kept one per project id. A second start for a project that is already generating used to
// reach the server path untouched, take the slot, and orphan the running task where Stop could not
// reach it; when the orphan finished on the server its changes arrived as another device's edits.
describe('orchestrator slice — one task per project in server mode', () => {
  let store: ReturnType<typeof createTestStore>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    store.setState({ connectSSE: vi.fn() });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ taskId: 't2' }) });
    vi.stubGlobal('fetch', fetchMock);
    // The store is in server mode when the flag is set and a window exists.
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubGlobal('window', { location: { pathname: '/w/ws1/projects' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not start a second server task while the project has one running', async () => {
    const running = new Map(store.getState().generationTasks);
    running.set('proj1', {
      projectId: 'proj1', projectName: 'P', prompt: 'first', model: 'm', startedAt: Date.now(), result: null,
      paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
    });
    store.setState({ generationTasks: running });

    await store.getState().startGeneration('second change', undefined, { projectId: 'proj1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.getState().generationTasks.get('proj1')?.serverTaskId).toBe('t1');
    // A refused send has to say why, or the message just sits in the composer.
    expect(toast.info).toHaveBeenCalledWith('Still working on the last change. Wait for it to finish, or stop it first.');
  });

  it('closes a server task locally when the server has no loop left to stop', async () => {
    const running = new Map(store.getState().generationTasks);
    running.set('proj1', {
      projectId: 'proj1', projectName: 'P', prompt: 'first', model: 'm', startedAt: Date.now(), result: null,
      paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
    });
    store.setState({ generationTasks: running });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, alreadyDone: true }) });

    await store.getState().stopGeneration('proj1');

    expect(store.getState().generationTasks.get('proj1')?.result).toBe('failed');
    expect(store.getState().isProjectGenerating('proj1')).toBe(false);
  });

  it('keeps waiting for the server when it confirms a live loop was told to stop', async () => {
    const running = new Map(store.getState().generationTasks);
    running.set('proj1', {
      projectId: 'proj1', projectName: 'P', prompt: 'first', model: 'm', startedAt: Date.now(), result: null,
      paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
    });
    store.setState({ generationTasks: running });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, hadOrchestrator: true }) });

    await store.getState().stopGeneration('proj1');

    expect(store.getState().generationTasks.get('proj1')?.result).toBeNull();
  });

  // The window between the press and the POST is where the double-start actually came from: the
  // task was only recorded once the server answered, so the guard read "not busy" through a model
  // resolve, a project sync and a checkpoint write.
  it('claims the project before it awaits anything, so a second press in that window is refused', async () => {
    let releasePost: (v: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      releasePost = () => resolve({ ok: true, json: async () => ({ taskId: 't9' }) });
    }));

    store.setState({ projectId: 'proj3' });
    const first = store.getState().startGeneration('first change', undefined, { projectId: 'proj3' });
    // Synchronously after the press: the claim is what closes the guard, and it is set before the
    // first await rather than after the server answers.
    expect(store.getState().isProjectGenerating('proj3')).toBe(true);

    await store.getState().startGeneration('second change', undefined, { projectId: 'proj3' });

    // The slot still holds the first press. Asserted on the claim rather than on fetch, because
    // the first call is still working through its awaits and has not reached the POST yet — which
    // is exactly the window this guards.
    expect(store.getState().generationTasks.size).toBe(1);
    expect(store.getState().generationTasks.get('proj3')?.prompt).toBe('first change');

    // Released only once the POST exists: the first call is still ahead of it here, so releasing
    // before that would be releasing a promise that has not been created yet.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releasePost(null);
    await first;
    expect(store.getState().generationTasks.get('proj3')?.serverTaskId).toBe('t9');
  });

  it('shows the request in the thread without waiting for the server', async () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => { /* never answers */ }));

    // Events are only appended to `debugEvents` for the project being viewed; for any other they
    // are stashed as background.
    store.setState({ projectId: 'proj4' });
    void store.getState().startGeneration('make it blue', undefined, { projectId: 'proj4' });

    // Only the model resolve stands in front of it now, not the sync, the checkpoint or the POST —
    // and the POST in this test never answers at all.
    await vi.waitFor(() => {
      const messages = store.getState().debugEvents.filter((e) => e.event === 'conversation_message');
      expect(messages.map((e) => e.data.message.content)).toContain('make it blue');
    });
  });

  it('gives the claim back when it cannot start, so the project is not left generating', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'nope' }) });

    await store.getState().startGeneration('a change', undefined, { projectId: 'proj5' });

    expect(store.getState().generationTasks.has('proj5')).toBe(false);
    expect(store.getState().isProjectGenerating('proj5')).toBe(false);
  });

  // The post-send cleanup in the workspace (spending the selection's inclusion, dropping
  // attachments and placed blocks) is keyed off this. A refused start that reported nothing
  // looked identical to one that ran, so the context was thrown away for a message still sitting
  // in the composer.
  it('reports false when it refuses a start, and true when one is accepted', async () => {
    const running = new Map(store.getState().generationTasks);
    running.set('proj6', {
      projectId: 'proj6', projectName: 'P', prompt: 'first', model: 'm', startedAt: Date.now(), result: null,
      paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't1',
    });
    store.setState({ generationTasks: running });

    expect(await store.getState().startGeneration('second', undefined, { projectId: 'proj6' })).toBe(false);
    expect(await store.getState().startGeneration('first', undefined, { projectId: 'proj7' })).toBe(true);
  });

  it('reports false when the start fails on the server', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'nope' }) });
    expect(await store.getState().startGeneration('a change', undefined, { projectId: 'proj8' })).toBe(false);
  });

  it('reports false when the tour holds the input', async () => {
    expect(await store.getState().startGeneration('a change', undefined, {
      projectId: 'proj9', isTourLockingInput: true,
    })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still starts for a project with nothing running', async () => {
    await store.getState().startGeneration('a change', undefined, { projectId: 'proj2' });
    expect(fetchMock).toHaveBeenCalledWith('/api/server-generate', expect.anything());
  });
});

/**
 * Two tasks on one project, however they came about, each have to stay visible and stoppable: a
 * start is refused on a project that has a task, a Stop reaches the task it was pressed for even
 * before the server has named it, and one task's ending leaves another's alone.
 */
describe('orchestrator slice — server tasks that would otherwise run side by side', () => {
  let store: ReturnType<typeof createTestStore>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const runningEntry = (projectId: string, serverTaskId: string) => ({
    projectId, projectName: 'P', prompt: 'first', model: 'm', startedAt: 1, result: null,
    paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId,
  });
  const posts = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url);
  /** The handler the store gave its event stream. */
  async function onEvent() {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: Record<string, unknown>) => void }][] } };
    return ctor.mock.calls[ctor.mock.calls.length - 1][0].onEvent;
  }

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ taskId: 't2' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    vi.stubGlobal('window', { location: { pathname: '/w/ws1/projects' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('refuses a start that goes straight to the server path, as a connector\'s does', async () => {
    store.setState({ generationTasks: new Map([['proj1', runningEntry('proj1', 't1')]]) });
    const onBusy = vi.fn();

    expect(await store.getState().startServerGeneration('proj1', 'from a connector', false, undefined, { projectId: 'proj1', onBusy })).toBe(false);

    expect(posts('/api/server-generate')).toHaveLength(0);
    expect(store.getState().generationTasks.get('proj1')?.serverTaskId).toBe('t1');
    expect(onBusy).toHaveBeenCalledTimes(1);
  });

  it('takes the request back to the composer when the server already has a task on the project, and brings that one in', async () => {
    store.setState({ projectId: 'proj5', connectSSE: vi.fn() });
    fetchMock.mockImplementation(async (url: string) => url === '/api/server-generate'
      ? { ok: false, status: 409, json: async () => ({
        error: 'A task is already running for this project.',
        activeTask: { taskId: 't1', projectId: 'proj5', status: 'paused', startedAt: 1, prompt: 'earlier', model: 'm', projectName: 'P' },
      }) }
      : { ok: true, json: async () => ({ tasks: [] }) });
    // The composer empties whenever its project starts generating: once for this start's claim, and
    // again when the task it was refused for is brought in.
    const timeline: Array<{ generating: boolean; draft: string | null }> = [];
    const unsubscribe = store.subscribe((s) => { timeline.push({ generating: s.generating, draft: s.composerDraft?.text ?? null }); });

    expect(await store.getState().startGeneration('make it blue', undefined, { projectId: 'proj5', displayPrompt: 'make it blue' })).toBe(false);
    unsubscribe();

    expect(toast.info).toHaveBeenCalledWith('Still working on the last change. Wait for it to finish, or stop it first.');
    // What the person typed comes back to the composer, after the last time it emptied.
    expect(store.getState().composerDraft?.text).toBe('make it blue');
    const drafted = timeline.findIndex((entry) => entry.draft !== null);
    expect(drafted).not.toBe(-1);
    expect(timeline.slice(drafted).some((entry, i, after) => i > 0 && entry.generating && !after[i - 1].generating)).toBe(false);
    const messages = store.getState().debugEvents.filter((e) => e.event === 'conversation_message');
    expect(messages.map((e) => e.data.message.content)).not.toContain('make it blue');
    expect(store.getState().debugEvents.filter((e) => e.event === 'waiting' || e.event === 'checkpoint_created')).toEqual([]);
    // Taken from the answer itself: a second look at the server could land after newer state.
    expect(store.getState().generationTasks.get('proj5')).toMatchObject({ serverTaskId: 't1', prompt: 'earlier', result: null, paused: true });
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/server-generate/status')).toEqual([]);
  });

  it('gives the composer nothing back for a refused start that did not come from it', async () => {
    store.setState({ projectId: 'proj5', connectSSE: vi.fn() });
    fetchMock.mockImplementation(async (url: string) => url === '/api/server-generate'
      ? { ok: false, status: 409, json: async () => ({ error: 'A task is already running for this project.' }) }
      : { ok: true, json: async () => ({ tasks: [] }) });

    // A connector's run, as the MCP bridge starts it: its prompt is not the person's to send again.
    expect(await store.getState().startServerGeneration('proj5', 'from a connector', false, undefined, { projectId: 'proj5' })).toBe(false);

    expect(store.getState().composerDraft).toBeNull();
  });

  it('keeps a task started right after an ending, whatever an older view of the server says', async () => {
    store.setState({ projectId: 'proj11', generationTasks: new Map([['proj11', runningEntry('proj11', 't1')]]) });
    let snapshot: (() => void) | undefined;
    fetchMock.mockImplementation((url: string) => url === '/api/server-generate/status'
      ? new Promise((resolve) => {
        snapshot = () => resolve({ ok: true, json: async () => ({ tasks: [{ taskId: 't1', projectId: 'proj11', status: 'completed', startedAt: 1 }] }) });
      })
      : Promise.resolve({ ok: true, json: async () => ({ taskId: 't2' }) }));
    const send = await onEvent();

    send('task_complete', { sourceProjectId: 'proj11', sourceTaskId: 't1', result: 'success' });
    expect(await store.getState().startGeneration('make it blue', undefined, { projectId: 'proj11' })).toBe(true);
    snapshot?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.getState().generationTasks.get('proj11')).toMatchObject({ serverTaskId: 't2', result: null });
  });

  it('takes back a start for a project not on screen without saving over its chat or filling the composer on screen', async () => {
    vi.useFakeTimers();
    try {
      // Open earlier in this tab, so its chat saves are armed; the tab now shows another project.
      store.getState().initPersistence('proj9');
      store.setState({ projectId: 'other', connectSSE: vi.fn() });
      fetchMock.mockImplementation(async (url: string) => url === '/api/server-generate'
        ? { ok: false, status: 409, json: async () => ({ error: 'A task is already running for this project.' }) }
        : { ok: true, json: async () => ({ tasks: [] }) });

      expect(await store.getState().startServerGeneration('proj9', 'make it blue', false, undefined, { projectId: 'proj9', displayPrompt: 'make it blue' })).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);

      expect(vi.mocked(debugEventsState.saveEvents).mock.calls.filter(([id]) => id === 'proj9')).toEqual([]);
      // The composer on screen is another project's.
      expect(store.getState().composerDraft).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a task Stop was pressed for before the server had named it, once it has', async () => {
    store.setState({ connectSSE: vi.fn() });
    let answer!: () => void;
    fetchMock.mockImplementation((url: string) => url === '/api/server-generate'
      ? new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ taskId: 't6' }) }); })
      : Promise.resolve({ ok: true, json: async () => ({ ok: true, hadOrchestrator: true }) }));

    const start = store.getState().startGeneration('make it blue', undefined, { projectId: 'proj6' });
    await vi.waitFor(() => expect(posts('/api/server-generate')).toHaveLength(1));
    await store.getState().stopGeneration('proj6');
    expect(posts('/api/server-generate/cancel')).toHaveLength(0);
    expect(store.getState().isProjectGenerating('proj6')).toBe(true);

    answer();
    await start;

    await vi.waitFor(() => expect(posts('/api/server-generate/cancel')).toHaveLength(1));
    expect(JSON.parse(posts('/api/server-generate/cancel')[0][1].body)).toEqual({ taskId: 't6', projectId: 'proj6' });
    expect(store.getState().isProjectGenerating('proj6')).toBe(true);
  });

  it('sends nothing when Stop comes while the run is still being set up, and gives the request back to the composer', async () => {
    store.setState({ projectId: 'proj8', connectSSE: vi.fn() });

    const start = store.getState().startGeneration('make it blue', undefined, { projectId: 'proj8', displayPrompt: 'make it blue' });
    await store.getState().stopGeneration('proj8');

    expect(await start).toBe(false);
    expect(posts('/api/server-generate')).toHaveLength(0);
    expect(store.getState().isProjectGenerating('proj8')).toBe(false);
    expect(store.getState().debugEvents.filter((e) => e.event === 'conversation_message')).toEqual([]);
    // The composer emptied when the start claimed the project.
    expect(store.getState().composerDraft?.text).toBe('make it blue');
  });

  it('takes back everything a withdrawn start put in the thread, its drop of an unanswered request included', async () => {
    store.setState({ projectId: 'proj10', connectSSE: vi.fn() });
    // A request whose run stopped before any reply, which a new start drops from the model's history.
    store.getState().addDebugEvent('conversation_message', { message: { role: 'user', content: 'make it red' } }, 'proj10');
    const before = store.getState().debugEvents;

    const start = store.getState().startGeneration('make it blue', undefined, { projectId: 'proj10' });
    await store.getState().stopGeneration('proj10');

    expect(await start).toBe(false);
    expect(store.getState().debugEvents).toEqual(before);
  });

  it('leaves the project\'s running task as it is when another task on it ends', async () => {
    store.setState({ projectId: 'proj1', generationTasks: new Map([['proj1', runningEntry('proj1', 't1')]]) });
    const send = await onEvent();

    send('task_complete', { sourceProjectId: 'proj1', sourceTaskId: 'left-over', result: 'success' });

    expect(store.getState().generationTasks.get('proj1')).toMatchObject({ serverTaskId: 't1', result: null });
    expect(store.getState().debugEvents.filter((e) => e.event === 'task_complete')).toHaveLength(1);

    send('task_complete', { sourceProjectId: 'proj1', sourceTaskId: 't1', result: 'success' });

    expect(store.getState().isProjectGenerating('proj1')).toBe(false);
  });

  it('ends a task whose ending arrived before the server had named it', async () => {
    let answer!: () => void;
    fetchMock.mockImplementation((url: string) => url === '/api/server-generate'
      ? new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ taskId: 't7' }) }); })
      : Promise.resolve({ ok: true, json: async () => ({ tasks: [] }) }));
    const send = await onEvent();

    const start = store.getState().startGeneration('make it blue', undefined, { projectId: 'proj7' });
    await vi.waitFor(() => expect(posts('/api/server-generate')).toHaveLength(1));
    send('task_complete', { sourceProjectId: 'proj7', sourceTaskId: 't7', result: 'failed', error: 'No credits' });
    expect(store.getState().isProjectGenerating('proj7')).toBe(true);

    answer();
    await start;

    expect(store.getState().isProjectGenerating('proj7')).toBe(false);
  });

  it('brings in the task still going on a project, beside a newer one that has ended, and one stopping', async () => {
    store.setState({ connectSSE: vi.fn() });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ tasks: [
      { taskId: 't2', projectId: 'p1', status: 'completed', startedAt: 200 },
      { taskId: 't1', projectId: 'p1', status: 'running', startedAt: 100 },
      { taskId: 't3', projectId: 'p2', status: 'stopping', startedAt: 50 },
    ] }) });

    await store.getState().reattachServerTasks();

    expect(store.getState().generationTasks.get('p1')).toMatchObject({ serverTaskId: 't1', result: null });
    expect(store.getState().generationTasks.get('p2')).toMatchObject({ serverTaskId: 't3', result: null, stopping: true });
  });
});
