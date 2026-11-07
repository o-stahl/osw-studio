import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * One server task per project. A second start on a project that has one running is refused rather
 * than run beside it: two tasks write the same files, and the tab that started the second could stop
 * only one of them, so the other ran on with nothing able to reach it.
 */

const state = vi.hoisted(() => ({ manager: null as unknown, userId: 'admin' }));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: state.userId, email: '', isAdmin: state.userId === 'admin', exp: 0 }) }));
vi.mock('@/lib/auth/system-database', () => ({ verifyWorkspaceAccess: vi.fn() }));
vi.mock('@/lib/server-generate/singleton', async () => {
  const { TaskManager } = await import('@/lib/server-generate/task-manager');
  state.manager = new TaskManager({ maxConcurrentPerScope: 5, keyTTLMs: 60_000 });
  return { taskManager: state.manager, eventBus: { emit: vi.fn() } };
});
vi.mock('@/lib/server-generate/server-orchestrator-runner', () => ({ runServerGeneration: vi.fn(async () => undefined) }));

const start = async (projectId: string, as?: { userId: string; workspaceId: string }) => {
  state.userId = as?.userId ?? 'admin';
  const { POST } = await import('../route');
  return POST({ json: async () => ({ projectId, prompt: 'x', model: 'm', apiKey: 'k', workspaceId: as?.workspaceId }) } as unknown as NextRequest);
};

beforeEach(() => vi.clearAllMocks());

describe('a start on a project that already has a server task', () => {
  it('is refused while the first is running, naming the first, and taken on another project', async () => {
    const first = await start('p1');
    expect(first.status).toBe(200);
    const { taskId } = await first.json();

    const second = await start('p1');
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: 'A task is already running for this project.',
      activeTask: { taskId, projectId: 'p1', status: 'running', startedAt: expect.any(Number), prompt: 'x', model: 'm' },
    });
    expect((await start('p2')).status).toBe(200);
  });

  it('names the running task only to the account that started it', async () => {
    expect((await start('p3', { userId: 'u1', workspaceId: 'ws1' })).status).toBe(200);

    const other = await start('p3', { userId: 'u2', workspaceId: 'ws1' });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'A task is already running for this project.' });
  });
});
