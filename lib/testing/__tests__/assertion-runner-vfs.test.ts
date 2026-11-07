import { describe, it, expect } from 'vitest';
import type { VirtualFileSystem } from '@/lib/vfs';
import { runWithVFS } from '@/lib/server-generate/vfs-context';
import { runAssertions } from '../assertion-runner';

/**
 * A server run works on the VFS it was started with, not the browser's, which a server never
 * initialises: an interview's file checks have to read the files that run wrote.
 */
describe('runAssertions in a server run', () => {
  it('reads through the VFS the run works on', async () => {
    const runVfs = { fileExists: async (_projectId: string, path: string) => path === '/.interviews/notes.md' } as unknown as VirtualFileSystem;

    const results = await runWithVFS(runVfs, () => runAssertions('p', [], [
      { type: 'file_exists', path: '/.interviews/notes.md', description: 'notes written' },
    ]));

    expect(results.map((r) => [r.passed, r.actual])).toEqual([[true, 'file exists']]);
  });
});
