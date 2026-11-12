import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

/**
 * The Logs section reads the deployment's calls with its log level and how many calls are kept,
 * and sets the level. The level is read live by the invocation route, so it is not a publish
 * setting: changing it leaves the deployment's settings version, and its published state, alone.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), updateDeployment: vi.fn() }));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));

let dir: string;
let mod: typeof import('@/lib/vfs/adapters/runtime-database');
let db: InstanceType<typeof mod.RuntimeDatabase>;
const params = Promise.resolve({ workspaceId: 'w1', id: 'd1' });

async function route() {
  return import('../logs/route');
}
const put = async (body: unknown) => {
  const { PUT } = await route();
  const res = await PUT(new Request('http://localhost/logs', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest, { params });
  return { status: res.status, body: await res.json() };
};
const get = async () => {
  const { GET } = await route();
  const res = await GET(new Request('http://localhost/logs?limit=200') as unknown as NextRequest, { params });
  return { status: res.status, body: await res.json() };
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-loglevel-'));
  vi.stubEnv('DEPLOYMENTS_DIR', dir);
  vi.resetModules();
  mod = await import('@/lib/vfs/adapters/runtime-database');
  db = new mod.RuntimeDatabase('d1');
  db.init();
  mocks.getWorkspaceContext.mockResolvedValue({
    adapter: {
      getDeployment: async () => ({ id: 'd1', databaseEnabled: true, settingsVersion: 4, lastPublishedVersion: 4 }),
      getDeploymentDatabaseForAnalytics: () => db,
      updateDeployment: mocks.updateDeployment,
    },
  });
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the function logs route and the log level', () => {
  it('answers the calls with the level and how many calls are kept', async () => {
    const out = await get();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ logs: [], level: 'all', cap: mod.FUNCTION_LOG_CAP });
  });

  it('sets a level, which the next read reports, without touching the deployment', async () => {
    expect((await put({ level: 'errors' })).status).toBe(200);
    expect(db.getFunctionLogLevel()).toBe('errors');
    expect((await get()).body.level).toBe('errors');
    expect(mocks.updateDeployment).not.toHaveBeenCalled();
  });

  it('refuses a level it does not know', async () => {
    const out = await put({ level: 'verbose' });
    expect(out.status).toBe(400);
    expect(db.getFunctionLogLevel()).toBe('all');
  });
});
