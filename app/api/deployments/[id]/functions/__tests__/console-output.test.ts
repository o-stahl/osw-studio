import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * A failed call's console output goes to the server log, which is often the only way to learn why
 * it failed. It is whatever the function printed, secrets included if it printed them, so the
 * deployment's log level holds it back as well: nothing reaches the server log when logging is off.
 */

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  execute: vi.fn(),
  warn: vi.fn(),
  level: 'all' as 'all' | 'errors' | 'off',
  levelError: null as Error | null,
}));

vi.mock('@/lib/vfs/adapters/deployment-adapter', () => ({
  resolveDeploymentByIdOrSlug: mocks.resolve,
}));
vi.mock('@/lib/edge-functions/executor', () => ({ executeFunction: mocks.execute }));
vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: mocks.warn, info: vi.fn(), debug: vi.fn() },
}));

import { GET } from '../[...path]/route';

const FN = { id: 'fn1', name: 'counter', enabled: true, method: 'ANY', code: 'return null;', timeoutMs: 5000 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.levelError = null;
  mocks.resolve.mockResolvedValue({
    workspaceId: 'w1',
    deployment: { id: 'd1', databaseEnabled: true, publishedAt: new Date('2026-11-01') },
    adapter: {
      getDeploymentDatabaseForAnalytics: () => ({
        getFunctionByName: () => FN,
        logFunctionExecution: vi.fn(),
        getFunctionLogLevel: () => {
          if (mocks.levelError) throw mocks.levelError;
          return mocks.level;
        },
      }),
    },
  });
  mocks.execute.mockResolvedValue({
    response: { status: 500, headers: {}, body: { error: 'upstream refused' } },
    logs: ['upstream said 401'],
    error: 'upstream refused',
    durationMs: 1,
  });
});

const call = () =>
  GET(new NextRequest('http://localhost/api/deployments/d1/functions/counter'), { params: Promise.resolve({ id: 'd1', path: ['counter'] }) });

describe('a failed call\'s console output', () => {
  it('reaches the server log while calls are logged', async () => {
    for (const level of ['all', 'errors'] as const) {
      mocks.level = level;
      mocks.warn.mockClear();
      await call();
      expect(mocks.warn, level).toHaveBeenCalledWith(expect.stringContaining('upstream said 401'));
    }
  });

  it('stays out of the server log when logging is off', async () => {
    mocks.level = 'off';
    await call();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('leaves the caller the function\'s own answer when the log level cannot be read', async () => {
    mocks.levelError = new Error('SQLITE_BUSY: database is locked');
    mocks.execute.mockResolvedValue({
      response: { status: 404, headers: {}, body: { error: 'no such post' } },
      logs: ['looked up post 7'],
      durationMs: 1,
    });

    const response = await call();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such post' });
  });
});
