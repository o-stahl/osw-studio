import { describe, it, expect, beforeAll, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { vfs } from '../index';

// Exercises the real VFS export → JSON round-trip → import path to guard
// against binary assets and project settings being lost (issue #11).

describe('project export/import round-trip', () => {
  beforeAll(async () => {
    await vfs.init();
  });

  it('preserves binary files and project settings through JSON', async () => {
    const project = await vfs.createProject('Round Trip', 'test');
    project.settings = { ...project.settings, runtime: 'static' };
    await vfs.updateProject(project);

    await vfs.createFile(project.id, '/index.html', '<html><body>hi</body></html>');

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 250]);
    await vfs.createFile(project.id, '/myimage.png', pngBytes.buffer);

    // Serialize exactly as the export UI does, then parse back.
    const exported = await vfs.exportProject(project.id);
    const roundTripped = JSON.parse(JSON.stringify(exported));

    const imported = await vfs.importProject(roundTripped);

    // Settings (runtime) survives instead of resetting to the legacy default.
    expect(imported.settings.runtime).toBe('static');

    // Text file content is intact.
    const html = await vfs.readFile(imported.id, '/index.html');
    expect(html.content).toBe('<html><body>hi</body></html>');

    // Binary file is restored to an ArrayBuffer with identical bytes.
    const img = await vfs.readFile(imported.id, '/myimage.png');
    expect(img.content).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(img.content as ArrayBuffer))).toEqual(
      Array.from(pngBytes)
    );
  });

  it('duplicateProject carries over project settings', async () => {
    const project = await vfs.createProject('Dup Settings', 'test');
    project.settings = { ...project.settings, runtime: 'static' };
    await vfs.updateProject(project);

    const copy = await vfs.duplicateProject(project.id);
    expect(copy.settings.runtime).toBe('static');
  });

  it('forkLocalDraft copies files and settings onto a new id', async () => {
    const project = await vfs.createProject('Keep Both', 'test');
    project.settings = { ...project.settings, runtime: 'static' };
    await vfs.updateProject(project);
    await vfs.createFile(project.id, '/index.html', '<h1>draft</h1>');
    await vfs.createDirectory(project.id, '/empty');

    const fork = await vfs.forkLocalDraft(project.id);

    expect(fork.id).not.toBe(project.id);
    expect(fork.name).toBe('Keep Both (local draft)');
    expect(fork.settings.runtime).toBe('static');
    expect((await vfs.readFile(fork.id, '/index.html')).content).toBe('<h1>draft</h1>');
    expect((await vfs.readFile(project.id, '/index.html')).content).toBe('<h1>draft</h1>');
    const dirs = (await vfs.getAllFilesAndDirectories(fork.id)).filter(
      (n) => 'type' in n && n.type === 'directory' && n.path === '/empty',
    );
    expect(dirs).toHaveLength(1);
  });

  it('forkLocalDraft copies edge functions onto the new id and leaves the original', async () => {
    const project = await vfs.createProject('Has Backend', 'test');
    await vfs.createFile(project.id, '/index.html', '<h1>x</h1>');
    const now = new Date();
    const adapter = vfs.getStorageAdapter();
    if (!adapter.createEdgeFunction || !adapter.listEdgeFunctions) {
      throw new Error('expected edge function adapter');
    }
    await adapter.createEdgeFunction({
      id: 'ef1',
      projectId: project.id,
      name: 'ping',
      code: 'return true;',
      method: 'GET',
      enabled: true,
      timeoutMs: 5000,
      createdAt: now,
      updatedAt: now,
    });

    const fork = await vfs.forkLocalDraft(project.id);
    const originalFns = await adapter.listEdgeFunctions(project.id);
    const forkFns = await adapter.listEdgeFunctions(fork.id);

    expect(originalFns).toHaveLength(1);
    expect(originalFns[0].id).toBe('ef1');
    expect(forkFns).toHaveLength(1);
    expect(forkFns[0].id).not.toBe('ef1');
    expect(forkFns[0].name).toBe('ping');
    expect((await vfs.readFile(project.id, '/index.html')).content).toBe('<h1>x</h1>');
  });

  it('copyProject removes a copy that fails partway', async () => {
    const project = await vfs.createProject('Half Copied', 'test');
    await vfs.createFile(project.id, '/index.html', '<h1>x</h1>');
    const adapter = vfs.getStorageAdapter();
    const spy = vi.spyOn(adapter as Required<Pick<typeof adapter, 'listEdgeFunctions'>>, 'listEdgeFunctions').mockRejectedValueOnce(new Error('storage full'));

    await expect(vfs.copyProject(project.id, 'The Copy')).rejects.toThrow('storage full');

    spy.mockRestore();
    expect((await vfs.listProjects()).map((p) => p.name)).not.toContain('The Copy');
  });

  it('noteProjectEdit stamps updatedAt so a backend-only change is a local edit', async () => {
    const project = await vfs.createProject('Backend Stamp', 'test');
    const before = project.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await vfs.noteProjectEdit(project.id);
    const after = await vfs.getProject(project.id);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before);
  });
});
