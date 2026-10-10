/**
 * Adapter Factory
 *
 * Creates the appropriate storage adapter based on environment configuration.
 * Browser mode: IndexedDBAdapter with default database name
 * Server mode (with workspace): IndexedDBAdapter with workspace-scoped database name
 */

import { StorageAdapter } from './types';
import { IndexedDBAdapter } from './indexeddb-adapter';
import { readWorkspaceCookie } from '@/lib/web/workspace-cookie';

/**
 * Read the workspace ID from the osw_workspace cookie (client-side).
 * Returns undefined if not in a browser or no workspace cookie set.
 */
function getWorkspaceId(): string | undefined {
  return readWorkspaceCookie();
}

/**
 * Create storage adapter for client-side usage.
 * In server mode with a workspace cookie, uses a workspace-scoped IndexedDB (osw-studio-{workspaceId}).
 * In browser mode, always uses the default database (osw-studio-db) regardless of stale cookies.
 */
export function createClientAdapter(): StorageAdapter {
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const workspaceId = isServerMode ? getWorkspaceId() : undefined;
  const dbName = workspaceId ? `osw-studio-${workspaceId}` : undefined;
  return new IndexedDBAdapter(dbName);
}

/**
 * Create storage adapter for server-side usage (Server mode only)
 * Returns SQLiteAdapter configured to use data/osws.sqlite
 *
 * NOTE: This function uses dynamic import to avoid bundling sqlite in client code
 */
export async function createServerAdapter(): Promise<StorageAdapter> {
  // Dynamic import to avoid bundling server-only code in client
  const { SQLiteAdapter } = await import('./sqlite-adapter');
  return new SQLiteAdapter();
}
