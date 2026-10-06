import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { calculateItemSyncStatus } from '../sync-types';

/**
 * What an interrupted download leaves behind, and whether the app recovers on its own.
 *
 * Runs against the real VirtualFileSystem over a real (fake) IndexedDB — only the network and the
 * push helper are stubbed. Mocking the VFS here would defeat the point: the whole question is what
 * is actually persisted when a pull dies half-way.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), pushProjectToServer: vi.fn() }));

vi.mock('@/lib/api/backend-status', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/vfs/push-project-to-server', () => ({ pushProjectToServer: mocks.pushProjectToServer }));
vi.mock('@/lib/vfs/sync-events', () => ({
  notifyServerProjectsChanged: vi.fn(),
  SERVER_PROJECTS_CHANGED: 'serverProjectsChanged',
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { vfs } from '../index';
import { saveManager } from '../save-manager';
// Imported statically, NOT via vi.resetModules(): a reset registry hands auto-sync its own vfs
// singleton, so spies installed here would never fire and every assertion would pass vacuously.
import {
  pullServerUpdates,
  reconcileProjectsToServer,
  invalidateSyncStatusCache,
} from '../auto-sync';

const LOCAL_EDIT = new Date('2026-07-30T10:00:00.000Z');
const LAST_SYNC = new Date('2026-07-30T10:00:05.000Z');
const SERVER_MOVED = new Date('2026-07-30T11:00:00.000Z');

let projectId: string;

/** The server has moved ahead and holds two files; the local copy has one, older. */
function serverIsAhead(onFetch?: (url: string) => unknown) {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (onFetch) {
      const custom = onFetch(url);
      if (custom) return custom;
    }
    if (url.includes('/sync/status')) {
      return { ok: true, json: async () => ({ projects: [{ id: projectId, name: 'P', updatedAt: SERVER_MOVED.toISOString() }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        project: {
          id: projectId, name: 'Renamed On Server', description: 'from server',
          updatedAt: SERVER_MOVED.toISOString(),
          lastSyncedAt: SERVER_MOVED.toISOString(),
          serverUpdatedAt: SERVER_MOVED.toISOString(),
          settings: { runtime: 'static' },
        },
        files: [
          { path: '/index.html', content: '<h1>server</h1>' },
          { path: '/added.html', content: '<h1>added</h1>' },
        ],
      }),
    };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  invalidateSyncStatusCache();
  await vfs.init();

  const project = await vfs.createProject('Local Name', 'local');
  projectId = project.id;
  await vfs.createFile(projectId, '/index.html', '<h1>local</h1>');

  // Creating a file marks the project dirty, and the reconcile deliberately skips dirty
  // projects — leaving it set would mask the behaviour under test rather than exercise it.
  saveManager.markClean(projectId);

  const stored = await vfs.getProject(projectId);
  stored.updatedAt = LOCAL_EDIT;
  stored.lastSyncedAt = LAST_SYNC;
  stored.serverUpdatedAt = LOCAL_EDIT;
  await vfs.updateProject(stored, { preserveUpdatedAt: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a pull that dies half-way', () => {
  it('leaves the project record untouched so the pull will be retried', async () => {
    serverIsAhead();
    // The second file write fails — a full disk, a closed tab.
    vi.spyOn(vfs, 'createFile').mockRejectedValueOnce(new Error('QuotaExceededError'));

    const ok = await pullServerUpdates(projectId, false);
    expect(ok).toBe(false);

    const after = await vfs.getProject(projectId);
    // Nothing about the record was committed: not the server's name, not its timestamps.
    expect(after.name).toBe('Local Name');
    expect(after.updatedAt.getTime()).toBe(LOCAL_EDIT.getTime());
    expect(after.lastSyncedAt!.getTime()).toBe(LAST_SYNC.getTime());

    // So it still reads as the server being ahead, and the next auto-pull retries it.
    expect(
      calculateItemSyncStatus(after.updatedAt, SERVER_MOVED, after.lastSyncedAt)
    ).toBe('server-newer');
  });

  it('is never pushed by the background reconcile', async () => {
    serverIsAhead();
    vi.spyOn(vfs, 'createFile').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await pullServerUpdates(projectId, false);

    await reconcileProjectsToServer('w1');

    // Pushing a half-pulled copy would delete the server's copy of everything it had not written.
    expect(mocks.pushProjectToServer).not.toHaveBeenCalled();

    // Asserted via the mechanism, not just the outcome: it is skipped because it still reads as
    // server-newer. Checking only "was not pushed" would also pass if it were wrongly reported as
    // already in sync — the failure mode this exists to catch.
    const after = await vfs.getProject(projectId);
    expect(
      calculateItemSyncStatus(after.updatedAt, SERVER_MOVED, after.lastSyncedAt)
    ).toBe('server-newer');
  });

  it('recovers completely when the pull is retried', async () => {
    serverIsAhead();
    vi.spyOn(vfs, 'createFile').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await pullServerUpdates(projectId, false);

    vi.restoreAllMocks();
    serverIsAhead();
    const ok = await pullServerUpdates(projectId, false);

    expect(ok).toBe(true);
    const after = await vfs.getProject(projectId);
    expect(after.name).toBe('Renamed On Server');
    expect(after.updatedAt.getTime()).toBe(SERVER_MOVED.getTime());
    expect(calculateItemSyncStatus(after.updatedAt, SERVER_MOVED, after.lastSyncedAt)).toBe('synced');
    const files = await vfs.listFiles(projectId);
    expect(files.map((f) => f.path).sort()).toEqual(['/added.html', '/index.html']);
  });
});

describe('a pull whose server snapshot has no files', () => {
  it('does not delete the local tree', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/sync/status')) {
        return { ok: true, json: async () => ({ projects: [{ id: projectId, name: 'P', updatedAt: SERVER_MOVED.toISOString() }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          project: {
            id: projectId, name: 'Renamed On Server', description: 'from server',
            updatedAt: SERVER_MOVED.toISOString(),
            lastSyncedAt: SERVER_MOVED.toISOString(),
            serverUpdatedAt: SERVER_MOVED.toISOString(),
            settings: { runtime: 'static' },
          },
          files: [],
        }),
      };
    });

    expect(await pullServerUpdates(projectId, false)).toBe(true);
    const files = await vfs.listFiles(projectId);
    expect(files.map((f) => f.path)).toEqual(['/index.html']);
    expect(await vfs.readFile(projectId, '/index.html').then((f) => f.content)).toBe('<h1>local</h1>');
  });

  it('does not delete a local-only file when the working copy has unacked edits', async () => {
    const stored = await vfs.getProject(projectId);
    stored.updatedAt = SERVER_MOVED;
    stored.lastSyncedAt = LAST_SYNC;
    await vfs.updateProject(stored, { preserveUpdatedAt: true });
    await vfs.createFile(projectId, '/v2-browser.txt', 'V2_BROWSER');
    saveManager.markClean(projectId);

    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/sync/status')) {
        return { ok: true, json: async () => ({ projects: [{ id: projectId, name: 'P', updatedAt: SERVER_MOVED.toISOString() }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          project: {
            id: projectId, name: 'P', description: '',
            updatedAt: SERVER_MOVED.toISOString(),
            settings: { runtime: 'static' },
          },
          files: [
            { path: '/index.html', content: '<h1>server</h1>' },
            { path: '/v2-mcp.txt', content: 'V2_MCP' },
          ],
        }),
      };
    });

    expect(await pullServerUpdates(projectId, false)).toBe(false);
    const paths = (await vfs.listFiles(projectId)).map((f) => f.path).sort();
    expect(paths).toContain('/v2-browser.txt');
    expect(await vfs.readFile(projectId, '/v2-browser.txt').then((f) => f.content)).toBe('V2_BROWSER');
  });
});

describe('a push that failed', () => {
  // The opposite case, and the one the old flag conflated with the above: the local copy is
  // complete and correct, the server was simply unreachable. The reconcile exists to retry this.
  it('is retried by the background reconcile', async () => {

    const stored = await vfs.getProject(projectId);
    stored.syncStatus = 'error';           // what autoSyncProject writes when retries are exhausted
    stored.updatedAt = SERVER_MOVED;       // local work the server has not got
    await vfs.updateProject(stored, { preserveUpdatedAt: true });

    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/sync/status')) {
        return { ok: true, json: async () => ({ projects: [{ id: projectId, name: 'P', updatedAt: LOCAL_EDIT.toISOString() }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    mocks.pushProjectToServer.mockResolvedValue(undefined);

    await reconcileProjectsToServer('w1');

    expect(mocks.pushProjectToServer).toHaveBeenCalledWith(projectId, 'w1', expect.anything());
  });
});

describe('pulling a project that does not exist locally', () => {
  // autoPullAllProjects used to carry its own copy of the pull for this case, which is why the
  // premature-commit bug survived in it after being fixed in pullServerUpdates. Both go through
  // one path now.
  // A distinct id per test: fake-indexeddb persists across tests in a file, so a shared id would
  // already exist by the second one and silently exercise the update path instead.
  let NEW_ID: string;
  beforeEach(() => { NEW_ID = `brand-new-${Math.random().toString(36).slice(2)}`; });

  function serverHasNewProject() {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/sync/status')) {
        return { ok: true, json: async () => ({ projects: [{ id: NEW_ID, name: 'New', updatedAt: SERVER_MOVED.toISOString() }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          project: {
            id: NEW_ID, name: 'From Server', description: 'new',
            updatedAt: SERVER_MOVED.toISOString(),
            settings: { runtime: 'static' },
          },
          files: [
            { path: '/index.html', content: '<h1>one</h1>' },
            { path: '/two.html', content: '<h1>two</h1>' },
          ],
        }),
      };
    });
  }

  it('creates it with all of its files', async () => {
    serverHasNewProject();

    const ok = await pullServerUpdates(NEW_ID, false);

    expect(ok).toBe(true);
    const created = await vfs.getProject(NEW_ID);
    expect(created.name).toBe('From Server');
    expect(created.settings.runtime).toBe('static');
    const files = await vfs.listFiles(NEW_ID);
    expect(files.map((f) => f.path).sort()).toEqual(['/index.html', '/two.html']);
  });

  it('leaves nothing behind when the pull fails part-way', async () => {
    serverHasNewProject();
    vi.spyOn(vfs, 'createFile').mockRejectedValueOnce(new Error('QuotaExceededError'));

    const ok = await pullServerUpdates(NEW_ID, false);
    expect(ok).toBe(false);

    // A half-created shell would read as local-newer against the server and be pushed over the
    // server's real copy on the next reconcile.
    await expect(vfs.getProject(NEW_ID)).rejects.toThrow();
    const all = await vfs.listProjects();
    expect(all.map((p) => p.id)).not.toContain(NEW_ID);
  });
});


describe('the snapshot a pull takes first', () => {
  it('is labelled, so the checkpoint panel can word it in the viewer\'s language', async () => {
    serverIsAhead();
    expect(await pullServerUpdates(projectId, false)).toBe(true);

    const { checkpointManager } = await import('../checkpoint');
    const listed = await checkpointManager.getCheckpoints(projectId);
    const snapshot = listed.find((cp) => cp.description === 'Pre-sync backup (before pull)');
    expect(snapshot?.label).toEqual({ key: 'preSyncPull' });
  });
});
