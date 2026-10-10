import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Deletes go to the server before the local copy. A viewer's own items never reached the server
 * (pushing needs editor), so the delete routes say "not here" to any member, and ask for editor only
 * when there is something to delete. A 403 first would have kept every local-only item undeletable.
 */

const store = vi.hoisted(() => ({ skill: null as null | { id: string; isBuiltIn?: boolean }, deleted: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api/workspace-context', () => ({
  // The caller is a viewer: asking for any higher role up front is refused.
  getWorkspaceContext: vi.fn(async (_params: unknown, role = 'editor') => {
    if (role !== 'viewer') throw new Error('Insufficient workspace permissions');
    return {
    session: { userId: 'viewer-1' },
    workspaceId: 'ws',
    adapter: {
      getSkill: async () => store.skill,
      deleteSkill: async (id: string) => { store.deleted.push(id); },
    },
    };
  }),
  requireWorkspaceRole: () => { throw new Error('Insufficient workspace permissions'); },
}));

const del = async () => {
  const { DELETE } = await import('../skills/[id]/route');
  return DELETE(new NextRequest('http://x/api/w/ws/sync/skills/s1', { method: 'DELETE' }), {
    params: Promise.resolve({ workspaceId: 'ws', id: 's1' }),
  });
};

beforeEach(() => {
  store.skill = null;
  store.deleted = [];
});

describe('a viewer deleting a synced item', () => {
  it('is told it is not on the server, so the local copy can go', async () => {
    expect((await del()).status).toBe(404);
  });

  it('is refused when it is on the server, which deleting needs editor for', async () => {
    store.skill = { id: 's1' };
    expect((await del()).status).toBe(403);
    expect(store.deleted).toEqual([]);
  });
});
