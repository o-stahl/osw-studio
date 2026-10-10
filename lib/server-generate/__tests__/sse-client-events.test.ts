// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEClient } from '../sse-client';

/**
 * The client subscribes to named event types, one `addEventListener` per name, so an event the
 * list does not carry is delivered by the server and dropped by the browser with no error
 * anywhere. Two MCP events were added to the server and to the store's handler, and arrived
 * nowhere until they were named here as well; the "Free models" notices are named for the same
 * reason.
 */

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Set<string>();
  onerror: ((e: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string) { this.listeners.add(type); }
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('SSEClient event subscriptions', () => {
  it('subscribes to the events an MCP client causes, or the tab never sees them', () => {
    new SSEClient({ onEvent: vi.fn() }).connect();

    const subscribed = FakeEventSource.last!.listeners;
    expect(subscribed.has('mcp_run_requested')).toBe(true);
    expect(subscribed.has('mcp_project_changed')).toBe(true);
  });

  it('still subscribes to the generation events it always did', () => {
    new SSEClient({ onEvent: vi.fn() }).connect();

    const subscribed = FakeEventSource.last!.listeners;
    for (const name of ['files_changed', 'build_requested', 'task_complete', 'conversation_message']) {
      expect(subscribed.has(name), name).toBe(true);
    }
  });

  it('subscribes to the events that say which model "Free models" is on, so a server run shows it too', () => {
    new SSEClient({ onEvent: vi.fn() }).connect();

    const subscribed = FakeEventSource.last!.listeners;
    for (const name of ['model_picked', 'model_switched', 'model_resolved']) {
      expect(subscribed.has(name), name).toBe(true);
    }
  });
});
