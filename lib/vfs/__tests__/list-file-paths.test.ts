// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { vfs } from '@/lib/vfs';

/**
 * `listFilePaths`: a project's paths from the [projectId, path] index, with no file read. The
 * Inspector's link sweep runs on every style write and must not load a project's images to do it.
 */
globalThis.indexedDB = new IDBFactory();

describe('vfs.listFilePaths', () => {
  it('lists every path of the project, and only of that project, without reading a file', async () => {
    await vfs.init();
    const a = await vfs.createProject('A', 'fixture', 'p-paths-a');
    const b = await vfs.createProject('B', 'fixture', 'p-paths-b');
    await vfs.createFile(a.id, '/index.html', '<p>a</p>', { silent: true });
    await vfs.createFile(a.id, '/pages/about.html', '<p>b</p>', { silent: true });
    await vfs.createFile(a.id, '/img/logo.svg', '<svg></svg>', { silent: true });
    await vfs.createFile(b.id, '/index.html', '<p>other</p>', { silent: true });

    // Every IndexedDB call that hands back a stored file, contents and all.
    const reads = [
      vi.spyOn(IDBIndex.prototype, 'getAll'), vi.spyOn(IDBIndex.prototype, 'get'), vi.spyOn(IDBIndex.prototype, 'openCursor'),
      vi.spyOn(IDBObjectStore.prototype, 'getAll'), vi.spyOn(IDBObjectStore.prototype, 'get'), vi.spyOn(IDBObjectStore.prototype, 'openCursor'),
    ];
    try {
      const paths = await vfs.listFilePaths(a.id);
      expect([...paths].sort()).toEqual(['/img/logo.svg', '/index.html', '/pages/about.html']);
      expect(await vfs.listFilePaths(b.id)).toEqual(['/index.html']);
      for (const read of reads) expect(read).not.toHaveBeenCalled();
    } finally {
      for (const read of reads) read.mockRestore();
    }
  });
});
