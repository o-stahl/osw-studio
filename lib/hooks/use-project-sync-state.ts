'use client';

import { useSyncExternalStore } from 'react';
import {
  getProjectSyncState,
  subscribeProjectSyncState,
  type ProjectSyncState,
} from '@/lib/vfs/project-sync-state';

/**
 * What the server renders, and so what hydration has to render too. The shared state is module
 * level and outlives a render: a consumer inside a Suspense boundary hydrates after PageLayout has
 * already loaded it, and reading it then would put a count into HTML the server sent without one.
 */
const SERVER_SNAPSHOT: ProjectSyncState = { statuses: new Map(), pendingCount: 0, loaded: false };

/**
 * Subscribe to the shared project sync state.
 *
 * Read-only: PageLayout owns refreshing it, and the sync-completed broadcast recomputes it after
 * that. Refreshing from here instead would be wrong as well as wasteful — child effects run before
 * parent effects, so a consumer that refreshed on mount would request the sync status before
 * PageLayout had scoped it to the workspace.
 */
export function useProjectSyncState(): ProjectSyncState {
  return useSyncExternalStore(subscribeProjectSyncState, getProjectSyncState, () => SERVER_SNAPSHOT);
}
