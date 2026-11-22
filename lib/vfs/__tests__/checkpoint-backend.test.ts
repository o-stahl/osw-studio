/**
 * Backend coverage for checkpoints: the records and settings that are not files.
 *
 * The adapter here is a real in-memory implementation rather than a spy set, because what is
 * under test is the diff — which records a restore deletes, creates, updates or leaves alone —
 * and that only shows up in the state the adapter is left holding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { EdgeFunction, Project, ScheduledFunction, Secret, ServerFunction } from '../types';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DB_NAME = 'osw-studio-test';
let testDb: IDBDatabase;

async function openTestDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('checkpoints')) {
        const store = db.createObjectStore('checkpoints', { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── In-memory storage adapter ──────────────────────────────────────────

let edgeFunctions: EdgeFunction[] = [];
let serverFunctions: ServerFunction[] = [];
let secrets: Secret[] = [];
let scheduledFunctions: ScheduledFunction[] = [];
let project: Project;

function collection<T extends { id: string; projectId: string }>(get: () => T[], set: (v: T[]) => void) {
  return {
    list: async (projectId: string) => get().filter(r => r.projectId === projectId).map(r => ({ ...r })),
    create: async (record: T) => { set([...get(), { ...record }]); },
    update: async (record: T) => { set(get().map(r => (r.id === record.id ? { ...record } : r))); },
    remove: async (id: string) => { set(get().filter(r => r.id !== id)); },
  };
}

const edge = collection<EdgeFunction>(() => edgeFunctions, v => { edgeFunctions = v; });
const server = collection<ServerFunction>(() => serverFunctions, v => { serverFunctions = v; });
const secret = collection<Secret>(() => secrets, v => { secrets = v; });
const scheduled = collection<ScheduledFunction>(() => scheduledFunctions, v => { scheduledFunctions = v; });

const adapter = {
  listEdgeFunctions: edge.list,
  createEdgeFunction: edge.create,
  updateEdgeFunction: edge.update,
  deleteEdgeFunction: edge.remove,
  listServerFunctions: server.list,
  createServerFunction: server.create,
  updateServerFunction: server.update,
  deleteServerFunction: server.remove,
  listSecrets: secret.list,
  createSecret: secret.create,
  updateSecret: secret.update,
  deleteSecret: secret.remove,
  listScheduledFunctions: scheduled.list,
  createScheduledFunction: scheduled.create,
  updateScheduledFunction: scheduled.update,
  deleteScheduledFunction: scheduled.remove,
};

const updateProject = vi.fn(async (next: Project) => { project = { ...next }; });

const mockVfs = {
  init: vi.fn().mockResolvedValue(undefined),
  getDatabase: () => testDb,
  getStorageAdapter: () => adapter,
  getProject: async () => ({ ...project, settings: { ...project.settings } }),
  updateProject,
  listDirectory: async () => [],
  readFile: async () => { throw new Error('not used'); },
  deleteFile: vi.fn(),
  deleteDirectory: vi.fn(),
  createDirectory: vi.fn(),
  createFile: vi.fn(),
  updateFile: vi.fn(),
  scheduleAutoSync: vi.fn(),
};

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => mockVfs,
  vfs: mockVfs,
}));

vi.mock('@/lib/vfs/adapters/indexeddb-adapter', () => ({ IndexedDBAdapter: class {} }));

// ── Fixtures ───────────────────────────────────────────────────────────

const T = new Date('2026-01-01T00:00:00.000Z');
const PROJECT_ID = 'proj1';

function anEdgeFunction(over: Partial<EdgeFunction> = {}): EdgeFunction {
  return {
    id: 'edge-1', projectId: PROJECT_ID, name: 'products', code: 'return 1;',
    method: 'GET', enabled: true, timeoutMs: 5000, createdAt: T, updatedAt: T, ...over,
  };
}

function aServerFunction(over: Partial<ServerFunction> = {}): ServerFunction {
  return {
    id: 'srv-1', projectId: PROJECT_ID, name: 'formatPrice', code: 'return args.n;',
    enabled: true, createdAt: T, updatedAt: T, ...over,
  };
}

function aSecret(over: Partial<Secret> = {}): Secret {
  return {
    id: 'sec-1', projectId: PROJECT_ID, name: 'STRIPE_KEY', hasValue: true,
    value: 'sk_live_abc', createdAt: T, updatedAt: T, ...over,
  };
}

function aSchedule(over: Partial<ScheduledFunction> = {}): ScheduledFunction {
  return {
    id: 'sch-1', projectId: PROJECT_ID, name: 'nightly', functionId: 'edge-1',
    cronExpression: '0 8 * * *', timezone: 'UTC', config: {}, enabled: true,
    createdAt: T, updatedAt: T, ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('checkpoint backend coverage', () => {
  let checkpointManager: Awaited<typeof import('../checkpoint')>['checkpointManager'];

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    testDb = await openTestDB();

    edgeFunctions = [];
    serverFunctions = [];
    secrets = [];
    scheduledFunctions = [];
    project = {
      id: PROJECT_ID, name: 'Test', createdAt: T, updatedAt: T,
      settings: { runtime: 'static', previewEntryPoint: '/index.html' },
    };
    updateProject.mockClear();

    vi.resetModules();
    checkpointManager = (await import('../checkpoint')).checkpointManager;
  });

  afterEach(() => { if (testDb) testDb.close(); });

  describe('edge and server functions', () => {
    it('restores code the AI rewrote after the checkpoint', async () => {
      edgeFunctions = [anEdgeFunction({ code: 'return "original";' })];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before turn');

      edgeFunctions = [anEdgeFunction({ code: 'return "rewritten";', updatedAt: new Date('2026-02-01') })];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(edgeFunctions).toHaveLength(1);
      expect(edgeFunctions[0].code).toBe('return "original";');
    });

    it('deletes a function created after the checkpoint', async () => {
      edgeFunctions = [anEdgeFunction()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before turn');

      edgeFunctions = [anEdgeFunction(), anEdgeFunction({ id: 'edge-2', name: 'orders' })];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(edgeFunctions.map(f => f.id)).toEqual(['edge-1']);
    });

    it('brings back a function deleted after the checkpoint', async () => {
      serverFunctions = [aServerFunction()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before delete');

      serverFunctions = [];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(serverFunctions).toHaveLength(1);
      expect(serverFunctions[0].name).toBe('formatPrice');
      expect(serverFunctions[0].createdAt).toBeInstanceOf(Date);
    });

    it('leaves an unchanged record untouched', async () => {
      edgeFunctions = [anEdgeFunction()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');

      const updateSpy = vi.spyOn(adapter, 'updateEdgeFunction');
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(updateSpy).not.toHaveBeenCalled();
      updateSpy.mockRestore();
    });
  });

  describe('schedules', () => {
    it('removes a schedule before the edge function it points at', async () => {
      // Nothing at the checkpoint, so both records added afterwards come out on restore. A
      // schedule's functionId is a foreign key: deleting the edge function first would leave it
      // dangling for the length of the restore.
      const empty = await checkpointManager.createCheckpoint(PROJECT_ID, 'No backend yet');

      edgeFunctions = [anEdgeFunction()];
      scheduledFunctions = [aSchedule()];

      const order: string[] = [];
      const deleteEdge = vi.spyOn(adapter, 'deleteEdgeFunction')
        .mockImplementation(async id => { order.push('edge'); edgeFunctions = edgeFunctions.filter(f => f.id !== id); });
      const deleteSchedule = vi.spyOn(adapter, 'deleteScheduledFunction')
        .mockImplementation(async id => { order.push('schedule'); scheduledFunctions = scheduledFunctions.filter(f => f.id !== id); });

      await checkpointManager.restoreCheckpoint(empty.id);

      expect(order).toEqual(['schedule', 'edge']);
      expect(scheduledFunctions).toEqual([]);
      expect(edgeFunctions).toEqual([]);
      deleteEdge.mockRestore();
      deleteSchedule.mockRestore();
    });
  });

  describe('secrets', () => {
    it('never writes a value into the checkpoint', async () => {
      secrets = [aSecret()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');

      const stored = JSON.stringify(cp.backend);
      expect(stored).toContain('STRIPE_KEY');
      expect(stored).not.toContain('sk_live_abc');
    });

    it('keeps the project\'s stored value when the secret still exists', async () => {
      secrets = [aSecret({ name: 'STRIPE_KEY' })];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before rename');

      secrets = [aSecret({ name: 'STRIPE_LIVE_KEY', value: 'sk_live_abc' })];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].name).toBe('STRIPE_KEY');
      expect(secrets[0].value).toBe('sk_live_abc');
      expect(secrets[0].hasValue).toBe(true);
    });

    it('brings a deleted secret back as an empty placeholder', async () => {
      secrets = [aSecret()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before delete');

      secrets = [];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].name).toBe('STRIPE_KEY');
      expect(secrets[0].value).toBeUndefined();
      expect(secrets[0].hasValue).toBe(false);
    });

    it('removes a secret added after the checkpoint', async () => {
      secrets = [];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before add');

      secrets = [aSecret()];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(secrets).toEqual([]);
    });
  });

  describe('previewRestore', () => {
    it('names a secret whose stored value the restore would destroy', async () => {
      secrets = [];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before add');

      secrets = [aSecret({ name: 'SENDGRID_KEY' })];
      const preview = await checkpointManager.previewRestore(cp.id);

      expect(preview?.secretsDropped).toEqual(['SENDGRID_KEY']);
      expect(preview?.secretsCleared).toEqual([]);
    });

    it('names a secret that would come back empty', async () => {
      secrets = [aSecret({ name: 'SENDGRID_KEY' })];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before delete');

      secrets = [];
      const preview = await checkpointManager.previewRestore(cp.id);

      expect(preview?.secretsCleared).toEqual(['SENDGRID_KEY']);
      expect(preview?.secretsDropped).toEqual([]);
    });

    it('reports nothing when a secret keeps its value across the restore', async () => {
      secrets = [aSecret()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');

      secrets = [aSecret({ name: 'RENAMED' })];
      const preview = await checkpointManager.previewRestore(cp.id);
      const { isEmptyPreview } = await import('../checkpoint');

      expect(preview).not.toBeNull();
      expect(isEmptyPreview(preview!)).toBe(true);
    });

    it('reports nothing for a placeholder that never held a value', async () => {
      secrets = [];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before add');

      secrets = [aSecret({ hasValue: false, value: undefined })];
      const preview = await checkpointManager.previewRestore(cp.id);

      expect(preview?.secretsDropped).toEqual([]);
    });
  });

  describe('project settings', () => {
    it('restores a runtime changed after the checkpoint', async () => {
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before runtime change');

      project = { ...project, settings: { ...project.settings, runtime: 'react' } };
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(project.settings.runtime).toBe('static');
    });

    it('restores a database schema edited after the checkpoint', async () => {
      project = { ...project, settings: { ...project.settings, databaseSchema: 'CREATE TABLE a (id INT);' } };
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before schema edit');

      project = { ...project, settings: { ...project.settings, databaseSchema: 'DROP TABLE a;' } };
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(project.settings.databaseSchema).toBe('CREATE TABLE a (id INT);');
    });

    it('clears a setting that did not exist at the checkpoint', async () => {
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before schema added');

      project = { ...project, settings: { ...project.settings, databaseSchema: 'CREATE TABLE a (id INT);' } };
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(project.settings.databaseSchema).toBeUndefined();
    });

    it('leaves the settings alone when no covered setting differs', async () => {
      const before = structuredClone(project.settings);
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');
      updateProject.mockClear();

      await checkpointManager.restoreCheckpoint(cp.id);

      // The restore is recorded as a change so it syncs; what it writes keeps the settings as they were.
      expect(updateProject).toHaveBeenCalled();
      for (const [written] of updateProject.mock.calls) expect(written.settings).toEqual(before);
    });

    it('leaves a runtime alone when the checkpoint carries none', async () => {
      // The contrast with 'clears a setting that did not exist at the checkpoint' above, and it is
      // deliberate: a project is never meant to have no runtime, so a snapshot without one does not
      // distinguish "had none" from "could not read one" -- and older snapshots are full of the
      // latter, because capture read `settings?.runtime` off settings stored as a JSON string.
      // Deleting on that answer is what made a selected runtime reset itself after an undo.
      project = { ...project, settings: {} };
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before a runtime was set');

      project = { ...project, settings: { ...project.settings, runtime: 'react' } };
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(project.settings.runtime).toBe('react');
    });

    it('does not restore a field outside the covered set', async () => {
      project = { ...project, name: 'Original' };
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Before rename');

      project = { ...project, name: 'Renamed', settings: { ...project.settings, runtime: 'react' } };
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(project.name).toBe('Renamed');
      expect(project.settings.runtime).toBe('static');
    });
  });

  describe('opting out', () => {
    it('leaves backend records alone when backend restore is off', async () => {
      edgeFunctions = [anEdgeFunction({ code: 'return "original";' })];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');

      edgeFunctions = [anEdgeFunction({ code: 'return "later";' })];
      await checkpointManager.restoreCheckpoint(cp.id, { backend: false });

      expect(edgeFunctions[0].code).toBe('return "later";');
    });

    it('opening a project does not roll its backend back to the last save', async () => {
      // Discard (restoreLastSaved) is files-only: the backend panel is reachable from the
      // gallery where there is no Save button. Restoring backend records would delete an
      // edge function added since the last save, and drop a secret created since.
      const saved = await checkpointManager.createCheckpoint(PROJECT_ID, 'Save', { kind: 'manual' });
      project = { ...project, lastSavedCheckpointId: saved.id };

      edgeFunctions = [anEdgeFunction({ name: 'added-after-saving' })];
      secrets = [aSecret({ name: 'ADDED_AFTER_SAVING' })];

      const { saveManager } = await import('../save-manager');
      expect(await saveManager.restoreLastSaved(PROJECT_ID)).toBe(true);

      expect(edgeFunctions.map(f => f.name)).toEqual(['added-after-saving']);
      expect(secrets[0].value).toBe('sk_live_abc');
    });
  });

  describe('checkpoints written before backend coverage', () => {
    it('leaves the project\'s backend alone rather than emptying it', async () => {
      // A checkpoint from an older version: same record shape, no `backend` key at all.
      const legacy = {
        id: 'cp_legacy_1',
        timestamp: new Date().toISOString(),
        description: 'Old checkpoint',
        projectId: PROJECT_ID,
        kind: 'manual' as const,
        pinned: false,
        baseRevisionId: null,
        files: [] as [string, string][],
        directories: [] as string[],
      };
      await new Promise<void>((resolve, reject) => {
        const req = testDb.transaction(['checkpoints'], 'readwrite').objectStore('checkpoints').put(legacy);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      edgeFunctions = [anEdgeFunction()];
      secrets = [aSecret()];

      const restored = await checkpointManager.restoreCheckpoint('cp_legacy_1');

      expect(restored).toBe(true);
      expect(edgeFunctions).toHaveLength(1);
      expect(secrets).toHaveLength(1);
      expect(secrets[0].value).toBe('sk_live_abc');
    });

    it('reports no preview to warn about', async () => {
      expect(await checkpointManager.previewRestore('cp_nonexistent')).toBeNull();
    });
  });

  describe('storage round-trip', () => {
    it('survives compression, and pinning does not drop the backend half', async () => {
      edgeFunctions = [anEdgeFunction({ code: 'x'.repeat(5000) })];
      secrets = [aSecret()];
      scheduledFunctions = [aSchedule()];
      const cp = await checkpointManager.createCheckpoint(PROJECT_ID, 'Snapshot');

      await checkpointManager.pinCheckpoint(cp.id);

      edgeFunctions = [];
      secrets = [];
      scheduledFunctions = [];
      await checkpointManager.restoreCheckpoint(cp.id);

      expect(edgeFunctions[0].code).toBe('x'.repeat(5000));
      expect(secrets[0].name).toBe('STRIPE_KEY');
      expect(scheduledFunctions[0].cronExpression).toBe('0 8 * * *');
    });
  });
});
