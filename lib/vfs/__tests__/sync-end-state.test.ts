// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * End-state sync tests: a real client talking to a real server.
 *
 * The "imported project shows Local newer" bug has now been fixed three times and shipped broken
 * three times. Every previous test drew its boundary inside the thing that was broken — it mocked
 * the sync manager and derived the server's timestamp from the client's own, so the server could
 * never disagree with the client and the failing case was inexpressible.
 *
 * Here the server is a real participant: the actual route handlers over a real SQLite database,
 * reached through a fetch shim. Nothing about sync is mocked. Each test asserts the END STATE the
 * user sees ("does Server Sync say synced?") rather than the mechanism that was supposed to produce
 * it, so a new cause of the same symptom fails the test even though the old cause stays fixed.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));

vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { GET as statusGET } from '@/app/api/w/[workspaceId]/sync/status/route';
import {
  GET as projectGET,
  POST as projectPOST,
  DELETE as projectDELETE,
} from '@/app/api/w/[workspaceId]/sync/projects/[id]/route';
import {
  GET as projectsGET,
  POST as projectsPOST,
} from '@/app/api/w/[workspaceId]/sync/projects/route';

import { vfs } from '../index';
import { BackupService } from '../backup-service';
import { getSyncManager } from '../sync-manager';
import { saveManager } from '../save-manager';
import { calculateItemSyncStatus } from '../sync-types';
import {
  fetchSyncStatus,
  invalidateSyncStatusCache,
  reconcileProjectsToServer,
  setAutoSyncWorkspaceId,
  autoSyncProject,
} from '../auto-sync';

const WORKSPACE = 'w1';

let dir: string;
let adapter: SQLiteAdapter;

/** Routes /api/w/{id}/sync/* straight into the real handlers. No network, no stubbed responses. */
async function dispatch(rawUrl: string, init?: RequestInit): Promise<Response> {
  const url = new URL(rawUrl, 'http://localhost');
  const match = url.pathname.match(/^\/api\/w\/([^/]+)\/sync\/(.+)$/);
  if (!match) throw new Error(`unrouted request: ${rawUrl}`);
  const [, workspaceId, rest] = match;
  const method = (init?.method ?? 'GET').toUpperCase();

  const request = new NextRequest(`http://localhost${url.pathname}${url.search}`, {
    method,
    ...(init?.body ? { body: init.body as string } : {}),
  });

  if (rest === 'status') {
    return statusGET(request, { params: Promise.resolve({ workspaceId }) });
  }

  if (rest === 'projects') {
    const params = Promise.resolve({ workspaceId });
    return method === 'POST' ? projectsPOST(request, { params }) : projectsGET(request, { params });
  }

  const single = rest.match(/^projects\/([^/?]+)$/);
  if (single) {
    const params = Promise.resolve({ workspaceId, id: single[1] });
    if (method === 'POST') return projectPOST(request, { params });
    if (method === 'DELETE') return projectDELETE(request, { params });
    return projectGET(request, { params });
  }

  throw new Error(`unrouted request: ${rawUrl}`);
}

/**
 * Exactly what the Server Sync dialog computes (use-sync-status.ts): the local record's own
 * timestamps against the server's live list. Asserting on this is asserting on what the user reads.
 */
async function serverSyncSays(projectId: string) {
  invalidateSyncStatusCache();
  const status = await fetchSyncStatus();
  const server = (status?.projects ?? []).find((p: { id: string }) => p.id === projectId);
  const local = await vfs.getProject(projectId);
  return calculateItemSyncStatus(
    local!.updatedAt,
    server?.updatedAt ?? null,
    local!.lastSyncedAt ?? null
  );
}

const CREATED_AT = new Date('2026-07-31T10:00:00.000Z');
const PUSHED_AT = new Date('2026-07-31T10:00:05.000Z');
const EDITED_AT = new Date('2026-07-31T10:00:10.000Z');

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  // Only Date is faked: fake-indexeddb drives its requests off real timers and faking those
  // deadlocks it. The server stores the client's updatedAt verbatim, so pinning the clock makes
  // every timestamp in the loop deterministic instead of a race with how fast the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CREATED_AT);

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-endstate-'));
  adapter = new SQLiteAdapter(path.join(dir, 'osws.sqlite'));
  await adapter.init();
  mocks.getWorkspaceContext.mockResolvedValue({
    session: { userId: 'u1' },
    workspaceId: WORKSPACE,
    adapter,
  });

  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return dispatch(url, init);
  }));

  setAutoSyncWorkspaceId(WORKSPACE);
  invalidateSyncStatusCache();
  await vfs.init();
});

afterEach(async () => {
  await adapter.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A project that exists locally and has been pushed to the server. */
async function createAndPush(name: string) {
  vi.setSystemTime(CREATED_AT);
  const project = await vfs.createProject(name, 'end-state fixture');
  await vfs.createFile(project.id, '/index.html', '<h1>hi</h1>');
  saveManager.markClean(project.id);

  vi.setSystemTime(PUSHED_AT);
  const { pushProjectToServer } = await import('../push-project-to-server');
  await pushProjectToServer(project.id, WORKSPACE);
  return project.id;
}

describe('a freshly pushed project', () => {
  it('reads as synced in Server Sync', async () => {
    const id = await createAndPush('Fresh');

    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('stores a numeric revision so the next Save is not a 409 against ourselves', async () => {
    const id = await createAndPush('Ack');
    const local = (await vfs.getProject(id))!;
    expect(typeof local.revision).toBe('number');
    expect(local.revision).toBeGreaterThanOrEqual(1);

    vi.setSystemTime(EDITED_AT);
    await vfs.updateFile(id, '/index.html', '<h1>again</h1>');
    saveManager.markClean(id);
    await reconcileProjectsToServer(WORKSPACE);
    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('does not delete a one-commit second writer on Save', async () => {
    const id = await createAndPush('SecondWriter');
    const onServer = (await adapter.getProject(id))!;
    await adapter.createFile({
      id: 'from-second',
      projectId: id,
      path: '/from-second.txt',
      name: 'from-second.txt',
      type: 'text',
      content: 'agent',
      mimeType: 'text/plain',
      size: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    adapter.bumpRevision(id, onServer.revision ?? 0);

    vi.setSystemTime(EDITED_AT);
    await vfs.createFile(id, '/from-t1.txt', 'local');
    saveManager.markClean(id);
    await autoSyncProject(id);

    const paths = (await adapter.listFiles(id)).map((f) => f.path);
    expect(paths).toContain('/from-second.txt');
    expect(await serverSyncSays(id)).not.toBe('synced');
  });
});

describe('a project restored from an .osws backup', () => {
  /**
   * The backup carries lastSyncedAt/serverUpdatedAt describing a sync to whichever instance it was
   * taken from. Restored verbatim they are read as this server's history, and the project can never
   * settle: it reads 'conflict' when the server also has it (and a conflicting push is refused), or
   * the reconcile guard vetoes the upload when it doesn't.
   *
   * These go through the real BackupService.importAllData rather than writing the record by hand,
   * because the normalisation under test lives in that path — simulating the restore would test the
   * simulation.
   */
  const STALE = '2026-06-30T21:09:25.571Z';

  async function backupFileFor(records: { projects: unknown[]; files?: unknown[] }): Promise<File> {
    const backup = {
      version: '1.9.0',
      exportDate: new Date().toISOString(),
      databases: {
        vfs: { projects: records.projects, files: records.files ?? [] },
        conversations: [],
        checkpoints: [],
      },
      metadata: {
        projectCount: records.projects.length,
        totalSize: 0,
        exportedFrom: 'oswstudio',
      },
    };
    const zip = new JSZip();
    zip.file('backup.json', JSON.stringify(backup));
    const blob = await zip.generateAsync({ type: 'blob' });
    return new File([blob], 'backup.osws');
  }

  it('settles as synced when this server already has the project', async () => {
    const id = await createAndPush('Restored');
    const local = await vfs.getProject(id);

    const file = await backupFileFor({
      projects: [{ ...local, lastSyncedAt: STALE, serverUpdatedAt: STALE, syncStatus: 'synced' }],
    });
    await BackupService.importAllData(file, { mode: 'merge' });
    saveManager.markClean(id);

    await reconcileProjectsToServer(WORKSPACE);

    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('is uploaded when this server has never seen the project', async () => {
    // A backup taken on another instance: the record claims a sync that never happened here.
    const id = 'restored-elsewhere';
    const file = await backupFileFor({
      projects: [
        {
          id,
          name: 'From another instance',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          settings: {},
          lastSyncedAt: STALE,
          serverUpdatedAt: STALE,
          syncStatus: 'synced',
        },
      ],
      files: [
        {
          id: 'f1',
          projectId: id,
          path: '/index.html',
          name: 'index.html',
          type: 'html',
          content: '<h1>restored</h1>',
          mimeType: 'text/html',
          size: 17,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          metadata: {},
        },
      ],
    });
    await BackupService.importAllData(file, { mode: 'merge' });
    saveManager.markClean(id);

    await reconcileProjectsToServer(WORKSPACE);

    expect(await serverSyncSays(id)).toBe('synced');
  });
});

describe('a project both sides have changed', () => {
  /**
   * Server Sync is the place a conflict gets resolved, and Push there means "keep my copy". It used
   * to be refused by the same optimistic-concurrency check that protects background syncs, so a
   * conflict could only ever be resolved in the server's favour, by pulling.
   */
  async function makeConflicted(name: string) {
    const id = await createAndPush(name);

    // Local moves on.
    vi.setSystemTime(EDITED_AT);
    const local = await vfs.getProject(id);
    local!.name = `${name} (local)`;
    await vfs.updateProject(local!);
    saveManager.markClean(id);

    // ...and so does the server, from another device.
    const onServer = await adapter.getProject(id);
    await adapter.updateProject({
      ...onServer,
      name: `${name} (server)`,
      updatedAt: new Date('2026-07-31T10:00:15.000Z'),
    } as never);
    adapter.bumpRevision(id, onServer!.revision ?? 0);

    return id;
  }

  it('is reported as a conflict', async () => {
    const id = await makeConflicted('Contested');

    expect(await serverSyncSays(id)).toBe('conflict');
  });

  it('still refuses a background push, which must not pick a side', async () => {
    const id = await makeConflicted('Contested');
    const project = await vfs.getProject(id);
    const files = await vfs.listFiles(id);

    const result = await getSyncManager(WORKSPACE).pushSingleProject(id, project!, files);

    expect(result.success).toBe(false);
    expect(result.error).toBe('conflict');
  });

  it('settles as synced when the user pushes from Server Sync', async () => {
    const id = await makeConflicted('Contested');
    const project = await vfs.getProject(id);
    const files = await vfs.listFiles(id);

    // Exactly what components/project-manager/sync-tabs/projects-tab.tsx does on Push.
    const latest = await adapter.getProject(id);
    project!.revision = latest!.revision;
    const result = await getSyncManager(WORKSPACE).pushSingleProject(id, project!, files);
    expect(result.success).toBe(true);
    project!.lastSyncedAt = new Date();
    project!.serverUpdatedAt = result.project?.updatedAt
      ? new Date(result.project.updatedAt)
      : new Date();
    if (typeof result.project?.revision === 'number') {
      project!.revision = result.project.revision;
    }
    await vfs.updateProject(project!, { preserveUpdatedAt: true });

    expect(await serverSyncSays(id)).toBe('synced');
    // The local copy is the one that survived.
    expect((await adapter.getProject(id))!.name).toBe('Contested (local)');
  });
});

describe('a genuine local edit', () => {
  it('is reported as drift and then settles once reconciled', async () => {
    const id = await createAndPush('Edited');

    vi.setSystemTime(EDITED_AT);
    const project = await vfs.getProject(id);
    project!.name = 'Edited later';
    await vfs.updateProject(project!);
    saveManager.markClean(id);

    expect(await serverSyncSays(id)).toBe('local-newer');

    await reconcileProjectsToServer(WORKSPACE);

    expect(await serverSyncSays(id)).toBe('synced');
  });
});

/**
 * A restore changes the files, so the server has to end up with them too. A server run starts from
 * the server's copy and a page load pulls it when it reads as newer, so a restore that stays in
 * this browser is undone by the next run or reload.
 */
describe('a restore', () => {
  const SAVED = '<h1>hi</h1>';
  const LATER = '<h1>edited after the save</h1>';
  const serverHas = async (id: string) => (await adapter.getFile(id, '/index.html'))?.content;

  async function saveThenEdit(name: string) {
    const id = await createAndPush(name);
    vi.setSystemTime(new Date('2026-07-31T10:00:20.000Z'));
    await saveManager.save(id);
    await vfs.flushSyncTimeout(id);
    vi.setSystemTime(new Date('2026-07-31T10:00:30.000Z'));
    await vfs.updateFile(id, '/index.html', LATER);
    await autoSyncProject(id, false);
    expect(await serverHas(id)).toBe(LATER);
    vi.setSystemTime(new Date('2026-07-31T10:00:40.000Z'));
    return id;
  }

  it('Discard sends the saved files to the server before a run starts', async () => {
    const id = await saveThenEdit('Discarded');

    expect(await saveManager.restoreLastSaved(id)).toBe(true);
    // What a server run does before it starts.
    await vfs.flushSyncTimeout(id);

    expect((await vfs.readFile(id, '/index.html')).content).toBe(SAVED);
    expect(await serverHas(id)).toBe(SAVED);
  });

  it('Discard leaves the project reading as saved, and a reload pulls nothing back', async () => {
    const id = await saveThenEdit('Discarded clean');

    await saveManager.restoreLastSaved(id);
    await vfs.flushSyncTimeout(id);

    // The workspace's own test on open: changed since the save means unsaved.
    const project = (await vfs.getProject(id))!;
    expect(new Date(project.updatedAt).getTime()).toBeLessThanOrEqual(new Date(project.lastSavedAt!).getTime());
    const { checkServerUpdates } = await import('../auto-sync');
    expect(await checkServerUpdates(id)).toBe(false);
    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('restoring an earlier checkpoint sends its files to the server', async () => {
    const id = await createAndPush('Restored');
    const { checkpointManager } = await import('../checkpoint');
    const before = await checkpointManager.createCheckpoint(id, 'before the edit');
    vi.setSystemTime(new Date('2026-07-31T10:00:30.000Z'));
    await vfs.updateFile(id, '/index.html', LATER);
    await autoSyncProject(id, false);

    vi.setSystemTime(new Date('2026-07-31T10:00:40.000Z'));
    await saveManager.runWithSuppressedDirty(id, () => checkpointManager.restoreCheckpoint(before.id));
    await vfs.flushSyncTimeout(id);

    expect(await serverHas(id)).toBe(SAVED);
  });

  it('is still sent after a failed push, because it reads as a local change', async () => {
    const id = await saveThenEdit('Offline');

    await saveManager.restoreLastSaved(id);

    expect(await serverSyncSays(id)).toBe('local-newer');
  });
});
