// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * Save after a Server Mode run: the run writes the project on the server, the tab pulls it at the
 * end, and Save then pushes the tab's copy. Real routes, real SQLite, real IndexedDB.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
vi.mock('@/lib/api/workspace-context', () => ({
  getWorkspaceContext: mocks.getWorkspaceContext,
  requireWorkspaceRole: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/api/project-quota', () => ({ projectLimitRefusal: vi.fn(async () => null) }));
vi.mock('@/lib/api/storage-quota', () => ({ forgetWorkspaceStorage: vi.fn() }));

import * as projectRoute from '@/app/api/w/[workspaceId]/sync/projects/[id]/route';
import * as backendRoute from '@/app/api/w/[workspaceId]/sync/backend-features/[projectId]/route';
import { vfs, VirtualFileSystem } from '../index';
import { getSyncManager } from '../sync-manager';
import { setAutoSyncWorkspaceId, autoSyncProject } from '../auto-sync';
import { saveManager } from '../save-manager';
import { setPushGate, releaseHeldPush } from '../push-gate';
import { toast } from 'sonner';
import { pullAndCheckpointServerFiles } from '@/lib/stores/slices/orchestrator';

const WORKSPACE = 'ws-save';
let dir: string;
let server: SQLiteAdapter;
let projectId: string;
const pushes: number[] = [];

beforeEach(async () => {
  pushes.length = 0;
  vi.mocked(toast.warning).mockClear();
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-save-'));
  server = new SQLiteAdapter(path.join(dir, 'osws.sqlite'));
  await server.init();
  mocks.getWorkspaceContext.mockResolvedValue({ session: { userId: 'u1' }, workspaceId: WORKSPACE, adapter: server, role: 'owner' });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const request = new NextRequest(`http://localhost${url.pathname}${url.search}`, { method, ...(init?.body ? { body: init.body as string } : {}) });
    const id = url.pathname.split('/').pop()!;
    if (url.pathname.includes('/sync/backend-features/')) {
      const params = Promise.resolve({ workspaceId: WORKSPACE, projectId: id });
      return method === 'POST' ? backendRoute.POST(request, { params }) : backendRoute.GET(request, { params });
    }
    if (url.pathname.includes('/sync/projects/')) {
      const params = Promise.resolve({ workspaceId: WORKSPACE, id });
      if (method === 'POST') {
        const response = await projectRoute.POST(request, { params });
        pushes.push(response.status);
        return response;
      }
      return projectRoute.GET(request, { params });
    }
    return new Response('{}', { status: 404 });
  }));
  setAutoSyncWorkspaceId(WORKSPACE);
  getSyncManager(WORKSPACE);
  await vfs.init();
  projectId = (await vfs.createProject('Neon', 'test')).id;
  await vfs.createFile(projectId, '/index.html', '<h1>start</h1>');
});

afterEach(async () => {
  setPushGate(() => false);
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** What a server run does to the server's copy: files, and the project's cost after every call. */
async function serverRun() {
  const serverVfs = new VirtualFileSystem(server);
  await serverVfs.init();
  await serverVfs.updateFile(projectId, '/index.html', '<h1>from the run</h1>');
  for (const cost of [0.1, 0.2]) {
    await serverVfs.updateProjectCost(projectId, { cost, provider: 'openrouter', sessionId: 'task-1', mode: 'absolute' });
  }
}

const state = () => ({
  projectId,
  addDebugEvent: vi.fn(),
  markDirty: vi.fn(),
  bumpRefreshTrigger: vi.fn(),
});

describe('Save after a server run', () => {
  it('pushes without a conflict', async () => {
    await autoSyncProject(projectId);
    expect(pushes).toEqual([200]);

    await serverRun();
    await pullAndCheckpointServerFiles(projectId, (() => state()) as never);
    expect((await vfs.readFile(projectId, '/index.html')).content).toBe('<h1>from the run</h1>');

    await saveManager.save(projectId);
    await vfs.flushSyncTimeout(projectId);

    expect(pushes).toEqual([200, 200]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(saveManager.isDirty(projectId)).toBe(false);
  });

  /** The pre-run sync in `startServerGeneration`, as it stands. */
  async function preRunSync() {
    const project = await vfs.getProject(projectId);
    const files = (await vfs.getAllFilesAndDirectories(projectId)).filter(f => !('type' in f && f.type === 'directory'));
    const result = await getSyncManager().pushProjectDelta(projectId, project, files as never);
    if (result.success && result.project) {
      await vfs.updateProject({
        ...project,
        lastSyncedAt: new Date(result.project.lastSyncedAt ?? Date.now()),
        serverUpdatedAt: new Date(result.project.serverUpdatedAt ?? result.project.updatedAt),
        syncStatus: 'synced',
      }, { preserveUpdatedAt: true });
    }
    return result;
  }

  for (const order of ['auto-sync first', 'pre-run sync first'] as const) {
    it(`pushes without a conflict when a new project's first push meets the run's (${order})`, async () => {
      const both = order === 'auto-sync first'
        ? [autoSyncProject(projectId), preRunSync()]
        : [preRunSync(), autoSyncProject(projectId)];
      await Promise.all(both);
      const atStart = [...pushes];

      await serverRun();
      await pullAndCheckpointServerFiles(projectId, (() => state()) as never);
      pushes.length = 0;
      vi.mocked(toast.warning).mockClear();

      await saveManager.save(projectId);
      await vfs.flushSyncTimeout(projectId);

      // Whichever start-up push lost the race may be refused; the end-of-run pull settles it.
      expect(atStart.every(status => status === 200 || status === 409)).toBe(true);
      expect(atStart).toContain(200);
      expect({ save: pushes, warned: vi.mocked(toast.warning).mock.calls.length, dirty: saveManager.isDirty(projectId) })
        .toEqual({ save: [200], warned: 0, dirty: false });
    });
  }

  /** The tab's mirror of a run's write, as `handleFilesChanged` makes it: not a local edit. */
  const mirror = (filePath: string, content: string) =>
    saveManager.runWithSuppressedDirty(projectId, async () => {
      if (await vfs.fileExists(projectId, filePath)) await vfs.updateFile(projectId, filePath, content, { silent: true });
      else await vfs.createFile(projectId, filePath, content, { silent: true });
    });
  const serverFile = async (filePath: string) => (await server.listFiles(projectId)).find(f => f.path === filePath)?.content;
  const save = async () => {
    pushes.length = 0;
    vi.mocked(toast.warning).mockClear();
    await saveManager.save(projectId);
    await vfs.flushSyncTimeout(projectId);
    return { pushes: [...pushes], warned: vi.mocked(toast.warning).mock.calls.length, dirty: saveManager.isDirty(projectId) };
  };

  it('leaves the revision alone when a run only spends', async () => {
    await autoSyncProject(projectId);
    const before = (await server.getProject(projectId))!;
    const serverVfs = new VirtualFileSystem(server);
    await serverVfs.init();
    await serverVfs.updateProjectCost(projectId, { cost: 0.1, provider: 'openrouter', sessionId: 'task-1', mode: 'absolute' });

    const after = (await server.getProject(projectId))!;
    expect(after.costTracking?.totalCost).toBeCloseTo(0.1);
    expect(after.revision).toBe(before.revision);
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    expect(await save()).toEqual({ pushes: [200], warned: 0, dirty: false });
  });

  it('recovers a refused push when both sides hold the same files', async () => {
    await autoSyncProject(projectId);
    await serverRun();
    await mirror('/index.html', '<h1>from the run</h1>');

    expect(await save()).toEqual({ pushes: [409, 200], warned: 0, dirty: false });
    expect((await vfs.getProject(projectId)).syncStatus).toBe('synced');
    expect(await save()).toEqual({ pushes: [200], warned: 0, dirty: false });
  });

  it('keeps a refusal, and the server\'s files, when the two sides differ', async () => {
    await autoSyncProject(projectId);
    const serverVfs = new VirtualFileSystem(server);
    await serverVfs.init();
    await serverVfs.updateFile(projectId, '/index.html', '<h1>another device</h1>');
    await serverVfs.createFile(projectId, '/theirs.html', '<p>theirs</p>');
    await vfs.updateFile(projectId, '/index.html', '<h1>mine</h1>');

    expect(await save()).toEqual({ pushes: [409], warned: 1, dirty: true });
    expect(await serverFile('/index.html')).toBe('<h1>another device</h1>');
    expect(await serverFile('/theirs.html')).toBe('<p>theirs</p>');
    expect((await vfs.readFile(projectId, '/index.html')).content).toBe('<h1>mine</h1>');
  });

  it('keeps a refusal when the server has a file this tab lacks', async () => {
    await autoSyncProject(projectId);
    const serverVfs = new VirtualFileSystem(server);
    await serverVfs.init();
    await serverVfs.createFile(projectId, '/theirs.html', '<p>theirs</p>');

    expect((await save()).pushes).toEqual([409]);
    expect(await serverFile('/theirs.html')).toBe('<p>theirs</p>');
  });

  it('keeps a refusal when this tab has a file the server lacks', async () => {
    // Deleted on another device, or new here: the files alone cannot say which.
    await autoSyncProject(projectId);
    await serverRun();
    await mirror('/index.html', '<h1>from the run</h1>');
    await vfs.createFile(projectId, '/mine.html', '<p>mine</p>');

    expect((await save()).pushes).toEqual([409]);
    expect(await serverFile('/mine.html')).toBeUndefined();
  });

  it('sends this tab\'s unpushed project changes after a run whose files it already has', async () => {
    await autoSyncProject(projectId);
    await new Promise(resolve => setTimeout(resolve, 5));
    const project = await vfs.getProject(projectId);
    await vfs.updateProject({ ...project, name: 'Renamed here' });
    await serverRun();
    await mirror('/index.html', '<h1>from the run</h1>');
    pushes.length = 0;

    await pullAndCheckpointServerFiles(projectId, (() => state()) as never);

    await vi.waitFor(() => expect(pushes).toEqual([200]));
    expect(toast.warning).not.toHaveBeenCalled();
    expect((await vfs.getProject(projectId)).name).toBe('Renamed here');
    await vi.waitFor(async () => expect((await server.getProject(projectId))!.name).toBe('Renamed here'));
  });

  it('releases a project a refusal had left stuck, once its files match', async () => {
    await autoSyncProject(projectId);
    await serverRun();
    expect((await save()).pushes).toEqual([409]);
    expect((await vfs.getProject(projectId)).syncStatus).toBe('error');

    await mirror('/index.html', '<h1>from the run</h1>');
    expect(await save()).toEqual({ pushes: [409, 200], warned: 0, dirty: false });
  });

  it('holds a Save made during a run, and sends it after the run\'s pull without a conflict', async () => {
    await autoSyncProject(projectId);
    let running = true;
    setPushGate(() => running);

    await serverRun();
    await mirror('/index.html', '<h1>from the run</h1>');
    expect(await save()).toEqual({ pushes: [], warned: 0, dirty: false });

    running = false;
    await pullAndCheckpointServerFiles(projectId, (() => state()) as never);
    expect(toast.warning).not.toHaveBeenCalled();
    releaseHeldPush(projectId);
    await vi.waitFor(() => expect(pushes).toEqual([200]));
    await vi.waitFor(async () => expect((await vfs.getProject(projectId)).syncStatus).toBe('synced'));
    // One push carries the Save: the pull's own and the one that waited are not both sent.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(pushes).toEqual([200]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(await serverFile('/index.html')).toBe('<h1>from the run</h1>');
  });

  it('still reports a conflict after a run when this tab edited a file the run also wrote', async () => {
    await autoSyncProject(projectId);
    await serverRun();
    await vfs.updateFile(projectId, '/index.html', '<h1>mine, during the run</h1>');

    await pullAndCheckpointServerFiles(projectId, (() => state()) as never);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect((await vfs.readFile(projectId, '/index.html')).content).toBe('<h1>mine, during the run</h1>');
    expect(await serverFile('/index.html')).toBe('<h1>from the run</h1>');
  });
});
