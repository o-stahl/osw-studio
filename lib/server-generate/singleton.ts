import { TaskManager, TASK_RETENTION_MS } from './task-manager';
import { SSEEventBus } from './sse-event-bus';
import { serverTaskStore } from './task-store';

const g = globalThis as unknown as {
  __serverGenTaskManager?: TaskManager;
  __serverGenEventBus?: SSEEventBus;
};

if (!g.__serverGenEventBus) {
  g.__serverGenEventBus = new SSEEventBus({ maxBufferSize: 500 });
}
if (!g.__serverGenTaskManager) {
  const bus = g.__serverGenEventBus;
  g.__serverGenTaskManager = new TaskManager({
    maxConcurrentPerScope: 3,
    keyTTLMs: 30 * 60 * 1000,
    taskRetentionMs: TASK_RETENTION_MS,
    onTaskPruned: (taskId) => bus.clearTask(taskId),
  }, serverTaskStore);
}

export const taskManager = g.__serverGenTaskManager;
export const eventBus = g.__serverGenEventBus;
