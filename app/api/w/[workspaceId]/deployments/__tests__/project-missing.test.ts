import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * A deployment outlives its project. The list marks the ones whose project is gone from the
 * server, so the Deployments view can say why republishing is unavailable, and marks only those:
 * a flag on every row (or none) would either alarm about healthy deployments or hide orphans.
 */

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEPT = '11111111-1111-1111-1111-111111111111';
const GONE = '22222222-2222-2222-2222-222222222222';

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let dir: string;
let adapter: SQLiteAdapter;

async function addDeployment(id: string, projectId: string) {
  await adapter.createDeployment({
    id, projectId, name: id, underConstruction: false, headScripts: [], bodyScripts: [], cdnLinks: [],
    settingsVersion: 1, createdAt: new Date(), updatedAt: new Date(),
  } as never);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-deploy-missing-'));
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  const wsDir = path.join(dir, 'data', 'workspaces', WS);
  fs.mkdirSync(wsDir, { recursive: true });
  adapter = new SQLiteAdapter(path.join(wsDir, 'osws.sqlite'), WS);
  await adapter.init();
  for (const id of [KEPT, GONE]) {
    await adapter.createProject({ id, name: id, createdAt: new Date(), updatedAt: new Date(), settings: {} } as never);
  }
  await addDeployment('kept', KEPT);
  await addDeployment('orphan', GONE);
  await adapter.deleteProject(GONE);
  mocks.getWorkspaceContext.mockResolvedValue({ adapter, workspaceId: WS, session: { userId: 'u1' } });
});

afterEach(async () => {
  await adapter.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/w/{id}/deployments', () => {
  it('flags only the deployment whose project is gone', async () => {
    const { GET } = await import('../route');
    const response = await GET(new NextRequest(`http://x/api/w/${WS}/deployments`), {
      params: Promise.resolve({ workspaceId: WS }),
    });

    expect(response.status).toBe(200);
    const listed = (await response.json()) as Array<{ id: string; projectMissing?: boolean }>;
    const byId = Object.fromEntries(listed.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['kept', 'orphan']);
    expect(byId.orphan.projectMissing).toBe(true);
    expect(byId.kept).not.toHaveProperty('projectMissing');
  });
});
