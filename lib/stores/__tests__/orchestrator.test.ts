import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import type { GenerationTask } from '../types';

vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({ MultiAgentOrchestrator: vi.fn() }));
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
    pausedMessage: null,
    orchestratorInstance: null,
    persistedInstance: null,
    ...overrides,
  });
  store.setState({ generationTasks: tasks, generating: true });
}

describe('orchestrator slice — initial state', () => {
  it('starts with generating=false and no generation tasks', () => {
    const store = createTestStore();
    const state = store.getState();
    expect(state.generating).toBe(false);
    expect(state.generationTasks.size).toBe(0);
    expect(state.debugEvents).toEqual([]);
    expect(state.currentModel).toBe('');
    expect(state.projectCost).toBe(0);
  });
});

describe('orchestrator slice — addDebugEvent', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('appends a new event with id, timestamp, count=1, version=1', () => {
    store.getState().addDebugEvent('test_event', { foo: 'bar' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('test_event');
    expect(events[0].data).toEqual({ foo: 'bar' });
    expect(events[0].count).toBe(1);
    expect(events[0].version).toBe(1);
    expect(events[0].id).toBeDefined();
    expect(events[0].timestamp).toBeDefined();
  });

  it('coalesces consecutive assistant_delta events', () => {
    store.getState().addDebugEvent('assistant_delta', { text: 'Hello' });
    store.getState().addDebugEvent('assistant_delta', { text: ' world' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(1);
    expect(events[0].version).toBe(2);
    expect(events[0].count).toBe(2);
    expect(events[0].data.all).toEqual([{ text: 'Hello' }, { text: ' world' }]);
  });

  it('accumulates data.all across 3+ coalesces', () => {
    store.getState().addDebugEvent('assistant_delta', { text: 'a' });
    store.getState().addDebugEvent('assistant_delta', { text: 'b' });
    store.getState().addDebugEvent('assistant_delta', { text: 'c' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(3);
    expect(events[0].version).toBe(3);
    expect(events[0].data.all).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  });

  it('coalesces tool_param_delta events', () => {
    store.getState().addDebugEvent('tool_param_delta', { chunk: 'a' });
    store.getState().addDebugEvent('tool_param_delta', { chunk: 'b' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(2);
  });

  it('coalesces reasoning_delta events', () => {
    store.getState().addDebugEvent('reasoning_delta', { text: 'r1' });
    store.getState().addDebugEvent('reasoning_delta', { text: 'r2' });
    expect(store.getState().debugEvents).toHaveLength(1);
  });

  it('does NOT coalesce different event types', () => {
    store.getState().addDebugEvent('assistant_delta', { text: 'Hello' });
    store.getState().addDebugEvent('tool_status', { status: 'running' });
    store.getState().addDebugEvent('assistant_delta', { text: ' world' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(2);
    const statusEvent = events.find(e => e.event === 'tool_status')!;
    expect(statusEvent).toBeDefined();
    const deltaEvent = events.find(e => e.event === 'assistant_delta')!;
    expect(deltaEvent.count).toBe(2);
  });

  it('coalesces with interleaved non-delta events within search window', () => {
    store.getState().addDebugEvent('assistant_delta', { text: 'a' });
    store.getState().addDebugEvent('toolCalls', { calls: [] });
    store.getState().addDebugEvent('assistant_delta', { text: 'b' });
    const events = store.getState().debugEvents;
    expect(events).toHaveLength(2);
    const deltaEvent = events.find(e => e.event === 'assistant_delta')!;
    expect(deltaEvent.count).toBe(2);
  });

  it('prunes events exceeding MAX_DEBUG_EVENTS', () => {
    for (let i = 0; i < 2010; i++) {
      store.getState().addDebugEvent('conversation_message', { i });
    }
    const len = store.getState().debugEvents.length;
    expect(len).toBeLessThanOrEqual(2000);
    expect(len).toBe(2000);
  });

  it('clearDebugEvents resets to empty array', () => {
    store.getState().addDebugEvent('test', { x: 1 });
    store.getState().clearDebugEvents();
    expect(store.getState().debugEvents).toEqual([]);
  });
});

describe('orchestrator slice — IndexedDB persistence', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounce-persists events to IndexedDB after 500ms', async () => {
    store.getState().initProject({ id: 'test-project-1', name: 'Test' });
    store.getState().initPersistence('test-project-1');
    store.getState().addDebugEvent('test', { x: 1 });

    expect(debugEventsState.saveEvents).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(debugEventsState.saveEvents).toHaveBeenCalledWith(
      'test-project-1',
      expect.any(Array),
    );
  });

  it('resets debounce timer on rapid events', () => {
    store.getState().initProject({ id: 'test-project-1', name: 'Test' });
    store.getState().initPersistence('test-project-1');
    store.getState().addDebugEvent('test', { x: 1 });
    vi.advanceTimersByTime(300);
    store.getState().addDebugEvent('test', { x: 2 });
    vi.advanceTimersByTime(300);
    expect(debugEventsState.saveEvents).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(debugEventsState.saveEvents).toHaveBeenCalledTimes(1);
  });
});

describe('orchestrator slice — background event routing', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    store.getState().initProject({ id: 'viewed-project', name: 'Viewed' });
  });

  it('addDebugEvent with matching sourceProjectId goes to foreground', () => {
    store.getState().addDebugEvent('test_event', { x: 1 }, 'viewed-project');
    expect(store.getState().debugEvents).toHaveLength(1);
    expect(store.getState().debugEvents[0].event).toBe('test_event');
  });

  it('addDebugEvent with different sourceProjectId does not appear in foreground', () => {
    store.getState().addDebugEvent('test_event', { x: 1 }, 'other-project');
    expect(store.getState().debugEvents).toHaveLength(0);
  });

  it('background events are persisted via debouncedSave', () => {
    vi.useFakeTimers();
    store.getState().initPersistence('other-project');
    store.getState().addDebugEvent('test_event', { x: 1 }, 'other-project');
    vi.advanceTimersByTime(500);
    expect(debugEventsState.saveEvents).toHaveBeenCalledWith(
      'other-project',
      expect.arrayContaining([expect.objectContaining({ event: 'test_event' })]),
    );
    vi.useRealTimers();
  });

  it('background events coalesce assistant_delta', () => {
    const bgProject = 'coalesce-test-project';
    store.getState().initPersistence(bgProject);
    store.getState().addDebugEvent('assistant_delta', { text: 'a' }, bgProject);
    store.getState().addDebugEvent('assistant_delta', { text: 'b' }, bgProject);
    const events = store.getState().getGenerationEvents(bgProject);
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(2);
  });
});

describe('orchestrator slice — stashForegroundEvents', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    store.getState().initProject({ id: 'proj-1', name: 'Project 1' });
  });

  it('copies foreground events to background buffer when project is generating', () => {
    setActiveTask(store, 'proj-1');
    store.getState().addDebugEvent('test', { x: 1 });
    store.getState().addDebugEvent('test', { x: 2 });
    expect(store.getState().debugEvents).toHaveLength(2);

    store.getState().stashForegroundEvents('proj-1');

    // Events are now in background buffer, retrievable via getGenerationEvents
    const buffered = store.getState().getGenerationEvents('proj-1');
    expect(buffered).toHaveLength(2);
  });

  it('is a no-op when project is not generating', () => {
    store.getState().addDebugEvent('test', { x: 1 });
    store.getState().stashForegroundEvents('proj-1');

    // No buffer created for non-generating project
    const buffered = store.getState().getGenerationEvents('proj-1');
    // Should fall through to foreground events (still in debugEvents)
    expect(buffered).toHaveLength(1);
  });

  it('is a no-op when debugEvents is empty', () => {
    setActiveTask(store, 'proj-1');
    store.getState().stashForegroundEvents('proj-1');
    const buffered = store.getState().getGenerationEvents('proj-1');
    expect(buffered).toHaveLength(0);
  });
});

describe('orchestrator slice — loadDebugEvents', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
  });

  it('restores events from background buffer for a generating project', async () => {
    const bgId = 'load-bg-test';
    store.getState().initProject({ id: bgId, name: 'BG' });
    setActiveTask(store, bgId);
    // Switch to another project first so events route to background
    store.getState().initProject({ id: 'proj-other', name: 'Other' });
    store.getState().clearDebugEvents();
    // Now add event with sourceProjectId — it routes to background buffer
    store.getState().addDebugEvent('bg_event', { x: 1 }, bgId);
    expect(store.getState().debugEvents).toHaveLength(0);

    // Load events for the generating project (simulating navigation back)
    await store.getState().loadDebugEvents(bgId);
    expect(store.getState().debugEvents).toHaveLength(1);
    expect(store.getState().debugEvents[0].event).toBe('bg_event');
  });

  it('loads from IndexedDB for a non-generating project', async () => {
    vi.mocked(debugEventsState.loadEvents).mockResolvedValueOnce([
      { id: '1', timestamp: 1000, event: 'saved_event', data: {}, count: 1, version: 1 } as any,
    ]);

    store.getState().initProject({ id: 'proj-1', name: 'P1' });
    await store.getState().loadDebugEvents('proj-1');

    expect(debugEventsState.loadEvents).toHaveBeenCalledWith('proj-1');
    expect(store.getState().debugEvents).toHaveLength(1);
    expect(store.getState().debugEvents[0].event).toBe('saved_event');
  });

  it('sets empty array when IndexedDB has no events', async () => {
    vi.mocked(debugEventsState.loadEvents).mockResolvedValueOnce([]);
    store.getState().initProject({ id: 'proj-1', name: 'P1' });
    // Put something in foreground first
    store.getState().addDebugEvent('leftover', {});

    await store.getState().loadDebugEvents('proj-1');
    expect(store.getState().debugEvents).toEqual([]);
  });

  it('derives generating scalar for the loaded project', async () => {
    store.getState().initProject({ id: 'proj-1', name: 'P1' });
    setActiveTask(store, 'proj-1');
    // Switch away — generating stays true from setState, but loadDebugEvents re-derives it
    store.getState().initProject({ id: 'proj-2', name: 'P2' });

    // loadDebugEvents for proj-2 (no task) should derive generating=false
    await store.getState().loadDebugEvents('proj-2');
    expect(store.getState().generating).toBe(false);

    // loadDebugEvents for proj-1 (active task) should derive generating=true
    await store.getState().loadDebugEvents('proj-1');
    expect(store.getState().generating).toBe(true);
  });
});

describe('orchestrator slice — projectContext merge via version bump', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    store.getState().initProject({ id: 'proj-1', name: 'P1' });
  });

  it('merging projectContext bumps version on the user message event', () => {
    store.getState().addDebugEvent('conversation_message', {
      message: { role: 'user', content: 'hello', ui_metadata: { displayContent: 'hello' } },
    }, 'proj-1');

    const before = store.getState().debugEvents;
    expect(before).toHaveLength(1);
    expect(before[0].version).toBe(1);

    // Simulate the SSE handler merge
    const idx = before.findLastIndex(
      (e) => e.event === 'conversation_message' && e.data?.message?.role === 'user'
    );
    store.setState((state) => {
      const events = [...state.debugEvents];
      const existing = { ...events[idx] };
      existing.data = {
        ...existing.data,
        message: {
          ...existing.data.message,
          ui_metadata: { ...existing.data.message?.ui_metadata, projectContext: 'file tree here' },
        },
      };
      existing.version = (existing.version ?? 1) + 1;
      events[idx] = existing;
      return { debugEvents: events };
    });

    const after = store.getState().debugEvents;
    expect(after[0].version).toBe(2);
    expect(after[0].data.message.ui_metadata.projectContext).toBe('file tree here');
    expect(after[0].data.message.ui_metadata.displayContent).toBe('hello');
  });

  it('findLastIndex targets the most recent user message in multi-turn chat', () => {
    store.getState().addDebugEvent('conversation_message', {
      message: { role: 'user', content: 'first msg' },
    }, 'proj-1');
    store.getState().addDebugEvent('conversation_message', {
      message: { role: 'assistant', content: 'reply' },
    }, 'proj-1');
    store.getState().addDebugEvent('conversation_message', {
      message: { role: 'user', content: 'second msg' },
    }, 'proj-1');

    const events = store.getState().debugEvents;
    const lastUserIdx = events.findLastIndex(
      (e) => e.event === 'conversation_message' && e.data?.message?.role === 'user'
    );
    expect(lastUserIdx).toBe(2);
    expect(events[lastUserIdx].data.message.content).toBe('second msg');
  });
});
