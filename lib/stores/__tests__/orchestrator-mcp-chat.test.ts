import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';

setupOrchestratorMocks();

/**
 * The prompt an MCP client sent has to show up in the project's chat, and survive a reload.
 *
 * Both halves failed in a live run. The server's copy of the user message was merged into
 * whatever the last user message in the viewed conversation happened to be, so on a tab that was
 * not viewing the project the prompt vanished and the chat simply began generating. And nothing
 * was written to IndexedDB at all, because only projects opened in this tab are registered for
 * persistence, so a reload showed no trace of the run.
 */
describe('orchestrator slice — an MCP prompt in the chat', () => {
  let store: ReturnType<typeof createTestStore>;

  async function eventsInto(projectId: string, viewing: string) {
    store.setState({ projectId: viewing });
    store.getState().connectSSE();
    const { SSEClient } = await import('@/lib/server-generate/sse-client');
    const ctor = SSEClient as unknown as { mock: { calls: [{ onEvent: (e: string, d: unknown) => void }][] } };
    const { onEvent } = ctor.mock.calls[ctor.mock.calls.length - 1][0];
    return (data: Record<string, unknown>) => onEvent('conversation_message', { sourceProjectId: projectId, ...data });
  }

  /** What the server sends back for a user turn: full content, with the clean prompt for display. */
  const serverUserMessage = {
    message: {
      role: 'user',
      content: 'Current project structure: ...\n\nAdd an About section',
      ui_metadata: { displayContent: 'Add an About section', projectContext: { files: 3 } },
    },
  };

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it('shows the prompt when the run is for a project this tab is not viewing', async () => {
    // The viewed project already has a conversation, which is what the old dedup latched onto.
    store.setState({
      debugEvents: [{
        id: 'old', timestamp: 1, event: 'conversation_message', count: 1, version: 1,
        data: { message: { role: 'user', content: 'something else entirely' } },
      }] as never,
    });
    const send = await eventsInto('other-project', 'viewed-project');

    send(serverUserMessage);

    // The other project's conversation gets the message.
    const buffered = store.getState().getGenerationEvents('other-project');
    expect(buffered.map((e) => e.data?.message?.content)).toContain(serverUserMessage.message.content);

    // And the viewed conversation is untouched: the old dedup merged the server's metadata into
    // this unrelated message and dropped the event, which is the failure being pinned here.
    const viewed = store.getState().debugEvents;
    expect(viewed).toHaveLength(1);
    expect(viewed[0].data.message.content).toBe('something else entirely');
    expect(viewed[0].data.message.ui_metadata).toBeUndefined();
  });

  it('merges into the message this tab posted for this run, rather than an older one', async () => {
    store.setState({
      debugEvents: [
        {
          id: 'old', timestamp: 1, event: 'conversation_message', count: 1, version: 1,
          data: { message: { role: 'user', content: 'an earlier turn' } },
        },
        {
          id: 'pending', timestamp: 2, event: 'conversation_message', count: 1, version: 1,
          data: { message: { role: 'user', content: 'Add an About section', ui_metadata: { awaitingServerEcho: true } } },
        },
      ] as never,
    });
    const send = await eventsInto('viewed-project', 'viewed-project');

    send(serverUserMessage);

    const events = store.getState().debugEvents;
    expect(events).toHaveLength(2);
    const merged = events[1].data.message.ui_metadata;
    expect(merged.projectContext).toEqual({ files: 3 });
    // The echo has landed, so a later run's echo cannot merge into this message too.
    expect(merged.awaitingServerEcho).toBeUndefined();
    expect(events[0].data.message.content).toBe('an earlier turn');
  });

  // A reload replays the echo, and the stored chat has to recognise it as this message.
  it('records the echo\'s identity on the message it merged into', async () => {
    store.setState({
      debugEvents: [{
        id: 'pending', timestamp: 2, event: 'conversation_message', count: 1, version: 1,
        data: { message: { role: 'user', content: 'Add an About section', ui_metadata: { awaitingServerEcho: true } } },
      }] as never,
    });
    const send = await eventsInto('viewed-project', 'viewed-project');

    send({ ...serverUserMessage, sourceTaskId: 't1', sourceEventId: 7 });

    const [message] = store.getState().debugEvents;
    expect(message.data).toMatchObject({ sourceTaskId: 't1', sourceEventId: 7 });
    const { mergeChatEvents } = await import('../chat-merge');
    const replayed = { id: 'replay', timestamp: 3, event: 'conversation_message', count: 1, version: 1, data: { ...serverUserMessage, sourceTaskId: 't1', sourceEventId: 7 } };
    expect(mergeChatEvents([message], [replayed as never], 100)).toHaveLength(1);
  });

  it('clears the chat of the project named, not the one on screen', async () => {
    const viewed = [{
      id: 'a', timestamp: 1, event: 'conversation_message', count: 1, version: 1,
      data: { message: { role: 'user', content: 'my work' } },
    }];
    store.setState({ projectId: 'viewed-project', debugEvents: viewed as never });

    await store.getState().clearChat('other-project');

    expect(store.getState().debugEvents).toHaveLength(1);
  });

  it('clears the chat on screen when that is the project named', async () => {
    store.setState({
      projectId: 'viewed-project',
      debugEvents: [{ id: 'a', timestamp: 1, event: 'waiting', count: 1, version: 1, data: {} }] as never,
    });

    await store.getState().clearChat('viewed-project');

    expect(store.getState().debugEvents).toHaveLength(0);
  });
});
