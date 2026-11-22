import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/vfs', () => ({
  vfs: {
    getProject: vi.fn(async (id: string) => ({ id, name: id === 'p1' ? 'Site' : 'Other' })),
    updateProject: vi.fn(async () => {}),
  },
}));
vi.mock('@/lib/vfs/save-manager', () => ({ saveManager: { markDirty: vi.fn() } }));

beforeEach(() => { vi.mocked(toast.warning).mockClear(); });

/**
 * The "kept your local work" warning stays until dismissed. Repeats for one project (a burst of
 * pulls, a push and a pull meeting the same conflict) replace it rather than stacking copies.
 */
describe('markSyncNeedsRetry', () => {
  it('shows one warning per project however often it is reported', async () => {
    const { markSyncNeedsRetry } = await import('@/lib/vfs/auto-sync');
    await markSyncNeedsRetry('p1', 'Site', { reason: 'conflict' });
    await markSyncNeedsRetry('p1', 'Site', { reason: 'conflict' });
    await markSyncNeedsRetry('p1', 'Site', { reason: 'error' });

    const ids = vi.mocked(toast.warning).mock.calls.map(([, options]) => (options as { id?: string })?.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });

  it('keeps separate warnings for separate projects', async () => {
    const { markSyncNeedsRetry } = await import('@/lib/vfs/auto-sync');
    await markSyncNeedsRetry('p1', 'Site', { reason: 'conflict' });
    await markSyncNeedsRetry('p2', 'Other', { reason: 'conflict' });

    const ids = vi.mocked(toast.warning).mock.calls.map(([, options]) => (options as { id?: string })?.id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
