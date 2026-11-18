import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * A workspace's project limit (`max_projects`) on the routes a browser pushes through. Every push
 * reaches `sync/projects/[id]`, which creates the project on its first batch; `sync/projects` is the
 * project-only route. A new project past the limit is refused on both, and a project the server
 * already has is never counted against a write to it.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn(), maxProjects: 1 }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/auth/system-database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/system-database')>();
  return {
    ...actual,
    getWorkspaceById: (id: string) => ({
      id, name: 'W', owner_id: 'u1', created_at: '', updated_at: '',
      max_projects: mocks.maxProjects, max_deployments: 9999, max_storage_mb: 99999,
    }),
  };
});

import { POST as projectPOST } from '@/app/api/w/[workspaceId]/sync/projects/[id]/route';
import { POST as metadataPOST } from '@/app/api/w/[workspaceId]/sync/projects/route';

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EXISTING = '11111111-1111-1111-1111-111111111111';
const NEW = '22222222-2222-2222-2222-222222222222';

let dir: string;
let adapter: SQLiteAdapter;

beforeEach(async () => {
  mocks.maxProjects = 1;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-limit-'));
  const wsDir = path.join(dir, 'data', 'workspaces', WS);
  fs.mkdirSync(wsDir, { recursive: true });
  adapter = new SQLiteAdapter(path.join(wsDir, 'osws.sqlite'));
  await adapter.init();
  await adapter.createProject({
    id: EXISTING, name: 'Existing', createdAt: new Date(), updatedAt: new Date(), settings: {}, revision: 0,
  } as never);
  mocks.getWorkspaceContext.mockResolvedValue({ adapter, workspaceId: WS, session: { userId: 'u1' } });
});

afterEach(async () => {
  await adapter.close?.();
  vi.clearAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function project(id: string, name: string) {
  const now = new Date().toISOString();
  return { id, name, createdAt: now, updatedAt: now, settings: {} };
}

function push(id: string, name: string) {
  const now = new Date().toISOString();
  return projectPOST(
    new NextRequest(`http://localhost/api/w/${WS}/sync/projects/${id}`, {
      method: 'POST',
      body: JSON.stringify({
        project: project(id, name),
        files: [{
          id: `f-${id}`, projectId: id, path: '/index.html', name: 'index.html', type: 'html',
          content: '<h1>x</h1>', mimeType: 'text/html', size: 10, createdAt: now, updatedAt: now,
        }],
        deletedPaths: [],
        partial: true,
        writeProject: true,
        baseRevision: 0,
      }),
    }),
    { params: Promise.resolve({ workspaceId: WS, id }) },
  );
}

describe('a push of a new project', () => {
  it('is refused, and creates nothing, when the workspace is at its project limit', async () => {
    const response = await push(NEW, 'One too many');
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Project limit reached (1).');
    expect(await adapter.getProject(NEW)).toBeNull();
    expect(await adapter.listFiles(NEW)).toEqual([]);
  });

  it('goes through below the limit', async () => {
    mocks.maxProjects = 2;
    const response = await push(NEW, 'The last one');
    expect(response.status).toBe(200);
    expect((await adapter.getProject(NEW))!.name).toBe('The last one');
  });

  it('never counts a project the server already has against a write to it', async () => {
    const response = await push(EXISTING, 'Renamed');
    expect(response.status).toBe(200);
    expect((await adapter.getProject(EXISTING))!.name).toBe('Renamed');
  });
});

describe('the project-only route', () => {
  it('refuses a new project at the limit with the same answer', async () => {
    const response = await metadataPOST(
      new NextRequest(`http://localhost/api/w/${WS}/sync/projects`, {
        method: 'POST',
        body: JSON.stringify({ project: project(NEW, 'One too many'), baseRevision: 0 }),
      }),
      { params: Promise.resolve({ workspaceId: WS }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Project limit reached (1).');
    expect(await adapter.getProject(NEW)).toBeNull();
  });

  it('never counts a project the server already has against a write to it', async () => {
    const response = await metadataPOST(
      new NextRequest(`http://localhost/api/w/${WS}/sync/projects`, {
        method: 'POST',
        body: JSON.stringify({ project: project(EXISTING, 'Renamed'), baseRevision: 0 }),
      }),
      { params: Promise.resolve({ workspaceId: WS }) },
    );
    expect(response.status).toBe(200);
    expect((await adapter.getProject(EXISTING))!.name).toBe('Renamed');
  });
});
