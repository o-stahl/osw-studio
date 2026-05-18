import { randomUUID } from 'node:crypto';
import type { ServerTask } from './types';

interface TaskManagerOptions {
  maxConcurrentPerScope: number;
  keyTTLMs: number;
}

export class TaskManager {
  private tasks = new Map<string, ServerTask>();
  private apiKeys = new Map<string, { key: string; createdAt: number }>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: TaskManagerOptions) {
    this.sweepInterval = setInterval(() => this.sweepExpiredKeys(), 60_000);
  }

  createTask(projectId: string, sessionId: string, apiKey: string, workspaceId?: string): string {
    const scope = workspaceId ?? sessionId;
    const activeTasks = [...this.tasks.values()].filter(
      (t) => (t.workspaceId ?? t.sessionId) === scope && (t.status === 'running' || t.status === 'paused'),
    );

    if (activeTasks.length >= this.options.maxConcurrentPerScope) {
      throw new Error(`Concurrent task limit (${this.options.maxConcurrentPerScope}) reached`);
    }

    const taskId = randomUUID();
    const task: ServerTask = {
      taskId,
      projectId,
      sessionId,
      workspaceId,
      status: 'running',
      startedAt: Date.now(),
      orchestrator: null,
      buildDeferred: false,
      pendingBuildResolve: null,
    };

    this.tasks.set(taskId, task);
    this.apiKeys.set(taskId, { key: apiKey, createdAt: Date.now() });
    return taskId;
  }

  getTask(taskId: string): ServerTask | undefined {
    return this.tasks.get(taskId);
  }

  getApiKey(taskId: string): string | undefined {
    return this.apiKeys.get(taskId)?.key;
  }

  completeTask(taskId: string, status: 'completed' | 'failed' | 'cancelled'): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
      task.orchestrator = null;
    }
    this.apiKeys.delete(taskId);
  }

  getTasksForSession(sessionId: string): ServerTask[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  sweepExpiredKeys(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.apiKeys) {
      if (now - entry.createdAt > this.options.keyTTLMs) {
        this.apiKeys.delete(taskId);
      }
    }
    for (const [taskId, task] of this.tasks) {
      if (task.status !== 'running' && task.status !== 'paused' && now - task.startedAt > this.options.keyTTLMs) {
        this.tasks.delete(taskId);
      }
    }
  }

  dispose(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }
}
