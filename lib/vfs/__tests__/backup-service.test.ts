// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import JSZip from 'jszip';
import { IndexedDBAdapter } from '../adapters/indexeddb-adapter';

/**
 * Exercises the real .osws backup path against a real (fake) IndexedDB.
 *
 * The backup service used to open a hardcoded database name at a hardcoded version instead of the
 * one the app actually uses. Outside browser mode the live database is workspace-scoped, so import
 * wrote everything into an unrelated database, reported success, and reloaded to unchanged data.
 */

// The live database in server/hosted/desktop mode is named after the workspace, never the default.
const WORKSPACE_DB = 'osw-studio-11111111-2222-3333-4444-555555555555';
const DEFAULT_DB = 'osw-studio-db';

let adapter: IndexedDBAdapter;

const mocks = vi.hoisted(() => ({ getDatabase: vi.fn(), init: vi.fn() }));
vi.mock('@/lib/vfs', () => ({ vfs: { init: mocks.init, getDatabase: mocks.getDatabase } }));
vi.mock('@/lib/utils', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { BackupService } from '../backup-service';

async function readStore(db: IDBDatabase, store: string): Promise<any[]> {
  if (!db.objectStoreNames.contains(store)) return [];
  return new Promise((resolve, reject) => {
    const request = db.transaction([store], 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction([store], 'readwrite').objectStore(store).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Does a database exist at all? Used to prove nothing writes to a stray one. */
async function databaseExists(name: string): Promise<boolean> {
  const databases = await indexedDB.databases();
  return databases.some((entry) => entry.name === name);
}

async function makeBackupFile(vfsData: Record<string, unknown[]>): Promise<File> {
  const backup = {
    version: '1.9.0',
    exportDate: new Date().toISOString(),
    databases: { vfs: vfsData, conversations: [], checkpoints: [] },
    metadata: { projectCount: (vfsData.projects || []).length, totalSize: 0, exportedFrom: 'oswstudio' },
  };
  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify(backup));
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'backup.osws');
}

function project(id: string, name: string) {
  return { id, name, createdAt: new Date(), updatedAt: new Date(), settings: {} };
}

beforeEach(async () => {
  // Fresh IndexedDB per test so a leftover default database can't mask the bug.
  globalThis.indexedDB = new IDBFactory();
  vi.clearAllMocks();

  adapter = new IndexedDBAdapter(WORKSPACE_DB);
  await adapter.init();
  mocks.init.mockResolvedValue(undefined);
  mocks.getDatabase.mockImplementation(() => adapter.getDatabase());

  // jsdom has no object-URL support; export's download step needs it.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await adapter.close();
});

describe('.osws import', () => {
  it('restores into the live workspace database, not a hardcoded one', async () => {
    const file = await makeBackupFile({ projects: [project('p1', 'Restored')], files: [], fileTree: [] });

    await BackupService.importAllData(file, { mode: 'merge' });

    const live = await readStore(adapter.getDatabase(), 'projects');
    expect(live.map((p) => p.id)).toEqual(['p1']);
    // The old code created and wrote to this one instead.
    expect(await databaseExists(DEFAULT_DB)).toBe(false);
  });

  // The stamps in a backup describe a sync to whichever instance it was taken from. Kept, they are
  // read as this server's history and the record reports drift that cannot be resolved.
  it('drops the sync stamps a backup carries in, for every store that tracks them', async () => {
    const stamped = {
      lastSyncedAt: new Date('2026-06-30T21:09:25.571Z'),
      serverUpdatedAt: new Date('2026-06-30T21:09:25.571Z'),
    };
    const file = await makeBackupFile({
      projects: [{ ...project('p1', 'Restored'), ...stamped, syncStatus: 'synced' }],
      skills: [{ id: 's1', name: 'Restored skill', updatedAt: new Date(), ...stamped }],
      files: [],
      fileTree: [],
    });

    await BackupService.importAllData(file, { mode: 'merge' });

    for (const store of ['projects', 'skills']) {
      const [record] = await readStore(adapter.getDatabase(), store);
      expect(record, `${store} record was not restored`).toBeDefined();
      expect(record.lastSyncedAt, `${store}.lastSyncedAt`).toBeUndefined();
      expect(record.serverUpdatedAt, `${store}.serverUpdatedAt`).toBeUndefined();
      expect(record.syncStatus, `${store}.syncStatus`).toBeUndefined();
    }
  });

  it('keeps everything else on the restored record', async () => {
    const file = await makeBackupFile({
      projects: [
        {
          ...project('p1', 'Restored'),
          lastSyncedAt: new Date('2026-06-30T21:09:25.571Z'),
          description: 'kept',
        },
      ],
      files: [],
      fileTree: [],
    });

    await BackupService.importAllData(file, { mode: 'merge' });

    const [restored] = await readStore(adapter.getDatabase(), 'projects');
    expect(restored.id).toBe('p1');
    expect(restored.name).toBe('Restored');
    expect(restored.description).toBe('kept');
  });

  it('merges into existing data without dropping it', async () => {
    await put(adapter.getDatabase(), 'projects', project('existing', 'Existing'));
    const file = await makeBackupFile({ projects: [project('p1', 'Restored')], files: [], fileTree: [] });

    await BackupService.importAllData(file, { mode: 'merge' });

    const live = await readStore(adapter.getDatabase(), 'projects');
    expect(live.map((p) => p.id).sort()).toEqual(['existing', 'p1']);
  });

  it('replace mode clears the live database first', async () => {
    await put(adapter.getDatabase(), 'projects', project('existing', 'Existing'));
    await put(adapter.getDatabase(), 'skills', { id: 'skill-1', name: 'Old skill' });
    const file = await makeBackupFile({ projects: [project('p1', 'Restored')], files: [], fileTree: [] });

    await BackupService.importAllData(file, { mode: 'replace' });

    const live = await readStore(adapter.getDatabase(), 'projects');
    expect(live.map((p) => p.id)).toEqual(['p1']);
    // Stores absent from the backup are emptied too — "replace" means replace.
    expect(await readStore(adapter.getDatabase(), 'skills')).toEqual([]);
  });

  // The import dialog words each stage itself, so the stages are the contract, in order.
  it('reports its stages in order, clearing only in replace mode', async () => {
    const file = await makeBackupFile({ projects: [project('p1', 'Restored')], files: [], fileTree: [] });
    const replace: Array<[number, string]> = [];
    await BackupService.importAllData(file, { mode: 'replace', onProgress: (p, stage) => replace.push([p, stage]) });
    expect(replace).toEqual([[10, 'reading'], [30, 'validating'], [40, 'clearing'], [50, 'importing'], [100, 'done']]);

    const merge: string[] = [];
    await BackupService.importAllData(file, { mode: 'merge', onProgress: (_p, stage) => merge.push(stage) });
    expect(merge).toEqual(['reading', 'validating', 'importing', 'done']);
  });

  it('refuses a backup from a newer major version and writes nothing', async () => {
    const zip = new JSZip();
    zip.file('backup.json', JSON.stringify({
      version: '99.0.0',
      exportDate: new Date().toISOString(),
      databases: { vfs: { projects: [project('p1', 'Future')] }, conversations: [], checkpoints: [] },
      metadata: { projectCount: 1, totalSize: 0, exportedFrom: 'oswstudio' },
    }));
    const file = new File([await zip.generateAsync({ type: 'blob' })], 'backup.osws');

    await expect(BackupService.importAllData(file, { mode: 'merge' })).rejects.toThrow();
    expect(await readStore(adapter.getDatabase(), 'projects')).toEqual([]);
  });

  it('turns away a file that is not a backup before reading it in', async () => {
    const good = await makeBackupFile({ projects: [], files: [], fileTree: [] });
    expect((await BackupService.validateBackupFile(new File([good], 'backup.zip'))).valid).toBe(false);
    const zip = new JSZip();
    zip.file('other.json', '{}');
    const noManifest = new File([await zip.generateAsync({ type: 'blob' })], 'backup.osws');
    expect((await BackupService.validateBackupFile(noManifest)).valid).toBe(false);
    expect((await BackupService.validateBackupFile(good)).valid).toBe(true);
  });

  it('restores stores beyond the original five', async () => {
    const file = await makeBackupFile({
      projects: [project('p1', 'Restored')],
      files: [],
      fileTree: [],
      customTemplates: [{ id: 't1', name: 'My template' }],
      skills: [{ id: 's1', name: 'My skill' }],
      secrets: [{ id: 'sec1', projectId: 'p1', key: 'API_KEY' }],
    });

    await BackupService.importAllData(file, { mode: 'merge' });

    expect(await readStore(adapter.getDatabase(), 'customTemplates')).toHaveLength(1);
    expect(await readStore(adapter.getDatabase(), 'skills')).toHaveLength(1);
    expect(await readStore(adapter.getDatabase(), 'secrets')).toHaveLength(1);
  });

  it('ignores keys that are not object stores in this schema', async () => {
    const file = await makeBackupFile({
      projects: [project('p1', 'Restored')],
      files: [],
      fileTree: [],
      somethingFromAFutureVersion: [{ id: 'x' }],
    });

    await expect(BackupService.importAllData(file, { mode: 'merge' })).resolves.toBeUndefined();
    expect(await readStore(adapter.getDatabase(), 'projects')).toHaveLength(1);
  });
});

describe('.osws export', () => {
  it('reads from the live workspace database', async () => {
    await put(adapter.getDatabase(), 'projects', project('p1', 'Mine'));
    await put(adapter.getDatabase(), 'skills', { id: 's1', name: 'My skill' });

    const captured = vi.spyOn(JSZip.prototype, 'file');
    await BackupService.exportAllData();

    const json = JSON.parse(captured.mock.calls[0][1] as unknown as string);
    expect(json.databases.vfs.projects.map((p: any) => p.id)).toEqual(['p1']);
    // Everything in the schema is backed up, not just the original five stores.
    expect(json.databases.vfs.skills).toHaveLength(1);
    expect(json.metadata.projectCount).toBe(1);
    captured.mockRestore();
  });

  it('round-trips binary file content', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 250]);
    await put(adapter.getDatabase(), 'projects', project('p1', 'Mine'));
    await put(adapter.getDatabase(), 'files', {
      id: 'f1',
      projectId: 'p1',
      path: '/logo.png',
      content: pngBytes.buffer,
      updatedAt: new Date(),
    });

    const captured = vi.spyOn(JSZip.prototype, 'file');
    await BackupService.exportAllData();
    const json = captured.mock.calls[0][1] as unknown as string;
    captured.mockRestore();

    // JSON.stringify turns an ArrayBuffer into {}, so the export has to encode it.
    const parsed = JSON.parse(json);
    expect(parsed.databases.vfs.files[0].content).not.toEqual({});

    const file = await makeBackupFile(parsed.databases.vfs);
    await BackupService.importAllData(file, { mode: 'replace' });

    const [restored] = await readStore(adapter.getDatabase(), 'files');
    // Tag check, not instanceof: a structured clone out of IndexedDB can carry a constructor from
    // another realm, which is the same trap the encoder itself has to avoid.
    expect(Object.prototype.toString.call(restored.content)).toBe('[object ArrayBuffer]');
    expect(Array.from(new Uint8Array(restored.content))).toEqual(Array.from(pngBytes));
  });
});
