import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { debugEventsState } from '@/lib/llm/debug-events-state';
import type { DebugEvent } from '../types';

const mockExecute = vi.fn();
vi.mock('@/lib/llm/multi-agent-orchestrator', () => ({
  MultiAgentOrchestrator: vi.fn().mockImplementation(() => ({ execute: mockExecute, stop: vi.fn(), importConversation: vi.fn() })),
}));

setupOrchestratorMocks();

/**
 * Events for a project that is not on screen are only what arrived since: after a reload, that is
 * whatever the server still has buffered for its recent runs. The stored chat is the record, so
 * none of these paths may write less than it holds.
 */

const stored = (id: string, event: string, data: Record<string, unknown>): DebugEvent =>
  ({ id, timestamp: 1, event, data, count: 1, version: 1 });

let nextProject = 0;

const OLD_RUN = stored('old-1', 'conversation_message', { message: { role: 'assistant', content: 'from the first run' } });
const SEEN = { message: { role: 'assistant', content: 'second run' }, sourceProjectId: 'p1', sourceTaskId: 't2' };
const USER = { message: { role: 'user', content: 'do the thing' }, sourceProjectId: 'p1', sourceTaskId: 't2' };
const NEW = { message: { role: 'assistant', content: 'finished while away' }, sourceProjectId: 'p1', sourceTaskId: 't2' };

describe('a project\'s stored chat', () => {
  let store: ReturnType<typeof createTestStore>;
  let disk: Map<string, DebugEvent[]>;
  let p1: string;
  const contents = (events: DebugEvent[]) => events.map(e => e.data?.message?.content ?? e.event);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    store = createTestStore();
    p1 = `chat-${++nextProject}`;
    disk = new Map([[p1, [
      OLD_RUN,
      stored('local-user', 'conversation_message', { message: { role: 'user', content: 'do the thing', ui_metadata: { displayContent: 'do the thing' } } }),
      stored('seen-1', 'conversation_message', SEEN),
    ]]]);
    vi.mocked(debugEventsState.loadEvents).mockImplementation(async (id: string) => [...(disk.get(id) ?? [])] as never);
    vi.mocked(debugEventsState.saveEvents).mockImplementation(async (id: string, events: unknown[]) => { disk.set(id, [...events] as DebugEvent[]); });
    vi.mocked(debugEventsState.clearEvents).mockImplementation(async (id: string) => { disk.delete(id); });
    store.setState({ projectId: 'elsewhere', debugEvents: [] });
  });

  afterEach(() => { vi.useRealTimers(); });

  const replay = () => {
    store.getState().addDebugEvent('conversation_message', USER, p1);
    store.getState().addDebugEvent('conversation_message', SEEN, p1);
    store.getState().addDebugEvent('conversation_message', NEW, p1);
  };

  it('survives opening the project after a replay, gaining only what it lacked', async () => {
    replay();
    store.setState({ projectId: p1 });
    await store.getState().loadDebugEvents(p1);
    await vi.runAllTimersAsync();

    const expected = ['from the first run', 'do the thing', 'second run', 'finished while away'];
    expect(contents(store.getState().debugEvents)).toEqual(expected);
    expect(contents(disk.get(p1)!)).toEqual(expected);
  });

  it('survives a background save before the project is opened', async () => {
    store.getState().initPersistence(p1);
    store.setState({ projectId: 'elsewhere' });
    replay();
    await vi.advanceTimersByTimeAsync(600);
    store.getState().addDebugEvent('iteration', { n: 1, sourceTaskId: 't2' }, p1);
    await vi.advanceTimersByTimeAsync(600);

    expect(contents(disk.get(p1)!)).toEqual(['from the first run', 'do the thing', 'second run', 'finished while away', 'iteration']);
  });

  it('survives a replay into the open project before its chat has loaded', async () => {
    store.getState().initPersistence(p1);
    store.setState({ projectId: p1 });
    replay();
    await vi.advanceTimersByTimeAsync(600);

    expect(contents(disk.get(p1)!)).toEqual(['from the first run', 'do the thing', 'second run', 'finished while away']);
  });

  it('shows the stored chat under a run already going when the project opens', async () => {
    store.setState({
      projectId: p1,
      debugEvents: [stored('live', 'conversation_message', NEW)],
      generationTasks: new Map([[p1, { projectId: p1, projectName: '', prompt: '', model: '', startedAt: 1, result: null, paused: false, orchestratorInstance: null, persistedInstance: null, serverTaskId: 't2' }]]),
    });
    await store.getState().loadDebugEvents(p1);

    expect(contents(store.getState().debugEvents)).toEqual(['from the first run', 'do the thing', 'second run', 'finished while away']);
  });

  it('is written whole once loaded, so a deliberate clear stays cleared', async () => {
    store.setState({ projectId: p1 });
    store.getState().initPersistence(p1);
    await store.getState().loadDebugEvents(p1);
    await store.getState().clearChat(p1);
    store.getState().addDebugEvent('iteration', { n: 1 }, p1);
    await vi.advanceTimersByTimeAsync(600);

    expect(disk.get(p1)!.map(e => e.event)).toEqual(['iteration']);
  });

  it('stays cleared when a save was still waiting to be written', async () => {
    store.setState({ projectId: p1 });
    store.getState().initPersistence(p1);
    await store.getState().loadDebugEvents(p1);
    store.getState().addDebugEvent('iteration', { n: 1 }, p1);
    await store.getState().clearChat(p1);
    await vi.advanceTimersByTimeAsync(600);

    expect(disk.get(p1)).toBeUndefined();
  });

  it('stays cleared when a write was already under way', async () => {
    store.setState({ projectId: p1 });
    store.getState().initPersistence(p1);
    await store.getState().loadDebugEvents(p1);
    let release!: () => void;
    vi.mocked(debugEventsState.saveEvents).mockImplementationOnce(async (id: string, events: unknown[]) => {
      await new Promise<void>(resolve => { release = resolve; });
      disk.set(id, [...events] as DebugEvent[]);
    });
    store.getState().addDebugEvent('iteration', { n: 1 }, p1);
    await vi.advanceTimersByTimeAsync(600);

    const clearing = store.getState().clearChat(p1);
    release();
    await clearing;

    expect(disk.get(p1)).toBeUndefined();
  });

  it('keeps the chat on screen out of a project whose run ends while another is open', async () => {
    let finish!: (value: unknown) => void;
    mockExecute.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    store.setState({ projectId: p1 });
    store.getState().initPersistence(p1);
    await store.getState().loadDebugEvents(p1);
    const run = store.getState().startGeneration('build it', undefined, { projectId: p1 });
    await vi.waitFor(() => expect(mockExecute).toHaveBeenCalled());

    store.setState({ projectId: 'other', debugEvents: [stored('o1', 'conversation_message', { message: { role: 'user', content: 'another project' } })] });
    finish({ success: true, summary: 'done', totalCost: 0, toolCount: 0, turnCount: 0, apiErrorCount: 0 });
    await run;
    await vi.runAllTimersAsync();

    expect(contents(disk.get(p1)!)).not.toContain('another project');
  });

  it('shows one copy when two opens race over the same replay', async () => {
    replay();
    store.setState({ projectId: p1 });
    await Promise.all([store.getState().loadDebugEvents(p1), store.getState().loadDebugEvents(p1)]);

    expect(contents(store.getState().debugEvents)).toEqual(['from the first run', 'do the thing', 'second run', 'finished while away']);
  });
});
