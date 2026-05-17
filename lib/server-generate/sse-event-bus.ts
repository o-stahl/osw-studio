// lib/server-generate/sse-event-bus.ts
import type { SSEEvent } from './types';

const DELTA_EVENTS = new Set(['assistant_delta', 'tool_param_delta', 'reasoning_delta']);

type SSEListener = (event: { id: number; event: string; data: Record<string, unknown> }) => void;

interface SSEEventBusOptions {
  maxBufferSize: number;
}

export class SSEEventBus {
  private buffers = new Map<string, SSEEvent[]>();
  private idCounter = 0;
  private listeners = new Map<string, Set<SSEListener>>();

  constructor(private readonly options: SSEEventBusOptions = { maxBufferSize: 500 }) {}

  emit(taskId: string, projectId: string, event: string, data: Record<string, unknown>, sessionId?: string): SSEEvent {
    const id = ++this.idCounter;
    const isDelta = DELTA_EVENTS.has(event);
    const sseEvent: SSEEvent = {
      id,
      event,
      data: { ...data, sourceProjectId: projectId },
      buffered: !isDelta,
    };

    if (!isDelta) {
      let buffer = this.buffers.get(taskId);
      if (!buffer) {
        buffer = [];
        this.buffers.set(taskId, buffer);
      }
      buffer.push(sseEvent);
      if (buffer.length > this.options.maxBufferSize) {
        buffer.splice(0, buffer.length - this.options.maxBufferSize);
      }
    }

    if (sessionId) {
      const sessionListeners = this.listeners.get(sessionId);
      if (sessionListeners) {
        for (const listener of sessionListeners) {
          listener({ id, event, data: sseEvent.data });
        }
      }
    }

    return sseEvent;
  }

  getBuffer(taskId: string): SSEEvent[] {
    return this.buffers.get(taskId) ?? [];
  }

  replayFrom(taskId: string, lastEventId: number): SSEEvent[] | null {
    const buffer = this.buffers.get(taskId) ?? [];
    if (buffer.length === 0) {
      return lastEventId === 0 ? [] : null;
    }

    const oldestBuffered = buffer[0].id;
    if (lastEventId > 0 && lastEventId < oldestBuffered) {
      return null;
    }

    return buffer.filter((e) => e.id > lastEventId);
  }

  addListener(sessionId: string, listener: SSEListener): void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
  }

  removeListener(sessionId: string, listener: SSEListener): void {
    this.listeners.get(sessionId)?.delete(listener);
  }

  clearTask(taskId: string): void {
    this.buffers.delete(taskId);
  }
}
