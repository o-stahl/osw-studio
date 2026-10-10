/**
 * Workspace Context Helper
 *
 * Extracts workspace ID from route params, verifies user access,
 * and returns the correct adapter. Used by all workspace-scoped API routes.
 */

import 'server-only';

import { requireAuth, type SessionData } from '@/lib/auth/session';
import { verifyWorkspaceAccess } from '@/lib/auth/system-database';
import { getWorkspaceAdapter } from '@/lib/vfs/adapters/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

export interface WorkspaceContext {
  session: SessionData;
  workspaceId: string;
  adapter: SQLiteAdapter;
}

/**
 * Get workspace context for an API route.
 * Authenticates the user, extracts workspaceId from params, verifies access,
 * and returns an initialized adapter for the workspace.
 *
 * @param params - Route params containing workspaceId
 * @param requiredRole - Minimum role needed (default: 'editor')
 * @throws Error('Unauthorized') if not authenticated
 * @throws Error('Workspace access denied') if no access
 * @throws Error('Insufficient workspace permissions') if role too low
 */
export async function getWorkspaceContext(
  params: Promise<{ workspaceId: string }>,
  requiredRole: 'owner' | 'editor' | 'viewer' = 'editor'
): Promise<WorkspaceContext> {
  const session = await requireAuth();
  const { workspaceId } = await params;
  verifyWorkspaceAccess(session.userId, workspaceId, requiredRole);
  const adapter = getWorkspaceAdapter(workspaceId);
  await adapter.init();
  return { session, workspaceId, adapter };
}

/**
 * Check a higher role once the request is known to need one, for a route that first answers what
 * any member may know (a delete reports 404 for something never synced before asking for editor).
 */
export function requireWorkspaceRole(context: WorkspaceContext, role: 'owner' | 'editor' | 'viewer'): void {
  verifyWorkspaceAccess(context.session.userId, context.workspaceId, role);
}

/**
 * Owner-only guard for a workspace route that has no adapter to open.
 *
 * Separate from `getWorkspaceContext` because the settings surfaces this guards, mail and members,
 * read the system database rather than the workspace's own, so opening the workspace adapter would
 * be work that is never used.
 */
export async function requireWorkspaceOwner(
  params: Promise<{ workspaceId: string }>
): Promise<{ session: SessionData; workspaceId: string }> {
  const session = await requireAuth();
  const { workspaceId } = await params;
  verifyWorkspaceAccess(session.userId, workspaceId, 'owner');
  return { session, workspaceId };
}
