import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSEClient } from '../sse-client';

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  listenedTypes: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockEventSource.lastInstance = this;
  }

  addEventListener(type: string) {
    this.listenedTypes.push(type);
  }

  close() {}
}

describe('SSEClient event subscriptions', () => {
  beforeEach(() => {
    MockEventSource.lastInstance = null;
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });
  });

  it('subscribes to all events the chat panel and conversation rebuild depend on', () => {
    const client = new SSEClient({ onEvent: vi.fn() });
    client.connect();

    const types = MockEventSource.lastInstance!.listenedTypes;
    // Conversation persistence — compaction rewrites arrive via this event
    expect(types).toContain('conversation_replaced');
    expect(types).toContain('conversation_message');
    // Core lifecycle events
    expect(types).toContain('task_complete');
    expect(types).toContain('tool_status');
    expect(types).toContain('api_stopped');
    expect(types).toContain('compaction');

    client.disconnect();
  });
});
