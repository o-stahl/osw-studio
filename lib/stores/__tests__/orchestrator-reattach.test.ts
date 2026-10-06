// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

// Reattach recovery: when the client reconnects and the server reports no task for a project it
// still has an in-flight generation for, the outcome is genuinely unknown. It must be surfaced as
// 'unavailable' — never a false 'completed' (old behavior) or an invented 'failed'.
describe('orchestrator slice — reattach recovery', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    store.setState({ connectSSE: vi.fn(), disconnectSSE: vi.fn() });
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    // Server has no tasks for this session (the task expired from both stores).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [] }) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('marks a server task absent from both stores as unavailable, not completed or failed', async () => {
    store.setState({
      generationTasks: new Map([['proj-x', {
        projectId: 'proj-x',
        projectName: 'X',
        prompt: 'build it',
        model: 'm',
        startedAt: 1,
        result: null,
        paused: false,
        orchestratorInstance: null,
        persistedInstance: null,
        serverTaskId: 'srv-1',
      }]]),
    });

    await store.getState().reattachServerTasks();

    expect(store.getState().generationTasks.get('proj-x')?.result).toBe('unavailable');
  });

  it('leaves a task with no serverTaskId untouched', async () => {
    store.setState({
      generationTasks: new Map([['proj-local', {
        projectId: 'proj-local',
        projectName: 'Local',
        prompt: 'build it',
        model: 'm',
        startedAt: 1,
        result: null,
        paused: false,
        orchestratorInstance: null,
        persistedInstance: null,
      }]]),
    });

    await store.getState().reattachServerTasks();

    // Not a reattachable server task → recovery logic must not synthesize a result.
    expect(store.getState().generationTasks.get('proj-local')?.result).toBeNull();
  });
});
