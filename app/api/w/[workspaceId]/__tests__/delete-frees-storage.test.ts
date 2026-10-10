import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * Deleting frees bytes, and the measurement behind the storage quota is cached for a minute.
 *
 * `forgetWorkspaceStorage` exists for this and was called from nowhere, so for up to a minute after
 * a delete the space was free on disk while the next write was still refused against the old
 * reading. The unpublish path has its own test; these are the two other call sites, and a wiring
 * that is only read and never exercised is how the first one came to be missing.
 */

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROJECT = '11111111-1111-1111-1111-111111111111';

const mocks = vi.hoisted(() => ({
  getWorkspaceContext: vi.fn(),
  removeDeploymentRoute: vi.fn(),
  cleanStaticDeployment: vi.fn(async () => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext, requireWorkspaceRole: () => {} }));
vi.mock('@/lib/auth/system-database', () => ({
  removeDeploymentRoute: mocks.removeDeploymentRoute,
  getWorkspaceById: () => ({ id: WS, max_storage_mb: 500 }),
}));
vi.mock('@/lib/compiler/static-builder', () => ({ cleanStaticDeployment: mocks.cleanStaticDeployment }));
vi.mock('@/lib/caddy/regenerate', () => ({ regenerateInstanceCaddy: async () => {} }));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let wsDir: string;
let adapter: SQLiteAdapter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-del-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('DEPLOYMENTS_STATIC_DIR', path.join(dir, 'static'));

  wsDir = path.join(dir, 'data', 'workspaces', WS);
  fs.mkdirSync(wsDir, { recursive: true });
  adapter = new SQLiteAdapter(path.join(wsDir, 'osws.sqlite'), WS);
  await adapter.init();
  await adapter.createProject({
    id: PROJECT, name: 'P', createdAt: new Date(), updatedAt: new Date(), settings: {},
  } as never);
  mocks.getWorkspaceContext.mockResolvedValue({ adapter, workspaceId: WS, session: { userId: 'u1' } });
});

afterEach(async () => {
  await adapter.close?.();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A file big enough to move the reported figure, then read so the measurement is cached. */
async function fillAndCache(): Promise<number> {
  fs.writeFileSync(path.join(wsDir, 'bulk.bin'), Buffer.alloc(3 * 1024 * 1024));
  const { workspaceStorageMb } = await import('@/lib/api/storage-quota');
  return workspaceStorageMb(WS, () => []);
}

async function reportedMb(): Promise<number> {
  const { workspaceStorageMb } = await import('@/lib/api/storage-quota');
  return workspaceStorageMb(WS, () => []);
}

const params = (extra: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ workspaceId: WS, ...extra }) });

describe('deleting a project', () => {
  it('drops the cached storage reading, so freed space counts at once', async () => {
    const before = await fillAndCache();
    expect(before).toBeGreaterThan(2);

    fs.rmSync(path.join(wsDir, 'bulk.bin'));
    const { DELETE } = await import('@/app/api/w/[workspaceId]/sync/projects/[id]/route');
    const res = await DELETE(
      new NextRequest(`http://x/api/w/${WS}/sync/projects/${PROJECT}`, { method: 'DELETE' }),
      params({ id: PROJECT }) as never,
    );

    expect(res.status).toBe(200);
    expect(await reportedMb()).toBeLessThan(before);
  });
});

describe('deleting a deployment', () => {
  it('drops the cached storage reading, so freed space counts at once', async () => {
    await adapter.createDeployment({
      id: 'd1', projectId: PROJECT, name: 'D', underConstruction: false,
      headScripts: [], bodyScripts: [], cdnLinks: [], settingsVersion: 1,
      createdAt: new Date(), updatedAt: new Date(),
    } as never);

    const before = await fillAndCache();
    expect(before).toBeGreaterThan(2);

    fs.rmSync(path.join(wsDir, 'bulk.bin'));
    const { DELETE } = await import('@/app/api/w/[workspaceId]/deployments/[id]/route');
    const res = await DELETE(
      new NextRequest(`http://x/api/w/${WS}/deployments/d1`, { method: 'DELETE' }),
      params({ id: 'd1' }) as never,
    );

    expect(res.status).toBe(200);
    expect(mocks.cleanStaticDeployment).toHaveBeenCalledWith('d1');
    expect(await reportedMb()).toBeLessThan(before);
  });
});
