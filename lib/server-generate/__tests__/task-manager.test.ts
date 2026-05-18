import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskManager } from '../task-manager';

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

  it('getTasksForSession returns all tasks for a session', () => {
    tm.createTask('proj-1', 'sess-1', 'k1');
    tm.createTask('proj-2', 'sess-1', 'k2');
    tm.createTask('proj-3', 'sess-2', 'k3');
    expect(tm.getTasksForSession('sess-1')).toHaveLength(2);
    expect(tm.getTasksForSession('sess-2')).toHaveLength(1);
  });

  it('stores metadata (prompt, model, projectName) on task', () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-key');
    const task = tm.getTask(taskId)!;
    task.prompt = 'make a button';
    task.model = 'gpt-4o';
    task.projectName = 'My Project';

    const retrieved = tm.getTask(taskId)!;
    expect(retrieved.prompt).toBe('make a button');
    expect(retrieved.model).toBe('gpt-4o');
    expect(retrieved.projectName).toBe('My Project');
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
});
