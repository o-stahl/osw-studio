import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Deletes go to the server before the local copy. A viewer's own items never reached the server
 * (pushing needs editor), so the delete routes say "not here" to any member, and ask for editor only
 * when there is something to delete. A 403 first would have kept every local-only item undeletable.
 * Every sync DELETE route follows that order, so each is driven through the same three callers.
 */

const store = vi.hoisted(() => ({
  item: null as null | { id: string },
  deleted: [] as string[],
  role: 'viewer' as 'viewer' | 'editor',
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api/storage-quota', () => ({ forgetWorkspaceStorage: vi.fn() }));
vi.mock('@/lib/api/workspace-context', () => {
  const rank = { viewer: 0, editor: 1, owner: 2 } as const;
  const check = (role: keyof typeof rank) => {
    if (rank[store.role] < rank[role]) throw new Error('Insufficient workspace permissions');
  };
  const get = async () => store.item;
  const remove = async (id: string) => { store.deleted.push(id); };
  return {
    getWorkspaceContext: vi.fn(async (_params: unknown, role: keyof typeof rank = 'editor') => {
      check(role);
      return {
        session: { userId: 'u1' },
        workspaceId: 'ws',
        role: store.role,
        adapter: {
          getSkill: get, deleteSkill: remove,
          getCustomTemplate: get, deleteCustomTemplate: remove,
          getModelTemplate: get, deleteModelTemplate: remove,
          getInterviewTemplate: get, deleteInterviewTemplate: remove,
          getConnection: get, deleteConnection: remove,
          getProject: get, deleteProject: remove, listDeployments: async () => [],
        },
      };
    }),
    requireWorkspaceRole: (_context: unknown, role: keyof typeof rank) => check(role),
  };
});

type Route = { DELETE: (request: NextRequest, context: { params: Promise<{ workspaceId: string; id: string }> }) => Promise<Response> };

const ROUTES: Array<[string, () => Promise<Route>, number]> = [
  ['skills', () => import('../skills/[id]/route'), 404],
  ['templates', () => import('../templates/[id]/route'), 404],
  ['model-templates', () => import('../model-templates/[id]/route'), 404],
  ['interview-templates', () => import('../interview-templates/[id]/route'), 404],
  ['connections', () => import('../connections/[id]/route'), 404],
  // A project not on the server is reported deleted rather than missing.
  ['projects', () => import('../projects/[id]/route'), 200],
];

beforeEach(() => {
  store.item = null;
  store.deleted = [];
  store.role = 'viewer';
});

describe.each(ROUTES)('DELETE /sync/%s/[id]', (name, load, missingStatus) => {
  const del = async () => {
    const { DELETE } = await load();
    return DELETE(new NextRequest(`http://x/api/w/ws/sync/${name}/i1`, { method: 'DELETE' }), {
      params: Promise.resolve({ workspaceId: 'ws', id: 'i1' }),
    });
  };

  it('tells a viewer an item is not on the server, so the local copy can go', async () => {
    const response = await del();
    expect(response.status).toBe(missingStatus);
    if (missingStatus === 200) expect(await response.json()).toEqual({ success: true });
  });

  it('refuses a viewer an item that is on the server, which deleting needs editor for', async () => {
    store.item = { id: 'i1' };
    expect((await del()).status).toBe(403);
    expect(store.deleted).toEqual([]);
  });

  it('deletes it for an editor', async () => {
    store.item = { id: 'i1' };
    store.role = 'editor';
    expect((await del()).status).toBe(200);
    expect(store.deleted).toEqual(['i1']);
  });
});
