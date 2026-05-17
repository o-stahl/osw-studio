import { TaskManager } from './task-manager';
import { SSEEventBus } from './sse-event-bus';

export const taskManager = new TaskManager({
  maxConcurrentPerScope: 3,
  keyTTLMs: 30 * 60 * 1000, // 30 minutes
});

export const eventBus = new SSEEventBus({ maxBufferSize: 500 });
