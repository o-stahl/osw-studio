import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * A server-side run on the free allowance: on a hosted instance it starts once the gateway has a token
 * for the user, and carries none itself (`/api/generate` asks for the token of the user the run is
 * for); anywhere else, without a token, or without access to the workspace, it does not start.
 */
const createTask = vi.hoisted(() => vi.fn((..._a: unknown[]) => 'task-1'));
const runServerGeneration = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined));
const getAccountToken = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/session', () => ({ getSession: async () => ({ userId: 'osws-user-1' }) }));
const workspaceAccess = vi.hoisted(() => ({ denied: false }));
vi.mock('@/lib/auth/system-database', () => ({
  verifyWorkspaceAccess: () => { if (workspaceAccess.denied) throw new Error('denied'); },
}));
vi.mock('@/lib/server-generate/singleton', () => ({
  taskManager: { initialize: vi.fn(), updateTask: vi.fn(), getTask: () => ({ id: 'task-1' }), createTask },
  eventBus: {},
}));
vi.mock('@/lib/server-generate/server-orchestrator-runner', () => ({ runServerGeneration }));
vi.mock('@/lib/inference/account-token', () => ({ getAccountToken: (...a: unknown[]) => getAccountToken(...a) }));

function makeReq(body: unknown): NextRequest {
  return { headers: new Headers(), json: async () => body } as unknown as NextRequest;
}
async function start() {
  const { POST } = await import('../route');
  return POST(makeReq({
    projectId: 'p1', prompt: 'make it blue', model: 'osws/agent', workspaceId: 'ws-1',
    providerConfig: { provider: 'osws' },
  }));
}

beforeEach(() => {
  vi.resetModules();
  createTask.mockClear();
  runServerGeneration.mockClear();
  getAccountToken.mockReset();
  workspaceAccess.denied = false;
  process.env.NEXT_PUBLIC_SERVER_MODE = 'true';
  process.env.NEXT_PUBLIC_GATEWAY_URL = 'https://gateway.oswstudio.com';
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SERVER_MODE;
  delete process.env.NEXT_PUBLIC_GATEWAY_URL;
});

describe('POST /api/server-generate on the free allowance', () => {
  it('starts the run on a hosted instance once the gateway has a token for the user, and gives the run none', async () => {
    getAccountToken.mockResolvedValue({ token: 'account-token', expiresAt: Date.now() + 3_600_000 });
    const res = await start();
    expect(res.status).toBe(200);
    expect(getAccountToken).toHaveBeenCalledWith('osws-user-1');
    expect(createTask.mock.calls[0][2]).not.toBe('account-token');
    expect((runServerGeneration.mock.calls[0][1] as { apiKey?: string }).apiKey).not.toBe('account-token');
  });

  it('asks the gateway nothing for a caller without access to the workspace', async () => {
    workspaceAccess.denied = true;
    expect((await start()).status).toBe(403);
    expect(getAccountToken).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('does not start without a token from the gateway', async () => {
    getAccountToken.mockResolvedValue(null);
    expect((await start()).status).toBe(503);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('does not start on an instance that is not hosted', async () => {
    delete process.env.NEXT_PUBLIC_GATEWAY_URL;
    expect((await start()).status).toBe(400);
    expect(getAccountToken).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});
