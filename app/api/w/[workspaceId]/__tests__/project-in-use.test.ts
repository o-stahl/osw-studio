import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * A deployment publishes its project's build. Deleting the project took the deployment row with it
 * (the row was declared ON DELETE CASCADE) while the built site stayed live: a published site the
 * Deployments view no longer listed, so nobody could republish, repoint or unpublish it. Now the
 * project cannot be deleted while a deployment uses it, and a deployment outlives its project in
 * the database whatever deletes it.
 */

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROJECT = '11111111-1111-1111-1111-111111111111';

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext, requireWorkspaceRole: () => {} }));
vi.mock('@/lib/auth/system-database', () => ({ getWorkspaceById: () => ({ id: WS, max_storage_mb: 500 }) }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let dir: string;
let adapter: SQLiteAdapter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-inuse-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  const wsDir = path.join(dir, 'data', 'workspaces', WS);
  fs.mkdirSync(wsDir, { recursive: true });
  adapter = new SQLiteAdapter(path.join(wsDir, 'osws.sqlite'), WS);
  await adapter.init();
  await adapter.createProject({ id: PROJECT, name: 'P', createdAt: new Date(), updatedAt: new Date(), settings: {} } as never);
  await adapter.createDeployment({
    id: 'd1', projectId: PROJECT, name: 'OSWS OS', underConstruction: false,
    headScripts: [], bodyScripts: [], cdnLinks: [], settingsVersion: 1,
    createdAt: new Date(), updatedAt: new Date(),
  } as never);
  mocks.getWorkspaceContext.mockResolvedValue({ adapter, workspaceId: WS, session: { userId: 'u1' } });
});

afterEach(async () => {
  await adapter.close?.();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a project a deployment uses', () => {
  it('cannot be deleted, and says which deployment uses it', async () => {
    const { DELETE } = await import('@/app/api/w/[workspaceId]/sync/projects/[id]/route');
    const res = await DELETE(
      new NextRequest(`http://x/api/w/${WS}/sync/projects/${PROJECT}`, { method: 'DELETE' }),
      { params: Promise.resolve({ workspaceId: WS, id: PROJECT }) } as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'in_use', deployments: ['OSWS OS'] });
    expect(await adapter.getProject(PROJECT)).not.toBeNull();
  });

  it('leaves the deployment listed if the project goes anyway', async () => {
    await adapter.deleteProject(PROJECT);
    const listed = await adapter.listDeployments();
    expect(listed.map((d) => d.id)).toEqual(['d1']);
    expect(listed[0].projectId).toBe(PROJECT);
  });
});
