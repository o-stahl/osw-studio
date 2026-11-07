import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectBusyError, TaskManager, type TaskPersistence } from '../task-manager';

describe('TaskManager', () => {
  let tm: TaskManager;

  beforeEach(() => {
    tm = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 });
  });

  afterEach(() => {
    tm.dispose();
  });

  it('creates a task and returns taskId', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-key', 'workspace-1');
    expect(taskId).toBeDefined();
    expect(typeof taskId).toBe('string');
  });

  it('retrieves a created task', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-key');
    const task = tm.getTask(taskId);
    expect(task).toBeDefined();
    expect(task!.projectId).toBe('proj-1');
    expect(task!.status).toBe('running');
  });

  it('returns undefined for unknown taskId', () => {
    expect(tm.getTask('nonexistent')).toBeUndefined();
  });

  it('stores and retrieves API key', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-secret');
    expect(tm.getApiKey(taskId)).toBe('sk-secret');
  });

  it('deletes API key on task completion', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-secret');
    tm.completeTask(taskId, 'completed');
    expect(tm.getApiKey(taskId)).toBeUndefined();
  });

  it('deletes API key on task failure', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-secret');
    tm.completeTask(taskId, 'failed');
    expect(tm.getApiKey(taskId)).toBeUndefined();
  });

  it('deletes API key on task cancellation', () => {
    const taskId = tm.createTask('proj-1', 'session-1', 'sk-secret');
    tm.completeTask(taskId, 'cancelled');
    expect(tm.getApiKey(taskId)).toBeUndefined();
  });

  it('enforces concurrent task limit per workspace', () => {
    tm.createTask('proj-1', 'session-1', 'k1', 'ws-1');
    tm.createTask('proj-2', 'session-1', 'k2', 'ws-1');
    tm.createTask('proj-3', 'session-1', 'k3', 'ws-1');
    expect(() => tm.createTask('proj-4', 'session-1', 'k4', 'ws-1')).toThrow(/concurrent task limit/i);
  });

  it('enforces concurrent task limit per session when no workspace', () => {
    tm.createTask('proj-1', 'sess-1', 'k1');
    tm.createTask('proj-2', 'sess-1', 'k2');
    tm.createTask('proj-3', 'sess-1', 'k3');
    expect(() => tm.createTask('proj-4', 'sess-1', 'k4')).toThrow(/concurrent task limit/i);
  });

  it('allows tasks from different scopes', () => {
    tm.createTask('proj-1', 'sess-1', 'k1', 'ws-1');
    tm.createTask('proj-2', 'sess-1', 'k2', 'ws-1');
    tm.createTask('proj-3', 'sess-1', 'k3', 'ws-1');
    const taskId = tm.createTask('proj-4', 'sess-1', 'k4', 'ws-2');
    expect(taskId).toBeDefined();
  });

  it('completed tasks free up slots', () => {
    const t1 = tm.createTask('proj-1', 'sess-1', 'k1', 'ws-1');
    tm.createTask('proj-2', 'sess-1', 'k2', 'ws-1');
    tm.createTask('proj-3', 'sess-1', 'k3', 'ws-1');
    tm.completeTask(t1, 'completed');
    const t4 = tm.createTask('proj-4', 'sess-1', 'k4', 'ws-1');
    expect(t4).toBeDefined();
  });

  it('refuses a second task on a project while one is running, paused or stopping', () => {
    // Two tasks on one project write the same files, and the tab that started the second could
    // stop only one of them.
    for (const status of ['running', 'paused', 'stopping'] as const) {
      const local = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 });
      const first = local.createTask('proj-1', 'session-1', 'sk', 'workspace-1');
      local.getTask(first)!.status = status;

      expect(() => local.createTask('proj-1', 'session-2', 'sk', 'workspace-1'), status).toThrow(ProjectBusyError);
      expect(local.createTask('proj-2', 'session-1', 'sk', 'workspace-1')).toBeDefined();
      local.dispose();
    }
  });

  it('takes a new task on a project once its last one has ended', async () => {
    const first = tm.createTask('proj-1', 'session-1', 'sk', 'workspace-1');
    await tm.completeTask(first, 'cancelled');

    expect(tm.createTask('proj-1', 'session-1', 'sk', 'workspace-1')).toBeDefined();
  });

  it('getTasksForSession returns all tasks for a session', () => {
    tm.createTask('proj-1', 'sess-1', 'k1');
    tm.createTask('proj-2', 'sess-1', 'k2');
    tm.createTask('proj-3', 'sess-2', 'k3');
    expect(tm.getTasksForSession('sess-1')).toHaveLength(2);
    expect(tm.getTasksForSession('sess-2')).toHaveLength(1);
  });

  it('TTL sweep removes expired keys', () => {
    vi.useFakeTimers();
    const shortTTL = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 1000 });
    const taskId = shortTTL.createTask('proj-1', 'sess-1', 'sk-expire');
    vi.advanceTimersByTime(1500);
    shortTTL.sweepExpiredKeys();
    expect(shortTTL.getApiKey(taskId)).toBeUndefined();
    shortTTL.dispose();
    vi.useRealTimers();
  });

  it('hydrates a restart-interrupted task as an explicit failure', async () => {
    const persistence: TaskPersistence = {
      initialize: vi.fn().mockResolvedValue([{
        taskId: 'interrupted-task',
        projectId: 'proj-1',
        sessionId: 'session-1',
        status: 'failed',
        startedAt: 1,
        updatedAt: 2,
        buildDeferred: false,
        failureReason: 'Server restarted before generation could finish',
      }]),
      save: vi.fn(),
    };
    const recovered = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 }, persistence);

    await recovered.initialize();

    expect(recovered.getTask('interrupted-task')).toMatchObject({
      status: 'failed',
      failureReason: 'Server restarted before generation could finish',
    });
    recovered.dispose();
  });

  it('recovers a completed task from the durable store after it is swept from memory', async () => {
    // Simulates reattach 30+ min later: the in-memory copy is gone, but the durable row remains.
    const durableCompleted = {
      taskId: 'done-task',
      projectId: 'proj-9',
      sessionId: 'session-1',
      status: 'completed' as const,
      startedAt: 1,
      updatedAt: 2,
      buildDeferred: false,
    };
    const persistence: TaskPersistence = {
      initialize: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      getBySession: vi.fn().mockResolvedValue([durableCompleted]),
      getById: vi.fn().mockResolvedValue(durableCompleted),
    };
    const tmp = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 }, persistence);

    // Not in memory — proving the recovery comes from the durable store.
    expect(tmp.getTask('done-task')).toBeUndefined();
    await expect(tmp.getReattachTasks('session-1')).resolves.toEqual([durableCompleted]);
    await expect(tmp.getReattachTask('done-task')).resolves.toMatchObject({ status: 'completed' });
    tmp.dispose();
  });

  it('reattach prefers the live in-memory task over a stale durable row', async () => {
    // The durable row for the SAME taskId is stale ('running'); the live task has since completed.
    let staleRow: Record<string, unknown> | null = null;
    const persistence: TaskPersistence = {
      initialize: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      getBySession: vi.fn().mockImplementation(async () => (staleRow ? [staleRow] : [])),
    };
    const tmp = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 }, persistence);
    const taskId = tmp.createTask('proj-1', 'session-1', 'sk-key');
    await tmp.completeTask(taskId, 'completed');
    staleRow = {
      taskId, projectId: 'proj-1', sessionId: 'session-1', status: 'running',
      startedAt: 1, updatedAt: 1, buildDeferred: false,
    };

    const reattached = await tmp.getReattachTasks('session-1');
    // Exactly one entry (deduped by taskId), reflecting the live terminal status.
    expect(reattached).toHaveLength(1);
    expect(reattached[0]).toMatchObject({ taskId, status: 'completed' });
    tmp.dispose();
  });

  it('persists terminal task status without persisting the API key', async () => {
    const persistence: TaskPersistence = {
      initialize: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
    };
    const persisted = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 }, persistence);
    const taskId = persisted.createTask('proj-1', 'session-1', 'sk-secret');
    const task = persisted.getTask(taskId)!;

    await persisted.completeTask(taskId, 'completed');

    expect(persistence.save).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('completed');
    expect(persisted.getApiKey(taskId)).toBeUndefined();
    persisted.dispose();
  });

  it('prunes terminal tasks from memory and the durable store on the same clock', async () => {
    const persistence: TaskPersistence = {
      initialize: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      prune: vi.fn().mockResolvedValue(undefined),
    };
    const tmp = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 }, persistence);
    const doneId = tmp.createTask('proj-1', 'session-1', 'sk-1');
    await tmp.completeTask(doneId, 'completed');
    const runningId = tmp.createTask('proj-2', 'session-1', 'sk-2');

    // Age the terminal task past the retention window; the running task stays current.
    tmp.getTask(doneId)!.updatedAt = 0;

    tmp.sweepExpiredKeys();

    expect(tmp.getTask(doneId)).toBeUndefined();        // terminal + expired → swept from memory
    expect(tmp.getTask(runningId)).toBeDefined();        // running → never pruned
    expect(persistence.prune).toHaveBeenCalledTimes(1);  // durable store pruned in the same pass
    tmp.dispose();
  });
});
