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
 * Create storage adapter for client-side usage.
 * In server mode with a workspace cookie, uses a workspace-scoped IndexedDB (osw-studio-{workspaceId}).
 * In browser mode, always uses the default database (osw-studio-db) regardless of stale cookies.
 */
export function createClientAdapter(): StorageAdapter {
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const workspaceId = isServerMode ? readWorkspaceCookie() : undefined;
  const dbName = workspaceId ? `osw-studio-${workspaceId}` : undefined;
  return new IndexedDBAdapter(dbName);
}
