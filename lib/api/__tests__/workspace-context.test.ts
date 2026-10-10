import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `requireWorkspaceRole` is the second, higher check a route makes after answering what any member
 * may know. Route tests mock it away, so this pins that it asks the system database about the
 * context's own user and workspace, at the role the route names, and lets a refusal through.
 */

const mocks = vi.hoisted(() => ({ verifyWorkspaceAccess: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ requireAuth: vi.fn() }));
vi.mock('@/lib/auth/system-database', () => ({ verifyWorkspaceAccess: mocks.verifyWorkspaceAccess }));
vi.mock('@/lib/vfs/adapters/server', () => ({ getWorkspaceAdapter: vi.fn() }));
vi.mock('@/lib/vfs/adapters/sqlite-adapter', () => ({ SQLiteAdapter: class {} }));

import { requireWorkspaceRole, type WorkspaceContext } from '../workspace-context';

const context = {
  session: { userId: 'user-7', email: 'a@b.c', isAdmin: false, exp: 0 },
  workspaceId: 'ws-42',
  adapter: {},
} as unknown as WorkspaceContext;

beforeEach(() => {
  mocks.verifyWorkspaceAccess.mockReset();
});

describe('requireWorkspaceRole', () => {
  it.each(['viewer', 'editor', 'owner'] as const)('checks the context user and workspace for %s', (role) => {
    requireWorkspaceRole(context, role);
    expect(mocks.verifyWorkspaceAccess).toHaveBeenCalledExactlyOnceWith('user-7', 'ws-42', role);
  });

  it('throws what the access check throws', () => {
    mocks.verifyWorkspaceAccess.mockImplementation(() => {
      throw new Error('Insufficient workspace permissions');
    });
    expect(() => requireWorkspaceRole(context, 'editor')).toThrow('Insufficient workspace permissions');
  });
});
