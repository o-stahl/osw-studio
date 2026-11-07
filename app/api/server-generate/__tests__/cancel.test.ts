import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { TaskManager } from '@/lib/server-generate/task-manager';

/**
 * Stop reaches every task still going on the project, not only the one the tab knows. One that was
 * left running beside it, before a start could be refused, otherwise went on writing with nothing
 * able to stop it.
 */

const state = vi.hoisted(() => ({ manager: null as unknown as TaskManager }));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: 'me', email: '', isAdmin: false, exp: 0 }) }));
vi.mock('@/lib/server-generate/singleton', async () => {
  const { TaskManager } = await import('@/lib/server-generate/task-manager');
  state.manager = new TaskManager({ maxConcurrentPerScope: 10, keyTTLMs: 60_000 });
  return { taskManager: state.manager, eventBus: { emit: vi.fn() } };
});

const cancel = async (body: Record<string, unknown>) => {
  const { POST } = await import('../cancel/route');
  const res = await POST({ json: async () => body } as unknown as NextRequest);
  return { status: res.status, body: await res.json() };
};

/** A task with a live loop, on a project, for an account. */
async function running(projectId: string, sessionId: string) {
  await import('../cancel/route');
  const taskId = state.manager.createTask(`tmp-${Math.random()}`, sessionId, 'k', 'ws');
  const task = state.manager.getTask(taskId)!;
  task.projectId = projectId;
  task.orchestrator = { stop: vi.fn() } as never;
  return task;
}

beforeEach(() => vi.clearAllMocks());

describe('Stop on a server task', () => {
  it('stops the task and any other of this account\'s still going on the project', async () => {
    const tracked = await running('p1', 'me');
    const leftOver = await running('p1', 'me');
    const elsewhere = await running('p2', 'me');
    const someoneElse = await running('p1', 'them');
    const loops = [tracked, leftOver, elsewhere, someoneElse].map((t) => (t.orchestrator as unknown as { stop: ReturnType<typeof vi.fn> }).stop);

    const res = await cancel({ taskId: tracked.taskId, projectId: 'p1' });

    expect(res).toEqual({ status: 200, body: { ok: true, hadOrchestrator: true } });
    expect(loops.map((stop) => stop.mock.calls.length)).toEqual([1, 1, 0, 0]);
    expect([tracked, leftOver, elsewhere, someoneElse].map((t) => t.status)).toEqual(['stopping', 'stopping', 'running', 'running']);
  });

  it('leaves a task whose runner is still setting it up to that runner, marked stopping', async () => {
    const { eventBus } = await import('@/lib/server-generate/singleton');
    const settingUp = await running('p4', 'me');
    settingUp.orchestrator = null;
    settingUp.runnerActive = true;

    const res = await cancel({ taskId: settingUp.taskId, projectId: 'p4' });

    expect(res.body).toEqual({ ok: true, hadOrchestrator: true });
    expect(settingUp.status).toBe('stopping');
    expect(vi.mocked(eventBus.emit)).not.toHaveBeenCalled();
    expect(() => state.manager.createTask('p4', 'me', 'k', 'ws')).toThrow();
  });

  it('stops what is left on the project when the task it names has already ended', async () => {
    const ended = await running('p3', 'me');
    await state.manager.completeTask(ended.taskId, 'completed');
    const leftOver = await running('p3', 'me');

    const res = await cancel({ taskId: ended.taskId, projectId: 'p3' });

    expect(res.body).toMatchObject({ ok: true, alreadyDone: true });
    expect(leftOver.status).toBe('stopping');
  });
});
