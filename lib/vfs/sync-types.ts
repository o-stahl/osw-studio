/**
 * Sync Types
 *
 * Type definitions for granular sync status tracking across
 * projects, skills, and templates.
 */

import type { CustomTemplate } from './types';

/**
 * Sync status for individual items
 */
export type ItemSyncStatus =
  | 'synced'        // In sync with server
  | 'local-newer'   // Local has changes not yet pushed
  | 'server-newer'  // Server has updates to pull
  | 'conflict'      // Both local and server have changes
  | 'local-only'    // Only exists locally
  | 'server-only'   // Only exists on server
  | 'syncing'       // Currently syncing
  | 'error';        // Sync failed

/**
 * Represents a syncable item (project, skill, or template)
 */
export interface SyncableItem {
  id: string;
  name: string;
  type: 'project' | 'skill' | 'template' | 'modelTemplate' | 'interviewTemplate';
  localUpdatedAt: Date | null;
  serverUpdatedAt: Date | null;
  lastSyncedAt: Date | null;
  status: ItemSyncStatus;
}

/**
 * Sync status for a category of items
 */
export interface CategorySyncStatus {
  items: SyncableItem[];
  syncedCount: number;
  localNewerCount: number;
  serverNewerCount: number;
  conflictCount: number;
  localOnlyCount: number;
  serverOnlyCount: number;
}

/**
 * Detailed sync status across all syncable categories
 */
export interface DetailedSyncStatus {
  projects: CategorySyncStatus;
  skills: CategorySyncStatus;
  templates: CategorySyncStatus;
  modelTemplates: CategorySyncStatus;
  interviewTemplates: CategorySyncStatus;
  loading: boolean;
  error: string | null;
}

/**
 * Server status response for skills
 */
export interface SkillSyncStatus {
  id: string;
  name: string;
  updatedAt: string; // ISO string
}

/**
 * Server status response for templates
 */
export interface TemplateSyncStatus {
  id: string;
  name: string;
  updatedAt: string; // ISO string (from importedAt or updatedAt)
}

/**
 * Server status response for model templates
 */
export interface ModelTemplateSyncStatus {
  id: string;
  name: string;
  updatedAt: string; // ISO string
}

/**
 * Server status response for interview templates
 */
export interface InterviewTemplateSyncStatus {
  id: string;
  name: string;
  updatedAt: string; // ISO string
}

/**
 * Server status response for projects
 */
export interface ProjectSyncStatus {
  id: string;
  name: string;
  updatedAt: string; // ISO string
}

/**
 * Enhanced sync status response from server
 */
export interface EnhancedSyncStatusResponse {
  success: boolean;
  projects: ProjectSyncStatus[];
  skills: SkillSyncStatus[];
  templates: TemplateSyncStatus[];
  modelTemplates: ModelTemplateSyncStatus[];
  interviewTemplates: InterviewTemplateSyncStatus[];
  summary: {
    projectCount: number;
    skillCount: number;
    templateCount: number;
    modelTemplateCount: number;
    interviewTemplateCount: number;
    deploymentCount: number;
    lastUpdated: string | null;
    isUninitialized: boolean;
  };
}

/**
 * Calculate category counts from items
 */
export function calculateCategoryCounts(items: SyncableItem[]): Omit<CategorySyncStatus, 'items'> {
  return {
    syncedCount: items.filter(i => i.status === 'synced').length,
    localNewerCount: items.filter(i => i.status === 'local-newer').length,
    serverNewerCount: items.filter(i => i.status === 'server-newer').length,
    conflictCount: items.filter(i => i.status === 'conflict').length,
    localOnlyCount: items.filter(i => i.status === 'local-only').length,
    serverOnlyCount: items.filter(i => i.status === 'server-only').length,
  };
}

/**
 * Timestamps reach these comparisons in three shapes: a real Date (IndexedDB structured clone),
 * an ISO string (anything written straight from a JSON API response), or absent. Comparing a Date
 * against a string with `>` coerces both to numbers, and a date string is NaN, so every comparison
 * reads false and the item is reported 'synced' however far the copies have drifted. Normalise to
 * epoch milliseconds first. An unparseable value is treated as absent, never as a drift signal.
 */
type SyncTimestamp = Date | string | number | null | undefined;

export function toTime(value: SyncTimestamp): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Calculate sync status using three-way timestamp comparison
 * Reusable for projects, skills, and templates
 */
export function calculateItemSyncStatus(
  localUpdatedAtInput: SyncTimestamp,
  serverUpdatedAtInput: SyncTimestamp,
  lastSyncedAtInput: SyncTimestamp
): ItemSyncStatus {
  const localUpdatedAt = toTime(localUpdatedAtInput);
  const serverUpdatedAt = toTime(serverUpdatedAtInput);
  const lastSyncedAt = toTime(lastSyncedAtInput);

  // If no local item, it's server-only
  if (localUpdatedAt === null) {
    return serverUpdatedAt !== null ? 'server-only' : 'synced';
  }

  // If no server timestamp available, it's local-only
  if (serverUpdatedAt === null) {
    return 'local-only';
  }

  // If never synced before, compare timestamps directly
  if (lastSyncedAt === null) {
    if (localUpdatedAt > serverUpdatedAt) {
      return 'local-newer';
    } else if (serverUpdatedAt > localUpdatedAt) {
      return 'server-newer';
    }
    return 'synced';
  }

  // Three-way comparison
  const localChanged = localUpdatedAt > lastSyncedAt;
  const serverChanged = serverUpdatedAt > lastSyncedAt;

  if (localChanged && serverChanged) {
    return 'conflict';
  }

  if (localChanged) {
    return 'local-newer';
  }

  if (serverChanged) {
    return 'server-newer';
  }

  return 'synced';
}

/**
 * A template pulled from the server, for saving over the local one.
 *
 * Server rows written before the database stored `runtime` and `backendFeatures` have neither, so
 * the local values stand where the server has none. The next push then gives them to the server.
 */
export function withLocalTemplateFields(pulled: CustomTemplate, local: CustomTemplate | null): CustomTemplate {
  if (!local) return pulled;
  return {
    ...pulled,
    runtime: pulled.runtime ?? local.runtime,
    backendFeatures: pulled.backendFeatures ?? local.backendFeatures,
  };
}
