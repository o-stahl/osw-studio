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
    mockExecute.mockResolvedValue({
      success: false,
      summary: 'Stopped by user',
      exitReason: 'stopped',
      totalCost: 0,
      toolCount: 1,
      turnCount: 1,
      apiErrorCount: 0,
    });

    await store.getState().startGeneration('build something');

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Task completed');
    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls).toHaveLength(0);
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

  it('leaves a run started after a Stop alone when the stopped run returns late', async () => {
    let finishFirst!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    mockExecute.mockReturnValueOnce(new Promise(() => {}));
    const projectId = store.getState().projectId;

    const first = store.getState().startGeneration('first');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(1));
    await store.getState().stopGeneration();
    await new Promise((r) => setTimeout(r, 2));
    void store.getState().startGeneration('second');
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalledTimes(2));
    const second = store.getState().generationTasks.get(projectId);

    finishFirst({
      success: false, summary: 'Stopped on a provider error', exitReason: 'error_stop',
      totalCost: 0, toolCount: 0, turnCount: 1, apiErrorCount: 1,
    });
    await first;

    const apiFails = (track as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'task_fail' && c[1]?.reason === 'api_error');
    expect(apiFails).toHaveLength(0);
    const current = store.getState().generationTasks.get(projectId);
    expect(current?.startedAt).toBe(second?.startedAt);
    expect(current?.result).toBeNull();
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
