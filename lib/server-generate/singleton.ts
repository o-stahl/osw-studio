import { TaskManager } from './task-manager';
import { SSEEventBus } from './sse-event-bus';

const g = globalThis as unknown as {
  __serverGenTaskManager?: TaskManager;
  __serverGenEventBus?: SSEEventBus;
};

if (!g.__serverGenTaskManager) {
  g.__serverGenTaskManager = new TaskManager({
    maxConcurrentPerScope: 3,
    keyTTLMs: 30 * 60 * 1000,
  });
}
if (!g.__serverGenEventBus) {
  g.__serverGenEventBus = new SSEEventBus({ maxBufferSize: 500 });
}

export const taskManager = g.__serverGenTaskManager;
export const eventBus = g.__serverGenEventBus;
