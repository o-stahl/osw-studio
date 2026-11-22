import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

/**
 * A reload inside a project loads its chat, then the server replays the runs of the last half hour
 * to the new connection. Those events are already in the chat; added again, the chat showed every
 * recent prompt and its tool calls twice.
 */
describe('orchestrator slice: a replay into the open chat', () => {
  let store: ReturnType<typeof createTestStore>;

  async function events() {
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    const { onEvent } = ctor.mock.calls[ctor.mock.calls.length - 1][0];
    return (event: string, data: Record<string, unknown>) => onEvent(event, { sourceProjectId: 'p1', ...data });
  }

  const stored = (id: string, event: string, data: Record<string, unknown>) => ({ id, timestamp: 1, event, count: 1, version: 1, data });

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    store.setState({
      projectId: 'p1',
      debugEvents: [
        stored('a', 'conversation_message', { message: { role: 'user', content: 'Run 1' }, sourceTaskId: 't1', sourceEventId: 2 }),
        stored('b', 'iteration', { sourceTaskId: 't1', sourceEventId: 3 }),
        stored('c', 'conversation_message', { message: { role: 'assistant', content: 'Done' }, sourceTaskId: 't1', sourceEventId: 13 }),
        stored('d', 'task_complete', { sourceTaskId: 't1', sourceEventId: 27, result: 'completed' }),
      ] as never,
    });
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('adds nothing the chat already holds', async () => {
    const send = await events();

    send('conversation_message', { message: { role: 'user', content: 'Current project structure: ...\n\nRun 1' }, sourceTaskId: 't1', sourceEventId: 2 });
    send('iteration', { sourceTaskId: 't1', sourceEventId: 3 });
    send('conversation_message', { message: { role: 'assistant', content: 'Done' }, sourceTaskId: 't1', sourceEventId: 13 });
    send('task_complete', { sourceTaskId: 't1', sourceEventId: 27, result: 'completed' });

    expect(store.getState().debugEvents.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('still adds what is new: a later event of the same run, and another run', async () => {
    const send = await events();

    send('iteration', { sourceTaskId: 't1', sourceEventId: 28 });
    send('iteration', { sourceTaskId: 't2', sourceEventId: 3 });

    expect(store.getState().debugEvents).toHaveLength(6);
  });

  it('adds nothing a background project\'s buffer already holds', async () => {
    const send = await events();
    store.setState({ projectId: 'other' } as never);

    send('iteration', { sourceTaskId: 't9', sourceEventId: 4 });
    send('iteration', { sourceTaskId: 't9', sourceEventId: 4 });

    expect(store.getState().getGenerationEvents('p1').filter((e) => e.data?.sourceTaskId === 't9')).toHaveLength(1);
  });
});
