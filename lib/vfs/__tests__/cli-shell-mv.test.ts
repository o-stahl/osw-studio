// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { vfsShell } from '../cli-shell';

/**
 * `mv` against the real VFS. Moving onto an existing file used to delete the source and keep the
 * old target while reporting success: `renameFile` deleted first, then failed to create.
 */
globalThis.indexedDB = new IDBFactory();

let seq = 0;
async function seed(files: Record<string, string>): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('mv', 'fixture', `p-mv-${++seq}`);
  for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
  return project.id;
}
const read = async (id: string, path: string) => String((await vfs.readFile(id, path)).content);
const exists = (id: string, path: string) => vfs.fileExists(id, path);

describe('mv', () => {
  it('replaces a file already at the target, as POSIX mv does', async () => {
    const id = await seed({ '/a.txt': 'new', '/b.txt': 'old' });
    const result = await vfsShell.execute(id, ['mv', '/a.txt', '/b.txt']);
    expect(result.success).toBe(true);
    expect(await read(id, '/b.txt')).toBe('new');
    expect(await exists(id, '/a.txt')).toBe(false);
  });

  it('renames to a free path', async () => {
    const id = await seed({ '/a.txt': 'x' });
    expect((await vfsShell.execute(id, ['mv', '/a.txt', '/c.txt'])).success).toBe(true);
    expect(await read(id, '/c.txt')).toBe('x');
    expect(await exists(id, '/a.txt')).toBe(false);
  });

  it('moves a file into an existing directory under its own name', async () => {
    const id = await seed({ '/a.txt': 'x', '/dir/keep.txt': 'k' });
    expect((await vfsShell.execute(id, ['mv', '/a.txt', '/dir'])).success).toBe(true);
    expect(await read(id, '/dir/a.txt')).toBe('x');
    expect(await exists(id, '/a.txt')).toBe(false);
  });

  it('fails on a missing source and touches nothing', async () => {
    const id = await seed({ '/b.txt': 'old' });
    const result = await vfsShell.execute(id, ['mv', '/nope.txt', '/b.txt']);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('No such file or directory');
    expect(await read(id, '/b.txt')).toBe('old');
  });

  it('renames a directory with its files', async () => {
    const id = await seed({ '/old/a.txt': 'x' });
    expect((await vfsShell.execute(id, ['mv', '/old', '/new'])).success).toBe(true);
    expect(await read(id, '/new/a.txt')).toBe('x');
    expect(await exists(id, '/old/a.txt')).toBe(false);
  });
});

describe('renameFile', () => {
  it('refuses an existing target without losing the source', async () => {
    const id = await seed({ '/a.txt': 'a', '/b.txt': 'b' });
    await expect(vfs.renameFile(id, '/a.txt', '/b.txt')).rejects.toThrow(/already exists/);
    expect(await read(id, '/a.txt')).toBe('a');
    expect(await read(id, '/b.txt')).toBe('b');
  });
});
