import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { track, isTelemetryActive } from '@/lib/telemetry';
import type { GenerationTask } from '../types';

const mockExecute = vi.fn().mockResolvedValue({ success: true, summary: 'done', totalCost: 0, toolCount: 0, turnCount: 0, apiErrorCount: 0 });
vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({ execute: mockExecute, stop: vi.fn(), importConversation: vi.fn() })),
}));
vi.mock('@/lib/interview/templates-service', () => ({ interviewTemplatesService: { getTemplate: vi.fn() } }));

setupOrchestratorMocks();

/**
 * The store's record of a stop the user made, which the chat panel turns into "why did you stop?".
 * It is set for a stop and nothing else, and a new task clears it: the question is about the run
 * the person just ended, not a banner that follows them around.
 */
function runningTask(store: ReturnType<typeof createTestStore>, projectId: string, overrides?: Partial<GenerationTask>) {
  const tasks = new Map(store.getState().generationTasks);
  tasks.set(projectId, {
    projectId, projectName: 'T', prompt: 'p', model: 'm', startedAt: Date.now() - 1000,
    result: null, paused: false,
    orchestratorInstance: { stop: vi.fn() } as unknown as GenerationTask['orchestratorInstance'],
    persistedInstance: null,
    ...overrides,
  });
  store.setState({ generationTasks: tasks, generating: true, projectId });
}

describe('a stop the user made', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => { store = createTestStore(); vi.clearAllMocks(); });

  it('is recorded for the panel, and the ask is counted', async () => {
    runningTask(store, 'p1');
    await store.getState().stopGeneration();

    expect(store.getState().userStop).toMatchObject({ projectId: 'p1', taskId: 'p1' });
    expect(track).toHaveBeenCalledWith('stop_reason_shown', { task_id: 'p1' });
  });

  it('is not recorded for a task that had already ended', async () => {
    // Stop on a finished task is a no-op for the person; asking why would be nonsense.
    runningTask(store, 'p1', { result: 'completed' });
    await store.getState().stopGeneration();

    expect(store.getState().userStop).toBeNull();
    expect(track).not.toHaveBeenCalledWith('stop_reason_shown', expect.anything());
  });

  it('is cleared when a new task starts', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    store.setState({ projectId: 'p1' });
    const run = store.getState().startGeneration('first', undefined, { projectId: 'p1' });
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    // A new task can start once the stopped run has returned.
    finish({ success: false, summary: 'Stopped', exitReason: 'stopped', totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 0 });
    await run;
    expect(store.getState().userStop).not.toBeNull();

    expect(await store.getState().startGeneration('again', undefined, { projectId: 'p1' })).toBe(true);

    expect(store.getState().userStop).toBeNull();
  });

  it('is cleared by an answer or a dismissal', async () => {
    runningTask(store, 'p1');
    await store.getState().stopGeneration();

    store.getState().clearUserStop();

    expect(store.getState().userStop).toBeNull();
  });

  it('is never asked while telemetry is off, so an opt-out never looks like it failed to stick', async () => {
    vi.mocked(isTelemetryActive).mockReturnValueOnce(false);
    runningTask(store, 'p1');
    await store.getState().stopGeneration();

    expect(store.getState().userStop).toBeNull();
    expect(track).not.toHaveBeenCalledWith('stop_reason_shown', expect.anything());
  });

  it('is recorded in server mode too, where the stop goes over the wire', async () => {
    runningTask(store, 'p1', { orchestratorInstance: null, serverTaskId: 'srv-1' } as Partial<GenerationTask>);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hadOrchestrator: true }), { status: 200 })));
    try {
      await store.getState().stopGeneration();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(store.getState().userStop).toMatchObject({ projectId: 'p1' });
  });
});
