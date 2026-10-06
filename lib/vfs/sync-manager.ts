/**
 * Sync Manager
 *
 * Handles synchronization between browser (IndexedDB) and server (SQLite) in Server mode.
 * Provides methods to push local data to server and pull server data to browser.
 */

import { translator } from '@/lib/i18n/runtime';
import { Project, VirtualFile, CustomTemplate } from './types';
import { Skill } from './skills/types';
import type { ModelTemplate } from '@/lib/llm/models/assignment';
import type { CustomConnection } from '@/lib/llm/providers/connection-record';
import { EnhancedSyncStatusResponse } from './sync-types';
import { encodeTemplateFiles, decodeTemplateFiles } from './binary-encoding';
import { isArrayBuffer } from './is-array-buffer';

export interface SyncResult {
  success: boolean;
  error?: string;
  project?: Project;
}

export interface ProjectSyncResult extends SyncResult {
  project?: Project;
}

export interface FilesSyncResult extends SyncResult {
  count?: number;
  revision?: number;
}

export interface FilesListSyncResult extends SyncResult {
  files?: VirtualFile[];
}

interface FileManifestEntry {
  path: string;
  updatedAt: string | Date;
  size?: number;
}

/** Reported as each batch of a chunked push lands, so callers can show a ratio, not a spinner. */
export interface PushProgress {
  batch: number;
  batches: number;
}

/**
 * Target serialized bytes per push batch.
 *
 * Next buffers each request body so it can be replayed into middleware and **truncates** it past
 * `experimental.proxyClientMaxBodySize` rather than rejecting it, so the route receives a body cut
 * mid-string and `request.json()` throws what looks like data corruption. `next.config.ts` raises
 * that ceiling to 32MB, and batching well under it keeps the ceiling from being load-bearing —
 * which matters because a HuggingFace Space or a self-hosted instance behind someone else's proxy
 * is not ours to configure.
 */
const PUSH_BATCH_BYTES = 5 * 1024 * 1024;

/**
 * A single file this large cannot be batched, since a batch cannot be smaller than the file in it.
 * Set below the 32MB ceiling so the rest of the request body fits. Named in the error rather than
 * skipped: a file dropped from a push leaves the server holding a project that is quietly wrong.
 */
const PUSH_FILE_LIMIT_BYTES = 24 * 1024 * 1024;

type SerializedFile = VirtualFile & { _isBinaryBase64?: boolean };

function serializedByteSize(value: unknown): number {
  // Blob measures UTF-8 exactly. JSON.stringify's length is UTF-16 code units, which undercounts
  // by up to 3x on non-ASCII text — enough to push a "5MB" batch over the wire limit.
  return new Blob([JSON.stringify(value)]).size;
}

/**
 * Split files into batches under `cap` bytes, keeping every file whole.
 *
 * Batches by serialized size rather than file count because one image can outweigh a hundred
 * pages. Always returns at least one batch: a push with no changed files still has to carry the
 * project metadata and any deletions.
 */
export function batchFilesBySize<T extends { path: string }>(
  files: T[],
  cap: number = PUSH_BATCH_BYTES,
  fileLimit: number = PUSH_FILE_LIMIT_BYTES
): { batches: T[][]; oversized: string[] } {
  const batches: T[][] = [];
  const oversized: string[] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const size = serializedByteSize(file);
    if (size > fileLimit) {
      oversized.push(file.path);
      continue;
    }
    if (current.length > 0 && currentBytes + size > cap) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  if (batches.length === 0) batches.push([]);

  return { batches, oversized };
}

export interface SkillSyncResult extends SyncResult {
  skill?: Skill;
  action?: 'created' | 'updated';
}

export interface SkillsListSyncResult extends SyncResult {
  skills?: Skill[];
  created?: number;
  updated?: number;
}

export interface TemplateSyncResult extends SyncResult {
  template?: CustomTemplate;
  action?: 'created' | 'updated';
}

export interface TemplatesListSyncResult extends SyncResult {
  templates?: CustomTemplate[];
  created?: number;
  updated?: number;
}

export interface ModelTemplateSyncResult extends SyncResult {
  modelTemplate?: ModelTemplate;
  action?: 'created' | 'updated';
}

export interface ModelTemplatesListSyncResult extends SyncResult {
  modelTemplates?: ModelTemplate[];
  created?: number;
  updated?: number;
}

export interface InterviewTemplateSyncResult extends SyncResult {
  interviewTemplate?: import('@/lib/interview/types').InterviewTemplate;
  action?: 'created' | 'updated';
}
export interface InterviewTemplatesListSyncResult extends SyncResult {
  interviewTemplates?: import('@/lib/interview/types').InterviewTemplate[];
  created?: number;
  updated?: number;
}

export interface ConnectionSyncResult extends SyncResult {
  connection?: CustomConnection;
  action?: 'created' | 'updated';
}

export interface ConnectionsListSyncResult extends SyncResult {
  connections?: CustomConnection[];
}

// Helper: Convert ArrayBuffer to base64 for JSON transport.
// Exported because auto-sync pushes over its own transport: JSON.stringify turns an ArrayBuffer
// into {}, and the push route recreates the server's files from what it receives, so skipping this
// silently blanks every binary asset in the project. The tag check rather than `instanceof` is
// what makes that true of content read back from IndexedDB as well; see `isArrayBuffer`.
export function serializeFileContent(file: VirtualFile): VirtualFile & { _isBinaryBase64?: boolean } {
  if (isArrayBuffer(file.content)) {
    const bytes = new Uint8Array(file.content);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { ...file, content: btoa(binary), _isBinaryBase64: true };
  }
  return file;
}

// Helper: Convert base64 back to ArrayBuffer after JSON transport.
// Exported for the same reason as serializeFileContent: auto-sync pulls over its own transport,
// and writing the base64 string straight to the VFS turns every image and font into a text file.
export function deserializeFileContent(file: VirtualFile & { _isBinaryBase64?: boolean }): VirtualFile {
  if (file._isBinaryBase64 && typeof file.content === 'string') {
    const binaryString = atob(file.content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const { _isBinaryBase64, ...rest } = file;
    return { ...rest, content: bytes.buffer };
  }
  const { _isBinaryBase64, ...rest } = file;
  return rest;
}

/**
 * SyncManager - Client-side sync utility for Server mode
 */
export class SyncManager {
  private baseUrl: string;
  workspaceId?: string;

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  /**
   * Build an API URL, scoped to a workspace when workspaceId is set.
   *
   * With workspaceId:  /api/w/{workspaceId}{path}
   * Without:          /api{path}
   *
   * @param path - must start with '/' (e.g. '/sync/projects')
   */
  private getApiUrl(path: string): string {
    if (this.workspaceId) {
      return `/api/w/${this.workspaceId}${path}`;
    }
    return `/api${path}`;
  }

  /**
   * Push project to server (IndexedDB -> SQLite)
   */
  async pushProject(project: Project): Promise<ProjectSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/projects')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project, baseRevision: project.revision ?? 0 }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      const revision = data.project?.revision ?? data.revision;
      return {
        success: true,
        project: data.project
          ? { ...data.project, revision: typeof revision === 'number' ? revision : data.project.revision }
          : { ...project, revision },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Push files for a project to server (IndexedDB -> SQLite)
   */
  async pushFiles(
    projectId: string,
    files: VirtualFile[],
    options?: { onProgress?: (progress: PushProgress) => void; baseRevision?: number }
  ): Promise<FilesSyncResult> {
    try {
      const { batches, oversized } = batchFilesBySize(files.map(serializeFileContent));
      if (oversized.length > 0) {
        return {
          success: false,
          error: translator()('sync.tooLargeEncoded', { mb: Math.round(PUSH_FILE_LIMIT_BYTES / 1024 / 1024), files: oversized.join(', ') }),
        };
      }

      let count = 0;
      for (let i = 0; i < batches.length; i++) {
        const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/files')}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          // Only the first batch clears the project's files; the rest add to what it wrote.
          body: JSON.stringify({
            projectId,
            files: batches[i],
            replace: i === 0,
            baseRevision: options?.baseRevision ?? 0,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          return {
            success: false,
            error: errorData.error || `HTTP ${response.status}`,
          };
        }

        const data = await response.json();
        count += data.count ?? 0;
        options?.onProgress?.({ batch: i + 1, batches: batches.length });
      }

      return { success: true, count };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Pull files for a project from server (SQLite -> IndexedDB)
   */
  async pullFiles(projectId: string): Promise<FilesListSyncResult> {
    try {
      const response = await fetch(
        `${this.baseUrl}${this.getApiUrl('/sync/files')}?projectId=${encodeURIComponent(projectId)}`,
        {
          method: 'GET',
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();

      return {
        success: true,
        files: (data.files || []).map(deserializeFileContent),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Full project sync: push project + files to server
   */
  async pushProjectWithFiles(
    project: Project,
    files: VirtualFile[],
    options?: { onProgress?: (progress: PushProgress) => void }
  ): Promise<SyncResult> {
    // Same admitted path as a normal push. A separate metadata POST then /sync/files
    // rewrite allowed a stale client to reset revision and replace newer files.
    return this.pushSingleProject(project.id, project, files, options);
  }

  /**
   * Full project sync: pull project + files from server to IndexedDB
   * Returns the project and files for the caller to insert into IndexedDB
   */
  async pullProjectWithFiles(projectId: string): Promise<{
    success: boolean;
    error?: string;
    project?: Project;
    files?: VirtualFile[];
  }> {
    // One request for the one project. This used to pull every project and pick this one out of
    // the list, which meant downloading the whole `projects` table: measured at 2.69MB for 237
    // projects, 74% of it base64 thumbnails nothing here reads. The per-project endpoint returns
    // the project and its files together, so it also replaces the separate file request.
    try {
      const response = await fetch(
        `${this.baseUrl}${this.getApiUrl(`/sync/projects/${encodeURIComponent(projectId)}`)}`,
        { method: 'GET' },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      if (!data.project) {
        return { success: false, error: translator()('sync.notOnServer', { id: projectId }) };
      }

      return {
        success: true,
        project: data.project,
        // Same decoding the file endpoint used: binary content arrives base64 and has to become
        // bytes again before it reaches the VFS.
        files: (data.files || []).map(deserializeFileContent),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Fetch the server's file manifest for a project.
   *
   * `absent` is a 404, which is how a project the server has never seen reports itself.
   * `unavailable` is anything else, and callers treat it as "cannot compute a delta" rather than
   * as an error, so a push still has a path that does not depend on this endpoint. It carries the
   * server's own message, because "Unauthorized" is the thing worth reading in a log and a
   * generic failure line would replace it.
   */
  private async fetchManifest(projectId: string): Promise<
    | { status: 'ok'; project: Project; files: FileManifestEntry[] }
    | { status: 'absent' }
    | { status: 'unavailable'; error: string }
  > {
    try {
      const response = await fetch(
        `${this.baseUrl}${this.getApiUrl(`/sync/projects/${projectId}`)}?manifest=1`,
      );
      if (response.status === 404) return { status: 'absent' };
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { status: 'unavailable', error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json() as { project: Project; files: FileManifestEntry[] };
      return { status: 'ok', project: data.project, files: data.files };
    } catch (error) {
      return { status: 'unavailable', error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /**
   * Send a push as a sequence of `partial: true` batches.
   *
   * Three things make this safe to interrupt, and all three are load-bearing:
   *
   * 1. **Only the last batch writes the project row** (`writeProject`). The route stores the row
   *    with the client's `updatedAt`, so a batch that wrote it would move the server's timestamp
   *    past the client's `lastSyncedAt` and the *next* batch of the same push would fail the
   *    optimistic-concurrency check against itself. Holding the write to the end keeps the check
   *    live — it still catches a real concurrent change — rather than forcing past it.
   * 2. **Deletions ride with that last batch.** Until a push completes, the server's copy is
   *    strictly additive, so a run that dies half way has lost nothing.
   * 3. **The caller records `lastSyncedAt` only on success.** A partially applied push must keep
   *    reading as un-synced, because that is what makes the retry a delta that resends the
   *    remainder instead of a no-op.
   */
  private async pushBatches(
    projectId: string,
    project: Project,
    serializedFiles: SerializedFile[],
    deletedPaths: string[],
    options?: { force?: boolean; onProgress?: (progress: PushProgress) => void }
  ): Promise<ProjectSyncResult> {
    const { batches, oversized } = batchFilesBySize(serializedFiles);
    if (oversized.length > 0) {
      return {
        success: false,
        error: translator()('sync.tooLargeEncoded', { mb: Math.round(PUSH_FILE_LIMIT_BYTES / 1024 / 1024), files: oversized.join(', ') }),
      };
    }

    let lastProject: Project | undefined;
    let base = project.revision ?? 0;
    for (let i = 0; i < batches.length; i++) {
      const isLast = i === batches.length - 1;
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/projects/${projectId}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          files: batches[i],
          deletedPaths: isLast ? deletedPaths : [],
          partial: true,
          writeProject: isLast,
          baseRevision: base,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
          project: lastProject,
        };
      }

      const data = await response.json();
      const rev = typeof data.project?.revision === 'number' ? data.project.revision : data.revision;
      lastProject = data.project
        ? { ...data.project, ...(typeof rev === 'number' ? { revision: rev } : {}) }
        : lastProject;
      if (typeof rev === 'number') base = rev;
      options?.onProgress?.({ batch: i + 1, batches: batches.length });
    }

    return { success: true, project: lastProject };
  }

  /**
   * Push a project and all of its files to the server.
   *
   * `force` overwrites the server copy even when it has moved on since this client last synced.
   * Reserved for an explicit push from Server Sync: the user is looking at the conflict and
   * choosing to keep the local copy. Background syncs omit it so conflicts still surface.
   *
   * Sends every local file, so it is the first upload and the "make the server match my copy"
   * button rather than a routine save. Files the server holds and this project no longer has are
   * removed by path, which is the chunkable equivalent of the delete-all the route still supports
   * for a `partial: false` push — a 129MB project cannot be one request, and that request would be
   * silently truncated rather than refused.
   */
  async pushSingleProject(
    projectId: string,
    project: Project,
    files: VirtualFile[],
    options?: { force?: boolean; onProgress?: (progress: PushProgress) => void }
  ): Promise<ProjectSyncResult> {
    try {
      return await this.pushAllFiles(projectId, project, files, await this.fetchManifest(projectId), options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * The body of `pushSingleProject`, taking the manifest as an argument so the delta path can hand
   * over the one it already fetched instead of paying for a second round trip on a first upload.
   */
  private async pushAllFiles(
    projectId: string,
    project: Project,
    files: VirtualFile[],
    manifest: Awaited<ReturnType<SyncManager['fetchManifest']>>,
    options?: { force?: boolean; onProgress?: (progress: PushProgress) => void }
  ): Promise<ProjectSyncResult> {
    // Without a manifest there is no way to know what the server holds that this project does
    // not, and the route's `partial: false` delete-and-recreate cannot be split across requests —
    // each batch would delete what the batch before it wrote. Reported rather than attempted: a
    // manifest that cannot be read almost always means a POST would fail too.
    if (manifest.status === 'unavailable') {
      return { success: false, error: manifest.error };
    }

    const localPaths = new Set(files.map((file) => file.path));
    const deletedPaths = manifest.status === 'ok'
      ? manifest.files.filter((file) => !localPaths.has(file.path)).map((file) => file.path)
      : [];

    return this.pushBatches(projectId, project, files.map(serializeFileContent), deletedPaths, options);
  }

  /**
   * Sync only files whose VFS revision differs from the server manifest. The
   * first sync still sends the full project; later generations avoid sending
   * unchanged source and binary assets over the network.
   */
  async pushProjectDelta(
    projectId: string,
    project: Project,
    files: VirtualFile[],
    options?: { onProgress?: (progress: PushProgress) => void }
  ): Promise<ProjectSyncResult> {
    try {
      const manifest = await this.fetchManifest(projectId);

      if (manifest.status === 'absent') {
        // Everything is new, and there is nothing on the server to delete. Hand the manifest over
        // rather than letting the full push fetch it again.
        return this.pushAllFiles(projectId, project, files, manifest, options);
      }
      if (manifest.status === 'unavailable') {
        return { success: false, error: manifest.error };
      }

      const serverProject = manifest.project;
      const clientLastSynced = project.lastSyncedAt ? new Date(project.lastSyncedAt).getTime() : 0;
      const serverUpdated = new Date(serverProject.updatedAt).getTime();
      // No force option here on purpose. A delta sends only the files that differ from the server's
      // manifest, so forcing one would leave whatever the server gained meanwhile in place — the
      // opposite of "keep my copy". Resolving a conflict goes through the full push instead.
      if (clientLastSynced > 0 && serverUpdated > clientLastSynced) {
        return { success: false, error: 'conflict' };
      }

      const serverFiles = new Map(manifest.files.map((file) => [file.path, file]));
      const changedFiles = files.filter((file) => {
        const serverFile = serverFiles.get(file.path);
        if (!serverFile) return true;
        return new Date(serverFile.updatedAt).getTime() !== new Date(file.updatedAt).getTime()
          || (serverFile.size ?? 0) !== (file.size ?? 0);
      });
      const localPaths = new Set(files.map((file) => file.path));
      const deletedPaths = manifest.files
        .filter((file) => !localPaths.has(file.path))
        .map((file) => file.path);
      const projectChanged = new Date(project.updatedAt).getTime() !== serverUpdated;

      if (changedFiles.length === 0 && deletedPaths.length === 0 && !projectChanged) {
        return { success: true, project: serverProject };
      }

      return await this.pushBatches(
        projectId,
        project,
        changedFiles.map(serializeFileContent),
        deletedPaths,
        options
      );
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /**
   * Pull single project from server (new API endpoint)
   */
  async pullSingleProject(projectId: string): Promise<{
    success: boolean;
    error?: string;
    project?: Project;
    files?: VirtualFile[];
  }> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/projects/${projectId}`)}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();

      return {
        success: true,
        project: data.project,
        files: (data.files || []).map(deserializeFileContent),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Get sync status for all projects on server
   */
  async getSyncStatus(): Promise<{
    success: boolean;
    error?: string;
    projects?: Array<{ id: string; updatedAt: string }>;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/status')}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        projects: data.projects || [],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  // ============================================
  // Skills Sync Methods
  // ============================================

  /**
   * Pull all custom skills from server
   */
  async pullSkills(): Promise<SkillsListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/skills')}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        skills: data.skills || [],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Push multiple skills to server
   */
  async pushSkills(skills: Skill[]): Promise<SkillsListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/skills')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ skills }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: data.success,
        created: data.created,
        updated: data.updated,
        error: data.errors?.join(', '),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Pull a single skill from server
   */
  async pullSkill(id: string): Promise<SkillSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/skills/${encodeURIComponent(id)}`)}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        skill: data.skill,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Push a single skill to server
   */
  async pushSkill(skill: Skill): Promise<SkillSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/skills/${encodeURIComponent(skill.id)}`)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ skill }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        skill: data.skill,
        action: data.action,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Delete a skill from server
   */
  async deleteSkillFromServer(id: string): Promise<SyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/skills/${encodeURIComponent(id)}`)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  // ============================================
  // Model Template Sync Methods
  // ============================================

  /** Pull all model templates from server */
  async pullModelTemplates(): Promise<ModelTemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/model-templates')}`, { method: 'GET' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, modelTemplates: data.modelTemplates || [] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Push multiple model templates to server */
  async pushModelTemplates(modelTemplates: ModelTemplate[]): Promise<ModelTemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/model-templates')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelTemplates }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: data.success, created: data.created, updated: data.updated, error: data.errors?.join(', ') };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Pull a single model template from server */
  async pullModelTemplate(id: string): Promise<ModelTemplateSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/model-templates/${encodeURIComponent(id)}`)}`, { method: 'GET' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, modelTemplate: data.modelTemplate };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Push a single model template to server */
  async pushModelTemplate(modelTemplate: ModelTemplate): Promise<ModelTemplateSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/model-templates/${encodeURIComponent(modelTemplate.id)}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelTemplate }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, modelTemplate: data.modelTemplate, action: data.action };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Delete a model template from server */
  async deleteModelTemplateFromServer(id: string): Promise<SyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/model-templates/${encodeURIComponent(id)}`)}`, { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  // ============================================
  // Interview Template Sync Methods
  // ============================================

  /** Pull all interview templates from server */
  async pullInterviewTemplates(): Promise<InterviewTemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/interview-templates')}`, { method: 'GET' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, interviewTemplates: data.interviewTemplates || [] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Push multiple interview templates to server */
  async pushInterviewTemplates(interviewTemplates: import('@/lib/interview/types').InterviewTemplate[]): Promise<InterviewTemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/interview-templates')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewTemplates }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: data.success, created: data.created, updated: data.updated, error: data.errors?.join(', ') };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Pull a single interview template from server */
  async pullInterviewTemplate(id: string): Promise<InterviewTemplateSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/interview-templates/${encodeURIComponent(id)}`)}`, { method: 'GET' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, interviewTemplate: data.interviewTemplate };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Push a single interview template to server */
  async pushInterviewTemplate(interviewTemplate: import('@/lib/interview/types').InterviewTemplate): Promise<InterviewTemplateSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/interview-templates/${encodeURIComponent(interviewTemplate.id)}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interviewTemplate }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, interviewTemplate: data.interviewTemplate, action: data.action };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Delete an interview template from server */
  async deleteInterviewTemplateFromServer(id: string): Promise<SyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/interview-templates/${encodeURIComponent(id)}`)}`, { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  // ============================================
  // Connection Sync Methods
  // ============================================

  /** Pull all custom connections from server */
  async pullConnections(): Promise<ConnectionsListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/connections')}`, { method: 'GET' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, connections: data.connections || [] };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Push a single custom connection to server */
  async pushConnection(connection: CustomConnection): Promise<ConnectionSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/connections/${encodeURIComponent(connection.id)}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      const data = await response.json();
      return { success: true, connection: data.connection, action: data.action };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /** Delete a custom connection from server */
  async deleteConnectionFromServer(id: string): Promise<SyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/connections/${encodeURIComponent(id)}`)}`, { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  // ============================================
  // Templates Sync Methods
  // ============================================

  /**
   * Pull all custom templates from server
   */
  async pullTemplates(): Promise<TemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/templates')}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        templates: (data.templates || []).map((t: CustomTemplate) => ({ ...t, files: decodeTemplateFiles(t.files) })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Push multiple templates to server
   */
  async pushTemplates(templates: CustomTemplate[]): Promise<TemplatesListSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/templates')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Binary template files must be encoded: JSON.stringify turns an ArrayBuffer into {}.
        body: JSON.stringify({
          templates: templates.map((t) => ({ ...t, files: encodeTemplateFiles(t.files) })),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: data.success,
        created: data.created,
        updated: data.updated,
        error: data.errors?.join(', '),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Pull a single template from server
   */
  async pullTemplate(id: string): Promise<TemplateSyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/templates/${encodeURIComponent(id)}`)}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        template: data.template && { ...data.template, files: decodeTemplateFiles(data.template.files) },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Push a single template to server
   */
  async pushTemplate(template: CustomTemplate): Promise<TemplateSyncResult> {
    try {
      // A template made from a project carries that project's whole file set, so it runs into the
      // same request body limit a project push does. The first request stores the record with its
      // first slice of files; the rest append to it.
      const { batches, oversized } = batchFilesBySize(encodeTemplateFiles(template.files));
      if (oversized.length > 0) {
        return {
          success: false,
          error: translator()('sync.tooLargeEncoded', { mb: Math.round(PUSH_FILE_LIMIT_BYTES / 1024 / 1024), files: oversized.join(', ') }),
        };
      }

      let data: { template?: CustomTemplate; action?: 'created' | 'updated' } | undefined;
      for (let i = 0; i < batches.length; i++) {
        const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/templates/${encodeURIComponent(template.id)}`)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template: { ...template, files: batches[i] },
            appendFiles: i > 0,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          return {
            success: false,
            error: errorData.error || `HTTP ${response.status}`,
          };
        }

        data = await response.json();
      }

      return {
        success: true,
        template: data?.template && { ...data.template, files: decodeTemplateFiles(data.template.files) },
        action: data?.action,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  /**
   * Delete a template from server
   */
  async deleteTemplateFromServer(id: string): Promise<SyncResult> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/templates/${encodeURIComponent(id)}`)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }

  // ============================================
  // Backend Features Sync (Project-scoped)
  // ============================================

  /**
   * Push backend features from IndexedDB to server (core SQLite)
   * Called after backend feature modifications in the workspace
   */
  async pushBackendFeatures(
    projectId: string,
    features?: {
      edgeFunctions: import('./types').EdgeFunction[];
      serverFunctions: import('./types').ServerFunction[];
      secrets: import('./types').Secret[];
      scheduledFunctions: import('./types').ScheduledFunction[];
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/backend-features/${projectId}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(features || {
          edgeFunctions: [],
          serverFunctions: [],
          secrets: [],
          scheduledFunctions: [],
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  /**
   * Pull backend features from server (core SQLite) to IndexedDB
   * Called during project sync/pull operations
   */
  async pullBackendFeatures(projectId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl(`/sync/backend-features/${projectId}`)}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }

      const data = await response.json() as {
        edgeFunctions?: import('./types').EdgeFunction[];
        serverFunctions?: import('./types').ServerFunction[];
        secrets?: import('./types').Secret[];
        scheduledFunctions?: import('./types').ScheduledFunction[];
      };

      // Write pulled features to IndexedDB via the VFS adapter
      try {
        const { vfs } = await import('@/lib/vfs');
        const adapter = vfs.getStorageAdapter();

        // Clear existing features for this project, then re-create from server data
        if (adapter.listEdgeFunctions && adapter.deleteEdgeFunction && adapter.createEdgeFunction) {
          const existing = await adapter.listEdgeFunctions(projectId);
          for (const fn of existing) {
            await adapter.deleteEdgeFunction(fn.id);
          }
          for (const fn of data.edgeFunctions || []) {
            await adapter.createEdgeFunction({ ...fn, projectId });
          }
        }

        if (adapter.listServerFunctions && adapter.deleteServerFunction && adapter.createServerFunction) {
          const existing = await adapter.listServerFunctions(projectId);
          for (const fn of existing) {
            await adapter.deleteServerFunction(fn.id);
          }
          for (const fn of data.serverFunctions || []) {
            await adapter.createServerFunction({ ...fn, projectId });
          }
        }

        if (adapter.listSecrets && adapter.deleteSecret && adapter.createSecret) {
          const existing = await adapter.listSecrets(projectId);
          for (const s of existing) {
            await adapter.deleteSecret(s.id);
          }
          for (const s of data.secrets || []) {
            await adapter.createSecret({ ...s, projectId });
          }
        }

        if (adapter.listScheduledFunctions && adapter.deleteScheduledFunction && adapter.createScheduledFunction) {
          const existing = await adapter.listScheduledFunctions(projectId);
          for (const fn of existing) {
            await adapter.deleteScheduledFunction(fn.id);
          }
          for (const fn of data.scheduledFunctions || []) {
            await adapter.createScheduledFunction({ ...fn, projectId });
          }
        }
      } catch (writeError) {
        console.error('[SyncManager] Failed to write pulled backend features to IndexedDB:', writeError);
        return { success: false, error: writeError instanceof Error ? writeError.message : 'Failed to write to IndexedDB' }; // i18n-ignore: the only caller discards the result
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : translator()('sync.networkError') };
    }
  }

  // ============================================
  // Detailed Sync Status
  // ============================================

  /**
   * Get enhanced sync status including skills and templates
   */
  async getEnhancedSyncStatus(): Promise<{
    success: boolean;
    error?: string;
    data?: EnhancedSyncStatusResponse;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}${this.getApiUrl('/sync/status')}`, {
        method: 'GET',
      });

      if (!response.ok) {
        const errorData = await response.json();
        return {
          success: false,
          error: errorData.error || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as EnhancedSyncStatusResponse,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : translator()('sync.networkError'),
      };
    }
  }
}

/**
 * Global singleton instance
 */
let syncManager: SyncManager | null = null;

/**
 * Get or create SyncManager instance.
 *
 * When workspaceId is provided the singleton's workspaceId is updated so all
 * subsequent API calls are scoped to `/api/w/{workspaceId}/…`.  Pass
 * `undefined` (or omit) to keep the current workspaceId unchanged, or pass
 * `null` explicitly to clear it (reverts to unscoped `/api/…` paths).
 */
export function getSyncManager(workspaceId?: string | null): SyncManager {
  if (!syncManager) {
    syncManager = new SyncManager();
  }
  if (workspaceId !== undefined) {
    syncManager.workspaceId = workspaceId ?? undefined;
  }
  return syncManager;
}
