import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * A server run reads and writes the named project's files, so starting one needs editor access to
 * the workspace it names. The route took the workspace from the request body unchecked, so any
 * signed-in account could run the agent against another workspace's project.
 */

const mocks = vi.hoisted(() => ({
  session: { userId: 'u1', email: 'a@b.c', isAdmin: false, exp: 0 } as { userId: string } | null,
  verifyWorkspaceAccess: vi.fn(),
  createTask: vi.fn(() => 'task-1'),
}));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => mocks.session }));
vi.mock('@/lib/auth/system-database', () => ({ verifyWorkspaceAccess: mocks.verifyWorkspaceAccess }));
vi.mock('@/lib/server-generate/singleton', () => ({
  taskManager: { initialize: vi.fn(), updateTask: vi.fn(), getTask: () => ({ id: 'task-1' }), createTask: mocks.createTask },
  eventBus: {},
}));
vi.mock('@/lib/server-generate/server-orchestrator-runner', () => ({ runServerGeneration: vi.fn(async () => undefined) }));

const start = async (body: Record<string, unknown>) => {
  const { POST } = await import('../route');
  return POST({ json: async () => ({ projectId: 'p1', prompt: 'x', model: 'm', apiKey: 'k', ...body }) } as unknown as NextRequest);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { userId: 'u1', email: 'a@b.c', isAdmin: false, exp: 0 } as never;
});

describe('starting a server run', () => {
  it('needs editor access to the workspace it names', async () => {
    mocks.verifyWorkspaceAccess.mockImplementation(() => { throw new Error('Workspace access denied'); });
    const res = await start({ workspaceId: 'ws-other' });
    expect(res.status).toBe(403);
    expect(mocks.verifyWorkspaceAccess).toHaveBeenCalledWith('u1', 'ws-other', 'editor');
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('starts for an editor of that workspace', async () => {
    mocks.verifyWorkspaceAccess.mockImplementation(() => {});
    expect((await start({ workspaceId: 'ws-1' })).status).toBe(200);
    expect(mocks.createTask).toHaveBeenCalled();
  });

  it('refuses an account that names no workspace', async () => {
    expect((await start({})).status).toBe(400);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
