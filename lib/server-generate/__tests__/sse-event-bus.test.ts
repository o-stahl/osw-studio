// lib/server-generate/__tests__/sse-event-bus.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SSEEventBus } from '../sse-event-bus';

describe('SSEEventBus', () => {
  let bus: SSEEventBus;

  beforeEach(() => {
    bus = new SSEEventBus({ maxBufferSize: 10 });
  });

  describe('event emission', () => {
    it('assigns monotonic IDs to events', () => {
      bus.emit('task-1', 'proj-1', 'test', { x: 1 });
      bus.emit('task-1', 'proj-1', 'test', { x: 2 });
      const buffer = bus.getBuffer('task-1');
      expect(buffer[0].id).toBe(1);
      expect(buffer[1].id).toBe(2);
    });

    it('tags events with sourceProjectId', () => {
      bus.emit('task-1', 'proj-1', 'test', { x: 1 });
      const buffer = bus.getBuffer('task-1');
      expect(buffer[0].data.sourceProjectId).toBe('proj-1');
    });
  });

  describe('ring buffer', () => {
    it('buffers non-delta events', () => {
      bus.emit('task-1', 'proj-1', 'tool_status', { status: 'running' });
      bus.emit('task-1', 'proj-1', 'conversation_message', { msg: 'hi' });
      expect(bus.getBuffer('task-1')).toHaveLength(2);
    });

    it('does NOT buffer delta events', () => {
      bus.emit('task-1', 'proj-1', 'assistant_delta', { text: 'a' });
      bus.emit('task-1', 'proj-1', 'tool_param_delta', { chunk: 'b' });
      bus.emit('task-1', 'proj-1', 'reasoning_delta', { text: 'c' });
      expect(bus.getBuffer('task-1')).toHaveLength(0);
    });

    it('evicts oldest events when buffer exceeds maxBufferSize', () => {
      for (let i = 0; i < 15; i++) {
        bus.emit('task-1', 'proj-1', 'tool_status', { i });
      }
      const buffer = bus.getBuffer('task-1');
      expect(buffer).toHaveLength(10);
      expect(buffer[0].data.i).toBe(5);
    });
  });

  describe('replay', () => {
    it('replays all events when lastEventId is 0', () => {
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 1 });
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 2 });
      const replayed = bus.replayFrom('task-1', 0);
      expect(replayed).toHaveLength(2);
    });

    it('replays events after lastEventId', () => {
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 1 });
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 2 });
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 3 });
      const replayed = bus.replayFrom('task-1', 1);
      expect(replayed).toHaveLength(2);
      expect(replayed![0].data.x).toBe(2);
    });

    it('returns null when lastEventId is too old (gap)', () => {
      for (let i = 0; i < 15; i++) {
        bus.emit('task-1', 'proj-1', 'tool_status', { i });
      }
      expect(bus.replayFrom('task-1', 1)).toBeNull();
    });

    it('returns empty array when lastEventId is current', () => {
      bus.emit('task-1', 'proj-1', 'tool_status', { x: 1 });
      const replayed = bus.replayFrom('task-1', 1);
      expect(replayed).toEqual([]);
    });
  });

  describe('listeners', () => {
    it('notifies registered listeners on emit', () => {
      const received: Array<{ event: string; data: any }> = [];
      bus.addListener('sess-1', (event) => received.push(event));
      bus.emit('task-1', 'proj-1', 'test', { x: 1 }, 'sess-1');
      expect(received).toHaveLength(1);
      expect(received[0].event).toBe('test');
    });

    it('does not notify listeners for other sessions', () => {
      const received: Array<any> = [];
      bus.addListener('sess-1', (event) => received.push(event));
      bus.emit('task-1', 'proj-1', 'test', { x: 1 }, 'sess-2');
      expect(received).toHaveLength(0);
    });

    it('removeListener stops notifications', () => {
      const received: Array<any> = [];
      const listener = (event: any) => received.push(event);
      bus.addListener('sess-1', listener);
      bus.emit('task-1', 'proj-1', 'test', { x: 1 }, 'sess-1');
      bus.removeListener('sess-1', listener);
      bus.emit('task-1', 'proj-1', 'test', { x: 2 }, 'sess-1');
      expect(received).toHaveLength(1);
    });
  });

  describe('cleanup', () => {
    it('clearTask removes buffer for a task', () => {
      bus.emit('task-1', 'proj-1', 'test', { x: 1 });
      bus.clearTask('task-1');
      expect(bus.getBuffer('task-1')).toHaveLength(0);
    });
  });
});
