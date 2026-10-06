import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { toast } from 'sonner';

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

  it('shows the request in the transcript without waiting for the server', async () => {
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
