/**
 * The project's database DDL.
 *
 * It lives on the project record (`settings.databaseSchema`), not in localStorage, because it is
 * project data: every mechanism that moves a project — archive download, `.osws` backup, Server
 * Mode sync — moves the record, and none of them can see a browser's local storage. Kept here
 * rather than in the Schema tab so `lib/` no longer has to import a component to reach it.
 *
 * In Server Mode the project database holds the real tables; this is the DDL that produced them,
 * kept so the AI can read the schema and so an empty database can be rebuilt from it.
 */

import type { VirtualFileSystem } from './index';

const legacyKey = (projectId: string) => `osw-db-schema-${projectId}`;

/**
 * The caller's file system, or the singleton when it doesn't have one.
 *
 * Callers that were handed a specific instance must pass it: `exportProjectArchive` takes a
 * `VirtualFileSystem` argument, and reading the schema off the singleton instead would pair one
 * instance's files with another's schema. Type-only import, so this stays free of a load cycle.
 */
async function resolveVfs(instance?: VirtualFileSystem): Promise<VirtualFileSystem> {
  if (instance) return instance;
  const { vfs } = await import('./index');
  return vfs;
}

/**
 * Where the schema used to live. Read on miss and written up to the project record on first
 * access, so a project that predates the move keeps its schema without a boot migration —
 * localStorage is per-browser, so a one-shot migration would only ever catch one machine anyway.
 */
function readLegacy(projectId: string): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(legacyKey(projectId)) || '';
  } catch {
    return '';
  }
}

/** Also called on project deletion, which has to clear the legacy key a project may still own. */
export function clearLegacyProjectSchema(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(legacyKey(projectId));
  } catch {
    // Storage disabled or full — the record is the source of truth either way.
  }
}

/** Read from the record, falling back to the legacy key and migrating it up. */
export async function getProjectSchema(
  projectId: string,
  instance?: VirtualFileSystem
): Promise<string> {
  const vfs = await resolveVfs(instance);
  let project;
  try {
    project = await vfs.getProject(projectId);
  } catch {
    // Called from UI that can outlive the project it was opened for.
    return readLegacy(projectId);
  }

  const stored = project.settings?.databaseSchema;
  if (stored) return stored;

  const legacy = readLegacy(projectId);
  if (!legacy) return '';
  // preserveUpdatedAt: moving a value between two places it was already stored is not an edit to
  // the project, and bumping updatedAt here would report every un-migrated project as out of sync.
  await vfs.updateProject(
    { ...project, settings: { ...project.settings, databaseSchema: legacy } },
    { preserveUpdatedAt: true }
  );
  clearLegacyProjectSchema(projectId);
  return legacy;
}

/** Write to the record. An empty schema clears the field rather than storing `''`. */
export async function setProjectSchema(
  projectId: string,
  schema: string,
  instance?: VirtualFileSystem
): Promise<void> {
  const vfs = await resolveVfs(instance);
  const project = await vfs.getProject(projectId);
  await vfs.updateProject({
    ...project,
    settings: { ...project.settings, databaseSchema: schema || undefined },
  });
  clearLegacyProjectSchema(projectId);
}

/**
 * Store the schema and apply it to the project database (Server Mode only).
 * Used during project creation, where a template brings a schema with it.
 */
export async function applyProjectDatabaseSchema(
  projectId: string,
  ddl: string,
  workspaceId?: string
): Promise<void> {
  await setProjectSchema(projectId, ddl);
  if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') return;
  try {
    // The server's project database routes are workspace-scoped; without an explicit workspace,
    // use the one the page is working in.
    const path = `/projects/${projectId}/database/query`;
    const url = workspaceId
      ? `/api/w/${workspaceId}${path}`
      : (await import('./auto-sync')).getAutoSyncApiUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: ddl }),
    });
    if (!res.ok) {
      console.warn('[Schema] DDL apply failed — will auto-heal on Schema tab open');
    }
  } catch {
    // Non-fatal — auto-apply on Schema tab open will recover.
  }
}
