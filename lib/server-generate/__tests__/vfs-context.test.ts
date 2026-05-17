import { describe, it, expect } from 'vitest';
import { runWithVFS, getContextVFS } from '../vfs-context';

describe('VFS AsyncLocalStorage context', () => {
  it('returns undefined when no context is active', () => {
    expect(getContextVFS()).toBeUndefined();
  });

  it('returns the VFS instance inside runWithVFS', async () => {
    const fakeVFS = { marker: 'test-vfs' } as any;
    await runWithVFS(fakeVFS, async () => {
      expect(getContextVFS()).toBe(fakeVFS);
    });
  });

  it('returns undefined after runWithVFS completes', async () => {
    const fakeVFS = { marker: 'test-vfs' } as any;
    await runWithVFS(fakeVFS, async () => {});
    expect(getContextVFS()).toBeUndefined();
  });

  it('isolates concurrent contexts', async () => {
    const vfs1 = { marker: 'vfs-1' } as any;
    const vfs2 = { marker: 'vfs-2' } as any;

    const results: string[] = [];
    await Promise.all([
      runWithVFS(vfs1, async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push((getContextVFS() as any).marker);
      }),
      runWithVFS(vfs2, async () => {
        results.push((getContextVFS() as any).marker);
      }),
    ]);

    expect(results).toContain('vfs-1');
    expect(results).toContain('vfs-2');
  });
});
