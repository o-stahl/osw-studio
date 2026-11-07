import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { toast } from 'sonner';
import { track } from '@/lib/telemetry';

const mockExecute = vi.fn();
const mockStop = vi.fn();
const mockImportConversation = vi.fn();

vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    stop: mockStop,
    importConversation: mockImportConversation,
  })),
}));

setupOrchestratorMocks();

describe('orchestrator slice — generation results and conversation rebuild', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({
      success: true,
      summary: 'done',
      totalCost: 0,
      toolCount: 0,
      turnCount: 0,
      apiErrorCount: 0,
    });
  });

  it('does not show an error toast or double-track task_fail for a user-stopped run', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const run = store.getState().startGeneration('build something');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    // The run comes back as a stopped orchestrator returns.
    finish({ success: false, summary: 'Stopped by user', exitReason: 'stopped', totalCost: 0, toolCount: 1, turnCount: 1, apiErrorCount: 0 });
    await run;

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Task completed');
    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls.map((c) => c[1].reason)).toEqual(['stopped']);
  });

  it('ends a Chat-mode answer without the completion toast, which a Code-mode run still gets', async () => {
    mockExecute.mockResolvedValue({
      success: true, summary: 'Answered (read-only)', exitReason: 'answered',
      totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 0,
    });
    await store.getState().startGeneration('what does the hero say?', undefined, { projectId: 'p1', chatMode: true, mode: 'chat' });
    expect(toast.success).not.toHaveBeenCalled();

    mockExecute.mockResolvedValue({
      success: true, summary: 'done', exitReason: 'status_complete',
      totalCost: 0, toolCount: 1, turnCount: 1, apiErrorCount: 0,
    });
    await store.getState().startGeneration('make it blue', undefined, { projectId: 'p1', chatMode: false, mode: 'code' });
    expect(toast.success).toHaveBeenCalledWith('Task completed');
  });

  it('still reports genuine failures with toast and telemetry', async () => {
    mockExecute.mockResolvedValue({
      success: false,
      summary: 'Reached maximum iterations (40)',
      exitReason: 'max_iterations',
      totalCost: 0,
      toolCount: 1,
      turnCount: 1,
      apiErrorCount: 0,
    });

    await store.getState().startGeneration('build something');

    expect(toast.error).toHaveBeenCalled();
    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls).toHaveLength(1);
  });

  it('tracks a provider-error stop as task_fail (api_error) without an error toast', async () => {
    mockExecute.mockResolvedValue({
      success: false,
      summary: 'Stopped on a provider error',
      exitReason: 'error_stop',
      totalCost: 0,
      toolCount: 1,
      turnCount: 1,
      apiErrorCount: 1,
    });

    await store.getState().startGeneration('build something');

    expect(toast.error).not.toHaveBeenCalled();
    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][1]).toMatchObject({ reason: 'api_error', api_error_count: 1 });
  });

  it('tracks only the Stop when the user stops while a provider error is being handled', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const run = store.getState().startGeneration('build something');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    finish({
      success: false,
      summary: 'Stopped on a provider error',
      exitReason: 'error_stop',
      totalCost: 0,
      toolCount: 0,
      turnCount: 1,
      apiErrorCount: 1,
    });
    await run;

    expect(toast.error).not.toHaveBeenCalled();
    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][1]).toMatchObject({ reason: 'stopped' });
  });

  it('keeps the project busy after a Stop until the run has returned, and starts nothing beside it', async () => {
    // A run that was told to stop can still be finishing a tool call and writing files. A second
    // run started in that window took the project's task, and the first run's return then took
    // the second one's orchestrator with it: the second run could no longer be stopped.
    let finishFirst!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    const projectId = store.getState().projectId;

    const first = store.getState().startGeneration('first');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));
    await store.getState().stopGeneration();

    expect(store.getState().isProjectGenerating(projectId)).toBe(true);
    expect(await store.getState().startGeneration('second')).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith('Still stopping the last change. It will be a moment.');

    finishFirst({ success: false, summary: 'Stopped', exitReason: 'stopped', totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 0 });
    await first;

    expect(store.getState().isProjectGenerating(projectId)).toBe(false);
    expect(store.getState().debugEvents.filter((e) => e.event === 'task_complete').map((e) => e.data.result)).toEqual(['stopped']);
    expect(await store.getState().startGeneration('second')).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('keeps a run from starting when Stop is pressed while it is still being set up, and gives the request back', async () => {
    const projectId = store.getState().projectId;

    const run = store.getState().startGeneration('build something', undefined, { projectId, displayPrompt: 'build something' });
    await store.getState().stopGeneration();

    // Nothing was sent, so the workspace keeps the selection and blocks that went with it.
    expect(await run).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(store.getState().isProjectGenerating(projectId)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
    // The composer emptied when the run claimed the project.
    expect(store.getState().composerDraft?.text).toBe('build something');
  });

  it('counts a stop once, where the run ends, under the run\'s own task id', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const calls = () => (track as ReturnType<typeof vi.fn>).mock.calls;

    const run = store.getState().startGeneration('build something');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    expect(calls().filter((c) => c[0] === 'task_fail')).toHaveLength(0);

    finish({ success: false, summary: 'Stopped', exitReason: 'stopped', totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 0 });
    await run;

    const started = calls().find((c) => c[0] === 'task_started')![1];
    expect(calls().filter((c) => c[0] === 'task_fail' || c[0] === 'task_complete').map((c) => [c[0], c[1].reason, c[1].task_id]))
      .toEqual([['task_fail', 'stopped', started.task_id]]);
  });

  it('counts a run that finished despite a late Stop as finished, and only that', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const run = store.getState().startGeneration('build something');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    finish({ success: true, summary: 'done', exitReason: 'status_complete_post_tool', totalCost: 0, toolCount: 1, turnCount: 1, apiErrorCount: 0 });
    await run;

    const endings = (track as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'task_fail' || c[0] === 'task_complete');
    expect(endings.map((c) => c[0])).toEqual(['task_complete']);
  });

  it('asks a run to stop again on a second press, but counts one stop', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const run = store.getState().startGeneration('build something');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
    await store.getState().stopGeneration();
    await store.getState().stopGeneration();

    expect(mockStop).toHaveBeenCalledTimes(2);
    finish({ success: false, summary: 'Stopped', exitReason: 'stopped', totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 0 });
    await run;
    expect((track as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'task_fail')).toHaveLength(1);
  });

  // One task per project is kept by the guards above. Should two runs still find themselves on one
  // project, the one that returns first finishes only its own task, so both stay on screen.
  describe('a run that returns to find another run holding the project', () => {
    const other = { prompt: 'other', model: 'm', result: null, paused: false, persistedInstance: null } as const;

    for (const [ending, outcome] of [
      ['finished', () => Promise.resolve({ success: true, summary: 'done', exitReason: 'status_complete', totalCost: 0, toolCount: 1, turnCount: 1, apiErrorCount: 0 })],
      ['failed', () => Promise.resolve({ success: false, summary: 'Provider error', exitReason: 'error_stop', totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 1 })],
      ['threw', () => Promise.reject(new Error('boom'))],
    ] as const) {
      it(`leaves it alone when it ${ending}`, async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        mockExecute.mockImplementationOnce(() => gate.then(outcome));
        const projectId = store.getState().projectId;

        const run = store.getState().startGeneration('first');
        await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());
        const holder = { stop: vi.fn() };
        store.setState({ generationTasks: new Map([[projectId, {
          ...other, projectId, projectName: '', startedAt: 1, orchestratorInstance: holder as never,
        }]]) });

        release();
        await run;

        const task = store.getState().generationTasks.get(projectId);
        expect(task).toMatchObject({ prompt: 'other', result: null, startedAt: 1 });
        expect(task?.orchestratorInstance).toBe(holder);
        expect(store.getState().generating).toBe(true);
        expect(store.getState().debugEvents.filter((e) => e.event === 'task_complete' || e.event === 'error')).toEqual([]);
      });
    }
  });

  it('rebuilds imported conversation from the last conversation_replaced event', async () => {
    const projectId = store.getState().projectId;
    const m1 = { role: 'user', content: 'old pre-compaction message' };
    const replaced = [
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: 'summary', ui_metadata: { isCompactSummary: true } },
    ];
    const m2 = { role: 'user', content: 'post-compaction message' };

    store.getState().addDebugEvent('conversation_message', { message: m1 }, projectId);
    store.getState().addDebugEvent('conversation_replaced', { messages: replaced }, projectId);
    store.getState().addDebugEvent('conversation_message', { message: m2 }, projectId);

    await store.getState().startGeneration('continue work');

    expect(mockImportConversation).toHaveBeenCalledTimes(1);
    const imported = mockImportConversation.mock.calls[0][0];
    expect(imported).toEqual([...replaced, m2]);
  });
});
