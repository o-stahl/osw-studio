import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBAdapter } from '../indexeddb-adapter';

/**
 * Deleting a project removes its checkpoints, chat and conversations, but only since 1.111.1. A
 * project deleted before that left them in the browser, where nothing reads them again: one
 * browser held 2.15 GB of checkpoints for projects that no longer existed.
 */

let adapter: IndexedDBAdapter;
let name: string;

function db(): IDBDatabase {
  return adapter.getDatabase();
}

function put(store: string, record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db().transaction(store, 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function keys(store: string): Promise<IDBValidKey[]> {
  return new Promise((resolve) => {
    const request = db().transaction(store).objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result);
  });
}

beforeEach(async () => {
  name = `osw-history-${Math.random().toString(36).slice(2)}`;
  adapter = new IndexedDBAdapter(name);
  await adapter.init();
  await put('projects', { id: 'kept', name: 'Kept', createdAt: new Date(), updatedAt: new Date() });
  for (const store of ['checkpoints', 'debugEvents', 'conversations']) {
    await put(store, { id: `${store}-kept`, projectId: 'kept', timestamp: '2026-11-01T00:00:00.000Z' });
    await put(store, { id: `${store}-gone-1`, projectId: 'gone', timestamp: '2026-11-01T00:00:00.000Z' });
    await put(store, { id: `${store}-gone-2`, projectId: 'gone', timestamp: '2026-11-02T00:00:00.000Z' });
  }
});

afterEach(() => {
  try { localStorage.removeItem(`osw-history-swept:${name}`); } catch { /* none in node */ }
});

describe('sweepOrphanedHistory', () => {
  it('removes the history of projects that no longer exist and keeps the rest', async () => {
    const removed = await adapter.sweepOrphanedHistory();

    expect(removed).toBe(6);
    for (const store of ['checkpoints', 'debugEvents', 'conversations']) {
      expect(await keys(store)).toEqual([`${store}-kept`]);
    }
  });

  it('keeps the history of a project that is there', async () => {
    await adapter.sweepOrphanedHistory();
    expect(await keys('projects')).toEqual(['kept']);
    expect(await keys('checkpoints')).toContain('checkpoints-kept');
  });

  it('finds nothing the second time', async () => {
    await adapter.sweepOrphanedHistory();
    expect(await adapter.sweepOrphanedHistory()).toBe(0);
  });
});

/**
 * A newer version of the app upgrades the database, and IndexedDB holds the upgrade until every
 * open connection closes: an older tab left open kept a new one waiting at a blank screen.
 */
describe('a newer version opening the database', () => {
  it('is not held up by this connection', async () => {
    const upgraded = await new Promise<string>((resolve) => {
      const request = indexedDB.open(name, 999);
      request.onblocked = () => resolve('blocked');
      request.onsuccess = () => { request.result.close(); resolve('opened'); };
    });
    expect(upgraded).toBe('opened');
  });

  it('leaves this adapter able to open again afterwards', async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(name, 999);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    // A later write from this page reconnects rather than failing on a closed connection; the
    // database is now newer than this build, so it reports that instead of hanging.
    await expect(Promise.race([adapter.init().then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('hung'), 1000))])).resolves.toBe('settled');
  });
});
