import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { getProjectAssignment } from '@/lib/llm/models/project-assignment';
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import { interviewTemplatesService } from '@/lib/interview/templates-service';
import { track } from '@/lib/telemetry';
import type { GenerationTask } from '../types';

const mockExecute = vi.fn().mockResolvedValue({
  success: true,
  summary: 'done',
  totalCost: 0.01,
  toolCount: 2,
  turnCount: 1,
  apiErrorCount: 0,
});
const mockStop = vi.fn();
const mockImportConversation = vi.fn();

vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    stop: mockStop,
    importConversation: mockImportConversation,
  })),
}));

vi.mock('@/lib/interview/templates-service', () => ({
  interviewTemplatesService: { getTemplate: vi.fn() },
}));

setupOrchestratorMocks();

function setActiveTask(
  store: ReturnType<typeof createTestStore>,
  projectId: string,
  overrides?: Partial<GenerationTask>,
) {
  const tasks = new Map(store.getState().generationTasks);
  tasks.set(projectId, {
    projectId,
    projectName: 'Test',
    prompt: 'test',
    model: 'gpt-4',
    startedAt: Date.now(),
    result: null,
    paused: false,
    orchestratorInstance: null,
    persistedInstance: null,
    ...overrides,
  });
  store.setState({ generationTasks: tasks, generating: true });
}

describe('orchestrator slice — generation lifecycle', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
  });

  it('startGeneration sets generating=true', async () => {
    const promise = store.getState().startGeneration('build a todo app');
    expect(store.getState().generating).toBe(true);
    await promise;
  });

  it('startGeneration sets generating=false on completion', async () => {
    await store.getState().startGeneration('build a todo app');
    expect(store.getState().generating).toBe(false);
  });

  it('startGeneration rejects if already generating', async () => {
    const first = store.getState().startGeneration('task 1');
    await store.getState().startGeneration('task 2');
    await first;
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('startGeneration cleans up the task (no stuck "generating") if assignment resolution throws', async () => {
    vi.mocked(getProjectAssignment).mockRejectedValueOnce(new Error('no model template available'));
    await store.getState().startGeneration('build a todo app');
    // The pre-created task must be removed and generating reset — not orphaned.
    expect(store.getState().generating).toBe(false);
    expect(store.getState().generationTasks.size).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled(); // never instantiated the orchestrator
  });

  it('startGeneration resolves a custom interview template and passes it to the orchestrator', async () => {
    const custom = {
      id: 'custom-x', title: 'Custom X', description: 'd',
      artifacts: [{ path: '/.interviews/custom-x.md' }], items: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(interviewTemplatesService.getTemplate).mockResolvedValue(custom as any);

    await store.getState().startGeneration('start', undefined, { projectId: 'p1', mode: 'interview', templateId: 'custom-x' });

    expect(interviewTemplatesService.getTemplate).toHaveBeenCalledWith('custom-x');
    expect(vi.mocked(MultiAgentOrchestrator)).toHaveBeenCalledWith(
      'p1',
      'interview',
      expect.any(Function),
      expect.objectContaining({ interviewTemplateId: 'custom-x', interviewTemplate: custom }),
    );
  });

  it('stopGeneration calls stop on orchestrator and sets generating=false', async () => {
    // startGeneration now awaits getProjectAssignment before instantiating the orchestrator,
    // so we must flush the microtask queue before stopGeneration can reach the instance.
    const promise = store.getState().startGeneration('task');
    await Promise.resolve(); // flush: assignment resolves + orchestrator is stored
    store.getState().stopGeneration();
    expect(mockStop).toHaveBeenCalled();
    // After stop, the task transitions to result: 'failed', so generating becomes false
    expect(store.getState().generating).toBe(false);
    await promise;
  });

  it('stopGeneration tracks task_fail with duration_ms and task_id', async () => {
    const projectId = store.getState().projectId || '';
    const promise = store.getState().startGeneration('task');
    await Promise.resolve(); // flush: assignment resolves + orchestrator is stored

    const task = store.getState().generationTasks.get(projectId);
    expect(task?.startedAt).toEqual(expect.any(Number));

    store.getState().stopGeneration();

    const failCalls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'task_fail');
    expect(failCalls).toHaveLength(1);
    const payload = failCalls[0][1];
    expect(payload.reason).toBe('stopped');
    expect(payload.task_id).toBe(projectId);
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);

    await promise;
  });

  it('resetOrchestrator clears instances when not generating', () => {
    // Set up a completed task with a fake persistedInstance
    const projectId = store.getState().projectId || '';
    setActiveTask(store, projectId, {
      result: 'completed',
      persistedInstance: { fake: true } as any,
    });
    store.setState({ generating: false });

    store.getState().resetOrchestrator();

    const task = store.getState().generationTasks.get(projectId);
    expect(task?.persistedInstance).toBeNull();
    expect(task?.orchestratorInstance).toBeNull();
  });

  it('resetOrchestrator is a no-op when generating', () => {
    const projectId = store.getState().projectId || '';
    setActiveTask(store, projectId, {
      persistedInstance: { fake: true } as any,
    });

    store.getState().resetOrchestrator();

    const task = store.getState().generationTasks.get(projectId);
    expect(task?.persistedInstance).not.toBeNull();
  });

  it('dispatches generationStateChanged window events', async () => {
    const dispatched: CustomEvent[] = [];
    vi.stubGlobal('dispatchEvent', (e: Event) => { dispatched.push(e as CustomEvent); return true; });

    await store.getState().startGeneration('task');

    const generationEvents = dispatched
      .filter(e => e.type === 'generationStateChanged')
      .map(e => e.detail);

    // Should have both a true and a false event
    expect(generationEvents.some(d => d.generating === true)).toBe(true);
    expect(generationEvents.some(d => d.generating === false)).toBe(true);
    // Events include projectId
    expect(generationEvents.every(d => 'projectId' in d)).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe('orchestrator slice — concurrent generation', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
  });

  it('isProjectGenerating returns true only for active tasks', () => {
    setActiveTask(store, 'proj-a');
    setActiveTask(store, 'proj-b', { result: 'completed' });

    expect(store.getState().isProjectGenerating('proj-a')).toBe(true);
    expect(store.getState().isProjectGenerating('proj-b')).toBe(false);
    expect(store.getState().isProjectGenerating('proj-c')).toBe(false);
  });

  it('isAnyGenerating returns true when at least one task is active', () => {
    expect(store.getState().isAnyGenerating()).toBe(false);

    setActiveTask(store, 'proj-a');
    expect(store.getState().isAnyGenerating()).toBe(true);

    // Mark it as completed
    const tasks = new Map(store.getState().generationTasks);
    const task = tasks.get('proj-a')!;
    tasks.set('proj-a', { ...task, result: 'completed' });
    store.setState({ generationTasks: tasks });

    expect(store.getState().isAnyGenerating()).toBe(false);
  });

  it('stopGeneration(projectId) only stops that project', () => {
    const fakeOrch = { stop: vi.fn() } as any;
    setActiveTask(store, 'proj-a', { orchestratorInstance: fakeOrch });
    setActiveTask(store, 'proj-b');

    store.getState().stopGeneration('proj-a');

    expect(fakeOrch.stop).toHaveBeenCalled();
    const taskA = store.getState().generationTasks.get('proj-a');
    expect(taskA?.result).toBe('failed');
    // proj-b should still be active
    expect(store.getState().isProjectGenerating('proj-b')).toBe(true);
  });

  it('dismissGenerationResult removes only that project task', () => {
    setActiveTask(store, 'proj-a', { result: 'completed' });
    setActiveTask(store, 'proj-b', { result: 'failed' });

    store.getState().dismissGenerationResult('proj-a');

    expect(store.getState().generationTasks.has('proj-a')).toBe(false);
    expect(store.getState().generationTasks.has('proj-b')).toBe(true);
  });

  it('dismissGenerationResult is a no-op for active tasks', () => {
    setActiveTask(store, 'proj-a'); // result: null (active)

    store.getState().dismissGenerationResult('proj-a');

    expect(store.getState().generationTasks.has('proj-a')).toBe(true);
  });

  it('loadDebugEvents clears a completed background task for the viewed project', async () => {
    setActiveTask(store, 'proj-a', { result: 'completed' });
    setActiveTask(store, 'proj-b', { result: 'completed' });

    await store.getState().loadDebugEvents('proj-a');

    // Viewing proj-a implicitly dismisses its terminal task; proj-b is untouched.
    expect(store.getState().generationTasks.has('proj-a')).toBe(false);
    expect(store.getState().generationTasks.has('proj-b')).toBe(true);
  });

  it('loadDebugEvents keeps a still-running task for the viewed project', async () => {
    setActiveTask(store, 'proj-a'); // result: null (still generating)

    await store.getState().loadDebugEvents('proj-a');

    expect(store.getState().generationTasks.has('proj-a')).toBe(true);
  });
});
