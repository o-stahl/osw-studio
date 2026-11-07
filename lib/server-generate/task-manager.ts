import { randomUUID } from 'node:crypto';
import type { PersistedServerTask, ServerTask } from './types';

interface TaskManagerOptions {
  maxConcurrentPerScope: number;
  keyTTLMs: number;
}

export interface TaskPersistence {
  initialize(): Promise<PersistedServerTask[]>;
  save(task: ServerTask): Promise<void>;
  /** Terminal tasks a client can still reattach to, even after the in-memory copy is swept. */
  getBySession?(sessionId: string): Promise<PersistedServerTask[]>;
  getById?(taskId: string): Promise<PersistedServerTask | null>;
  /** Delete terminal rows whose updatedAt is older than the cutoff. */
  prune?(olderThan: number): Promise<void>;
}

/** The project already has a task running, paused or stopping, so a second one is refused. */
export class ProjectBusyError extends Error {
  constructor(readonly activeTaskId: string) {
    super('A task is already running for this project.');
    this.name = 'ProjectBusyError';
  }
}

/** Strip the live-only fields so an in-memory task can be compared/merged with durable rows. */
function toPersisted(task: ServerTask): PersistedServerTask {
  const { orchestrator: _o, pendingBuildResolve: _p, ...persisted } = task;
  return persisted;
}

export class TaskManager {
  private tasks = new Map<string, ServerTask>();
  private apiKeys = new Map<string, { key: string; createdAt: number }>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private initializePromise: Promise<void> | null = null;

  constructor(
    private readonly options: TaskManagerOptions,
    private readonly persistence?: TaskPersistence,
  ) {
    this.sweepInterval = setInterval(() => this.sweepExpiredKeys(), 60_000);
  }

  /** Hydrate terminal tasks and recover pre-restart in-flight tasks as failures. */
  async initialize(): Promise<void> {
    if (!this.persistence) return;
    if (!this.initializePromise) {
      this.initializePromise = this.persistence.initialize().then((persistedTasks) => {
        for (const persisted of persistedTasks) {
          this.tasks.set(persisted.taskId, {
            ...persisted,
            orchestrator: null,
            pendingBuildResolve: null,
          });
        }
      });
    }
    await this.initializePromise;
  }

  createTask(projectId: string, sessionId: string, apiKey: string, workspaceId?: string): string {
    const scope = workspaceId ?? sessionId;
    const inScope = [...this.tasks.values()].filter((t) => (t.workspaceId ?? t.sessionId) === scope);

    // One task per project. A second would write the same files as the first, and the tab that
    // started it could stop only one of the two.
    const onProject = inScope.find((t) => t.projectId === projectId
      && (t.status === 'running' || t.status === 'paused' || t.status === 'stopping'));
    if (onProject) throw new ProjectBusyError(onProject.taskId);

    const activeTasks = inScope.filter((t) => t.status === 'running' || t.status === 'paused');

    if (activeTasks.length >= this.options.maxConcurrentPerScope) {
      throw new Error(`Concurrent task limit (${this.options.maxConcurrentPerScope}) reached`);
    }

    const taskId = randomUUID();
    const now = Date.now();
    const task: ServerTask = {
      taskId,
      projectId,
      sessionId,
      workspaceId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
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

  async updateTask(task: ServerTask): Promise<void> {
    task.updatedAt = Date.now();
    await this.persistence?.save(task);
  }

  async completeTask(taskId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
      task.orchestrator = null;
    }
    this.apiKeys.delete(taskId);
    if (task) await this.updateTask(task);
  }

  getTasksForSession(sessionId: string): ServerTask[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  /**
   * Status of a single task for reattach/polling: prefer the live in-memory copy, then fall back to
   * the durable store (a terminal task swept from memory is still reattachable until its row expires).
   */
  async getReattachTask(taskId: string): Promise<ServerTask | PersistedServerTask | undefined> {
    return this.tasks.get(taskId) ?? (await this.persistence?.getById?.(taskId)) ?? undefined;
  }

  /**
   * All of a session's tasks for reattach: the union of live in-memory tasks and durable rows, with
   * the in-memory copy winning per taskId (it carries the freshest running/paused status).
   */
  async getReattachTasks(sessionId: string): Promise<PersistedServerTask[]> {
    const byId = new Map<string, PersistedServerTask>();
    for (const t of (await this.persistence?.getBySession?.(sessionId)) ?? []) {
      byId.set(t.taskId, t);
    }
    for (const t of this.getTasksForSession(sessionId)) {
      byId.set(t.taskId, toPersisted(t));
    }
    return [...byId.values()];
  }

  sweepExpiredKeys(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.apiKeys) {
      if (now - entry.createdAt > this.options.keyTTLMs) {
        this.apiKeys.delete(taskId);
      }
    }
    // Retire terminal tasks from memory and the durable store together, on the same terminal
    // updatedAt clock, so a completed task never appears "missing" to a reattaching client before
    // it has genuinely expired. Running/paused/stopping tasks are never pruned.
    const cutoff = now - this.options.keyTTLMs;
    for (const [taskId, task] of this.tasks) {
      const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
      if (terminal && task.updatedAt < cutoff) {
        this.tasks.delete(taskId);
      }
    }
    void this.persistence?.prune?.(cutoff);
  }

  dispose(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }
}
