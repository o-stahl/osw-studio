// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { vfs } from '@/lib/vfs';

globalThis.indexedDB = new IDBFactory();

/** Every key of `store` stored under `projectId`. */
async function keysOf(store: string, projectId: string): Promise<IDBValidKey[]> {
  const db = vfs.getDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction([store], 'readonly').objectStore(store).index('projectId').getAllKeys(projectId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(store: string, record: Record<string, unknown>): Promise<void> {
  const db = vfs.getDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store], 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('vfs.deleteProject', () => {
  it("removes the project's chat, checkpoints and old conversations, and leaves another project's", async () => {
    await vfs.init();
    const gone = await vfs.createProject('Gone', 'fixture', 'p-delete-gone');
    const kept = await vfs.createProject('Kept', 'fixture', 'p-delete-kept');

    for (const project of [gone, kept]) {
      await put('debugEvents', { id: `debug_events_${project.id}`, projectId: project.id, events: [], lastUpdated: new Date().toISOString() });
      await put('checkpoints', { id: `cp-a-${project.id}`, projectId: project.id, timestamp: 1, files: [] });
      await put('checkpoints', { id: `cp-b-${project.id}`, projectId: project.id, timestamp: 2, files: [], pinned: true });
      await put('conversations', { id: `conv-${project.id}`, projectId: project.id, lastUpdated: 1, messages: [] });
    }

    await vfs.deleteProject(gone.id);

    for (const store of ['debugEvents', 'checkpoints', 'conversations']) {
      expect(await keysOf(store, gone.id), store).toEqual([]);
      expect((await keysOf(store, kept.id)).length, store).toBeGreaterThan(0);
    }
  });
});
