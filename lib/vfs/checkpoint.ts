import { getActiveVFS } from './index';
import { configManager } from '@/lib/config/storage';
import { logger } from '@/lib/utils';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import {
  captureBackend,
  isEmptyPreview,
  previewBackendRestore,
  restoreBackend,
  type BackendRestorePreview,
  type CheckpointBackendSnapshot,
} from './checkpoint-backend';
import { compareFiles, indexFiles, type CheckpointChanges, type FileIndex } from './checkpoint-changes';

export { isEmptyPreview };
export type { BackendRestorePreview, CheckpointBackendSnapshot };

export type CheckpointKind = 'auto' | 'manual';

// File content can be either a string or base64-encoded binary data
interface CheckpointFileContent {
  data: string;
  encoding?: 'base64';
}

/**
 * A checkpoint the app names itself, as a key the checkpoint panel translates. `description` keeps
 * the English beside it: older checkpoints have only that, and it is what logs and the agent see.
 */
export interface CheckpointLabel {
  key: 'projectOpened' | 'preGeneration' | 'afterServerGeneration' | 'preSyncPull' | 'beforeImport' | 'manualSave' | 'afterPrompt' | 'afterFailure' | 'afterConnector' | 'afterConnectorUnnamed';
  values?: Record<string, string>;
}

/**
 * Set on every pin the person makes. Save does not pin: the project's last save is kept by
 * `pruneUnpinned` instead. A pin without it was made by an earlier Save, which pinned each save
 * until the next; `releaseSavePin` takes it off.
 */
export type PinnedBy = 'user';

// Full checkpoint with file contents (only used during create/restore)
export interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  label?: CheckpointLabel;
  files: Map<string, string | CheckpointFileContent>;
  directories: Set<string>;
  projectId: string;
  kind: CheckpointKind;
  pinned?: boolean;
  pinnedBy?: PinnedBy;
  baseRevisionId?: string | null;
  /**
   * Backend records and covered project settings. Absent on checkpoints written before this
   * existed, and on any created while the adapter could not list backend records — in both cases
   * a restore leaves the project's backend alone rather than treating "nothing" as "empty".
   */
  backend?: CheckpointBackendSnapshot;
  /** Bytes the checkpoint takes in storage, set when it is written. */
  size?: number;
  /** What changed since the checkpoint before it; absent on a project's first. */
  changes?: CheckpointChanges;
}

// Lightweight metadata for listing (kept in RAM)
export interface CheckpointMetadata {
  id: string;
  timestamp: string;
  description: string;
  label?: CheckpointLabel;
  projectId: string;
  kind: CheckpointKind;
  pinned?: boolean;
  pinnedBy?: PinnedBy;
  baseRevisionId?: string | null;
  size?: number;
  changes?: CheckpointChanges;
}

// Serializable checkpoint format for storage
interface StoredCheckpoint {
  id: string;
  timestamp: string;
  description: string;
  label?: CheckpointLabel;
  files: [string, string | CheckpointFileContent][];
  directories: string[];
  projectId: string;
  kind?: CheckpointKind;
  pinned?: boolean;
  pinnedBy?: PinnedBy;
  baseRevisionId?: string | null;
  backend?: CheckpointBackendSnapshot;
  size?: number;
  changes?: CheckpointChanges;
}

// Compressed checkpoint format — lz-string UTF-16 encoded files+directories+backend
interface StoredCheckpointCompressed {
  id: string;
  timestamp: string;
  description: string;
  label?: CheckpointLabel;
  projectId: string;
  kind?: CheckpointKind;
  pinned?: boolean;
  pinnedBy?: PinnedBy;
  baseRevisionId?: string | null;
  size?: number;
  changes?: CheckpointChanges;
  compressed: true;
  compressedData: string; // lz-string UTF-16 compressed JSON of { files, directories, backend }
}

type StoredCheckpointAny = StoredCheckpoint | StoredCheckpointCompressed;

interface CreateCheckpointOptions {
  kind?: CheckpointKind;
  /** Set when the app names the checkpoint itself, so the panel can word it in the viewer's language. */
  label?: CheckpointLabel;
  baseRevisionId?: string | null;
  /** Pinned from the start, with no `pinnedBy`: how an earlier Save left each save. */
  pinned?: boolean;
  /** A checkpoint of this project to write over, keeping its id: one burst of changes, one checkpoint. */
  replaces?: string;
}

/** The choices in Settings → Data for how many unpinned automatic checkpoints a project keeps. */
export const CHECKPOINT_LIMITS = [5, 10, 20, 50] as const;
export const DEFAULT_UNPINNED_PER_PROJECT = 10;
export const SAVE_LIMITS = [3, 5, 10, 20] as const;
export const DEFAULT_SAVES_PER_PROJECT = 5;

/**
 * How many unpinned automatic checkpoints each project keeps, as chosen in this browser, where the
 * checkpoints live. A lower choice prunes a project the next time it makes one.
 */
export function unpinnedLimit(): number {
  const chosen = configManager.getSettings().checkpointsKept;
  return chosen !== undefined && (CHECKPOINT_LIMITS as readonly number[]).includes(chosen) ? chosen : DEFAULT_UNPINNED_PER_PROJECT;
}

/**
 * How many unpinned saves (`kind: 'manual'`: Save, and the checkpoint before an import) each project
 * keeps besides its latest save, which is always kept. Counted apart from automatic checkpoints, so
 * agent runs never push a save out.
 */
export function savesLimit(): number {
  const chosen = configManager.getSettings().savesKept;
  return chosen !== undefined && (SAVE_LIMITS as readonly number[]).includes(chosen) ? chosen : DEFAULT_SAVES_PER_PROJECT;
}

let cpCounter = 0;

/** What the list needs of a stored checkpoint, without its files. */
function metadataOf(record: StoredCheckpointAny): CheckpointMetadata {
  return {
    id: record.id,
    timestamp: record.timestamp,
    description: record.description,
    label: record.label,
    projectId: record.projectId,
    kind: record.kind || 'auto',
    pinned: record.pinned ?? false,
    pinnedBy: record.pinned ? record.pinnedBy : undefined,
    baseRevisionId: record.baseRevisionId ?? null,
    size: record.size ?? storedSize(record),
    changes: record.changes,
  };
}

/** Bytes a record takes in storage: its strings are UTF-16, two bytes a character. */
function storedSize(record: StoredCheckpointAny): number {
  return 2 * ('compressed' in record && record.compressed ? record.compressedData.length : JSON.stringify(record).length);
}

/** The bigger a checkpoint, the longer reading it back takes. Past this, a change count is skipped. */
const MAX_BASE_READ = 2 * 1024 * 1024;
/** File indexes of the checkpoints made last, which the next one in their project is compared with. */
const INDEXES_KEPT = 3;

class CheckpointManager {
  // LAZY LOADING: Only store metadata in RAM, not full checkpoint data
  private checkpointMetadata: Map<string, CheckpointMetadata> = new Map();
  /** Projects whose metadata is in `checkpointMetadata`, including those with no checkpoints. */
  private loadedProjects = new Set<string>();
  private currentCheckpoint: string | null = null;
  private storeName = 'checkpoints';
  /** Each checkpoint's metadata without its files (IndexedDB v9), so listing reads no snapshot. */
  private metaStoreName = 'checkpointMeta';
  private isInitialized = false;
  private fileIndexes = new Map<string, FileIndex>();

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
  
  /**
   * Initialize by ensuring VFS database is ready
   */
  private async initDB(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    // Initialize VFS which also initializes the shared database
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    this.isInitialized = true;
  }

  /**
   * Get shared database connection from VFS
   */
  private getDB(): IDBDatabase {
    const activeVFS = getActiveVFS();
    return activeVFS.getDatabase();
  }

  /**
   * Load one project's checkpoint metadata into RAM, once.
   *
   * IndexedDB cannot read part of a record, and every checkpoint record carries a full copy of the
   * project, so the list comes from the metadata store. Full checkpoint data is read only to restore.
   */
  private async ensureProjectLoaded(projectId: string): Promise<void> {
    await this.initDB();
    if (this.loadedProjects.has(projectId)) return;

    const metadata = this.getDB().objectStoreNames.contains(this.metaStoreName)
      ? await this.readProjectMetadata(projectId)
      : (await this.request<StoredCheckpointAny[]>(
          this.getDB().transaction([this.storeName], 'readonly').objectStore(this.storeName).index('projectId').getAll(projectId)
        )).map(metadataOf);

    for (const meta of metadata) this.checkpointMetadata.set(meta.id, meta);
    this.loadedProjects.add(projectId);
  }

  /**
   * A project's entries in the metadata store, kept in step with its checkpoints: one with no entry
   * (written before the store existed, or brought in by a backup) is read once and given one, and an
   * entry whose checkpoint is gone is dropped. Comparing keys reads no snapshot.
   */
  private async readProjectMetadata(projectId: string): Promise<CheckpointMetadata[]> {
    const db = this.getDB();
    const [entries, keys] = await Promise.all([
      this.request<CheckpointMetadata[]>(db.transaction([this.metaStoreName], 'readonly').objectStore(this.metaStoreName).index('projectId').getAll(projectId)),
      this.request<IDBValidKey[]>(db.transaction([this.storeName], 'readonly').objectStore(this.storeName).index('projectId').getAllKeys(projectId)),
    ]);
    const present = new Set(keys);
    // An entry with no size predates sizes; it is read again like a missing one.
    const listed = entries.filter(meta => present.has(meta.id) && meta.size !== undefined);
    const stale = entries.filter(meta => !present.has(meta.id)).map(meta => meta.id);
    const known = new Set(listed.map(meta => meta.id));
    const added: CheckpointMetadata[] = [];
    for (const key of keys) {
      if (known.has(key as string)) continue;
      const record = await this.request<StoredCheckpointAny | undefined>(db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(key));
      if (record) added.push(metadataOf(record));
    }
    if (added.length || stale.length) {
      const tx = db.transaction([this.metaStoreName], 'readwrite');
      for (const meta of added) tx.objectStore(this.metaStoreName).put(meta);
      for (const id of stale) tx.objectStore(this.metaStoreName).delete(id);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    }
    return [...listed, ...added];
  }

  private request<T>(request: IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => {
        logger.error('Failed to read checkpoints from DB');
        reject(request.error);
      };
    });
  }

  /**
   * Load a single full checkpoint from IndexedDB (on-demand for restore)
   */
  private async loadSingleCheckpointFromDB(checkpointId: string): Promise<Checkpoint | null> {
    return new Promise((resolve, reject) => {
      const db = this.getDB();
      const transaction = db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(checkpointId);

      request.onsuccess = () => {
        const stored = request.result as StoredCheckpointAny | undefined;
        if (!stored) {
          resolve(null);
          return;
        }

        let files: Map<string, string | CheckpointFileContent>;
        let directories: Set<string>;
        let backend: CheckpointBackendSnapshot | undefined;

        if ('compressed' in stored && stored.compressed) {
          // Compressed format — decompress lz-string UTF-16
          const json = decompressFromUTF16(stored.compressedData);
          if (!json) {
            logger.error(`[Checkpoint] Failed to decompress checkpoint ${checkpointId} (corrupt data)`);
            resolve(null);
            return;
          }
          const parsed = JSON.parse(json);
          files = new Map(parsed.files);
          directories = new Set(parsed.directories);
          backend = parsed.backend;
        } else {
          // Legacy uncompressed format
          const legacy = stored as StoredCheckpoint;
          files = new Map(legacy.files);
          directories = new Set(legacy.directories);
          backend = legacy.backend;
        }

        const checkpoint: Checkpoint = {
          id: stored.id,
          timestamp: stored.timestamp,
          description: stored.description,
          label: stored.label,
          projectId: stored.projectId,
          kind: stored.kind || 'auto',
          pinned: stored.pinned ?? false,
          pinnedBy: stored.pinned ? stored.pinnedBy : undefined,
          baseRevisionId: stored.baseRevisionId ?? null,
          changes: stored.changes,
          files,
          directories,
          backend
        };
        resolve(checkpoint);
      };

      request.onerror = () => {
        logger.error('Failed to load checkpoint from DB');
        reject(request.error);
      };
    });
  }
  
  /** Save a checkpoint and its metadata entry to IndexedDB; returns the bytes it takes in storage. */
  private async saveCheckpointToDB(checkpoint: Checkpoint): Promise<number> {
    await this.initDB();

    let record: StoredCheckpoint | StoredCheckpointCompressed;

    try {
      const payload = JSON.stringify({
        files: Array.from(checkpoint.files.entries()),
        directories: Array.from(checkpoint.directories),
        backend: checkpoint.backend
      });
      const compressedData = compressToUTF16(payload);

      record = {
        id: checkpoint.id,
        timestamp: checkpoint.timestamp,
        description: checkpoint.description,
        label: checkpoint.label,
        projectId: checkpoint.projectId,
        kind: checkpoint.kind,
        pinned: checkpoint.pinned ?? false,
        pinnedBy: checkpoint.pinned ? checkpoint.pinnedBy : undefined,
        baseRevisionId: checkpoint.baseRevisionId ?? null,
        changes: checkpoint.changes,
        compressed: true,
        compressedData
      };
    } catch {
      // Fallback to uncompressed on compression failure
      record = {
        ...checkpoint,
        files: Array.from(checkpoint.files.entries()),
        directories: Array.from(checkpoint.directories),
        kind: checkpoint.kind,
        pinned: checkpoint.pinned ?? false,
        pinnedBy: checkpoint.pinned ? checkpoint.pinnedBy : undefined,
        baseRevisionId: checkpoint.baseRevisionId ?? null
      };
    }
    const size = storedSize(record);
    record.size = size;

    return new Promise((resolve, reject) => {
      let db: IDBDatabase;
      try {
        db = this.getDB();
      } catch (err) {
        reject(err);
        return;
      }
      // The checkpoint and its metadata entry are written together.
      const stores = db.objectStoreNames.contains(this.metaStoreName) ? [this.storeName, this.metaStoreName] : [this.storeName];
      const transaction = db.transaction(stores, 'readwrite');
      transaction.objectStore(this.storeName).put(record);
      if (stores.length > 1) transaction.objectStore(this.metaStoreName).put(metadataOf(record));

      transaction.oncomplete = () => resolve(size);
      transaction.onerror = () => {
        logger.error('Failed to save checkpoint to DB');
        reject(transaction.error);
      };
    });
  }
  
  /**
   * Delete a checkpoint from IndexedDB
   */
  private async deleteCheckpointFromDB(checkpointId: string): Promise<void> {
    await this.initDB();

    return new Promise((resolve, reject) => {
      const db = this.getDB();
      const stores = db.objectStoreNames.contains(this.metaStoreName) ? [this.storeName, this.metaStoreName] : [this.storeName];
      const transaction = db.transaction(stores, 'readwrite');
      for (const name of stores) transaction.objectStore(name).delete(checkpointId);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        logger.error('Failed to delete checkpoint from DB');
        reject(transaction.error);
      };
    });
  }
  
  /**
   * Create a checkpoint of current project state
   */
  async createCheckpoint(
    projectId: string,
    description: string,
    options: CreateCheckpointOptions = {}
  ): Promise<Checkpoint> {
    // Before the new one is added, so pruning counts the project's older checkpoints too.
    await this.ensureProjectLoaded(projectId);
    const activeVFS = getActiveVFS();
    await activeVFS.init();

    const { fileContents, directories } = await this.readProjectFiles(projectId);

    const pinned = options.pinned === true;

    const replaced = options.replaces ? this.checkpointMetadata.get(options.replaces) : undefined;
    const checkpoint: Checkpoint = {
      id: replaced?.projectId === projectId ? replaced.id : `cp_${Date.now()}_${cpCounter++}`,
      timestamp: new Date().toISOString(),
      description,
      label: options.label,
      files: fileContents,
      directories,
      projectId,
      kind: options.kind || 'auto',
      pinned,
      baseRevisionId: options.baseRevisionId ?? null,
      backend: await captureBackend(activeVFS, projectId)
    };
    const index = indexFiles(fileContents);
    checkpoint.changes = await this.changesSince(projectId, checkpoint.id, index);

    const metadata: CheckpointMetadata = {
      id: checkpoint.id,
      timestamp: checkpoint.timestamp,
      description: checkpoint.description,
      label: checkpoint.label,
      projectId: checkpoint.projectId,
      kind: checkpoint.kind,
      pinned,
      baseRevisionId: checkpoint.baseRevisionId,
      changes: checkpoint.changes,
    };
    this.checkpointMetadata.set(checkpoint.id, metadata);
    this.currentCheckpoint = checkpoint.id;

    metadata.size = await this.saveCheckpointToDB(checkpoint);
    this.keepIndex(checkpoint.id, index);
    await this.pruneUnpinned(projectId);

    return checkpoint;
  }

  /**
   * What changed since the project's newest checkpoint other than `id` (which a replace writes over,
   * so a burst is compared with what came before it). Undefined for a project's first checkpoint,
   * and when the one before it is not in memory and too big to read back quickly.
   */
  /** The project's files as a checkpoint holds them: text as strings, binary data as base64. */
  private async readProjectFiles(projectId: string): Promise<{ fileContents: Map<string, string | CheckpointFileContent>; directories: Set<string> }> {
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const files = await activeVFS.listDirectory(projectId, '/');
    const fileContents = new Map<string, string | CheckpointFileContent>();
    const directories = new Set<string>();

    for (const file of files) {
      if (file.metadata?.isGenerated) continue;

      const pathParts = file.path.split('/').filter(Boolean);
      for (let i = 1; i <= pathParts.length - 1; i++) {
        const dirPath = '/' + pathParts.slice(0, i).join('/');
        directories.add(dirPath);
      }

      if (typeof file.content === 'string') {
        fileContents.set(file.path, file.content);
      } else if (file.content instanceof ArrayBuffer) {
        const base64Data = this.arrayBufferToBase64(file.content);
        fileContents.set(file.path, {
          data: base64Data,
          encoding: 'base64'
        });
      } else {
        try {
          const fullFile = await activeVFS.readFile(projectId, file.path);
          if (typeof fullFile.content === 'string') {
            fileContents.set(file.path, fullFile.content);
          } else if (fullFile.content instanceof ArrayBuffer) {
            const base64Data = this.arrayBufferToBase64(fullFile.content);
            fileContents.set(file.path, {
              data: base64Data,
              encoding: 'base64'
            });
          }
        } catch (error) {
          logger.error(`Failed to read file for checkpoint: ${file.path}`, error);
        }
      }
    }
    return { fileContents, directories };
  }

  /**
   * The checkpoint the project's files came from, and what has changed in them since: the one made
   * or restored last in this page, or else the project's newest. Null when the project has none, or
   * when that checkpoint is not in memory and too big to read back (`MAX_BASE_READ`).
   */
  async compareWithFiles(projectId: string): Promise<{ id: string; changes: CheckpointChanges } | null> {
    await this.ensureProjectLoaded(projectId);
    const current = this.currentCheckpoint ? this.checkpointMetadata.get(this.currentCheckpoint) : undefined;
    let base = current?.projectId === projectId ? current : undefined;
    if (!base) {
      for (const meta of this.checkpointMetadata.values()) {
        if (meta.projectId !== projectId) continue;
        if (!base || meta.timestamp > base.timestamp || (meta.timestamp === base.timestamp && meta.id > base.id)) base = meta;
      }
    }
    if (!base) return null;
    let then = this.fileIndexes.get(base.id);
    if (!then) {
      if ((base.size ?? Infinity) > MAX_BASE_READ) return null;
      const full = await this.loadSingleCheckpointFromDB(base.id).catch(() => null);
      if (!full) return null;
      then = indexFiles(full.files);
      this.keepIndex(base.id, then);
    }
    const { fileContents } = await this.readProjectFiles(projectId);
    return { id: base.id, changes: compareFiles(then, indexFiles(fileContents)) };
  }

  private async changesSince(projectId: string, id: string, index: FileIndex): Promise<CheckpointChanges | undefined> {
    let base: CheckpointMetadata | undefined;
    for (const meta of this.checkpointMetadata.values()) {
      if (meta.projectId !== projectId || meta.id === id) continue;
      if (!base || meta.timestamp > base.timestamp || (meta.timestamp === base.timestamp && meta.id > base.id)) base = meta;
    }
    if (!base) return undefined;
    let before = this.fileIndexes.get(base.id);
    if (!before) {
      if ((base.size ?? Infinity) > MAX_BASE_READ) return undefined;
      const full = await this.loadSingleCheckpointFromDB(base.id).catch(() => null);
      if (!full) return undefined;
      before = indexFiles(full.files);
    }
    return compareFiles(before, index);
  }

  private keepIndex(id: string, index: FileIndex): void {
    this.fileIndexes.delete(id);
    this.fileIndexes.set(id, index);
    while (this.fileIndexes.size > INDEXES_KEPT) this.fileIndexes.delete(this.fileIndexes.keys().next().value!);
  }

  private async pruneUnpinned(projectId: string): Promise<void> {
    // The project's last save is what Discard Changes goes back to, and before the first Save it is
    // an unpinned "Project opened" checkpoint, so it is left out.
    let saved: string | null = null;
    try {
      saved = (await getActiveVFS().getProject(projectId))?.lastSavedCheckpointId ?? null;
    } catch { /* no project record: nothing is anyone's save */ }
    const unpinned = Array.from(this.checkpointMetadata.values())
      .filter(cp => cp.projectId === projectId && !cp.pinned && cp.id !== saved)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Saves and automatic checkpoints are counted apart, each against its own limit.
    const overflow = (pool: CheckpointMetadata[], limit: number) => pool.slice(0, Math.max(0, pool.length - limit));
    const toDelete = [
      ...overflow(unpinned.filter(cp => cp.kind === 'manual'), savesLimit()),
      ...overflow(unpinned.filter(cp => cp.kind !== 'manual'), unpinnedLimit()),
    ];
    for (const cp of toDelete) {
      this.checkpointMetadata.delete(cp.id);
      await this.deleteCheckpointFromDB(cp.id);
    }

    if (toDelete.length > 0) {
      logger.debug(`[CheckpointManager] Pruned ${toDelete.length} old checkpoints for project ${projectId}`);
    }
  }
  
  /**
   * What restoring this checkpoint would do to the project's stored secret values.
   *
   * Returns null when the checkpoint is missing or predates backend coverage, which callers read
   * as "nothing to warn about". `isEmptyPreview` distinguishes a restore that touches no secret
   * from one that has not been checked.
   */
  async previewRestore(checkpointId: string): Promise<BackendRestorePreview | null> {
    await this.initDB();

    const loaded = await this.loadBackendFromDB(checkpointId);
    if (!loaded) return null;

    const activeVFS = getActiveVFS();
    await activeVFS.init();

    try {
      return await previewBackendRestore(activeVFS, loaded.backend, loaded.projectId);
    } catch (error) {
      logger.error('[Checkpoint] Failed to preview restore', error);
      return null;
    }
  }

  /**
   * Read only the backend half of a stored checkpoint.
   *
   * A preview runs on the way to a restore that loads the same record again, so it skips
   * rebuilding the file Map and directory Set it has no use for. The payload still has to be
   * decompressed to reach the backend snapshot; caching it between the two reads would avoid that
   * too, and a stale cache on the path that overwrites the project is not worth the milliseconds.
   */
  private async loadBackendFromDB(
    checkpointId: string
  ): Promise<{ backend: CheckpointBackendSnapshot; projectId: string } | null> {
    return new Promise((resolve, reject) => {
      const db = this.getDB();
      const request = db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(checkpointId);

      request.onsuccess = () => {
        const stored = request.result as StoredCheckpointAny | undefined;
        if (!stored) {
          resolve(null);
          return;
        }

        let backend: CheckpointBackendSnapshot | undefined;
        if ('compressed' in stored && stored.compressed) {
          const json = decompressFromUTF16(stored.compressedData);
          backend = json ? JSON.parse(json).backend : undefined;
        } else {
          backend = (stored as StoredCheckpoint).backend;
        }

        resolve(backend ? { backend, projectId: stored.projectId } : null);
      };

      request.onerror = () => {
        logger.error('Failed to load checkpoint from DB');
        reject(request.error);
      };
    });
  }

  /**
   * Restore project to a checkpoint.
   *
   * `options.backend` opts out of restoring backend records and settings. Discard
   * (`saveManager.restoreLastSaved`) uses that so gallery backend edits are not rolled back.
   */
  async restoreCheckpoint(
    checkpointId: string,
    options: { backend?: boolean } = {}
  ): Promise<boolean> {
    // Defensive check: ensure checkpointId is a string
    if (typeof checkpointId !== 'string') {
      logger.error('[Checkpoint] Invalid checkpoint ID type:', typeof checkpointId, checkpointId);
      return false;
    }

    // Basic validation of checkpoint ID format
    if (!checkpointId.startsWith('cp_') || checkpointId.length < 6) {
      logger.error('[Checkpoint] Invalid checkpoint ID format:', checkpointId);
      return false;
    }

    await this.initDB();

    // LAZY LOADING: Load full checkpoint from IndexedDB on-demand
    const checkpoint = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!checkpoint) {
      logger.error(`[Checkpoint] Checkpoint not found in database: ${checkpointId}`);
      return false;
    }
    
    const activeVFS = getActiveVFS();
    await activeVFS.init();

    try {
      const currentFiles = await activeVFS.listDirectory(checkpoint.projectId, '/');

      const currentDirs = new Set<string>();
      for (const file of currentFiles) {
        const pathParts = file.path.split('/').filter(Boolean);
        for (let i = 1; i <= pathParts.length - 1; i++) {
          const dirPath = '/' + pathParts.slice(0, i).join('/');
          currentDirs.add(dirPath);
        }
      }

      for (const file of currentFiles) {
        if (!checkpoint.files.has(file.path)) {
          await activeVFS.deleteFile(checkpoint.projectId, file.path);
        }
      }

      const dirsToDelete = Array.from(currentDirs)
        .filter(dir => !checkpoint.directories || !checkpoint.directories.has(dir))
        .sort((a, b) => b.length - a.length);

      for (const dir of dirsToDelete) {
        try {
          await activeVFS.deleteDirectory(checkpoint.projectId, dir);
        } catch {
        }
      }

      if (checkpoint.directories) {
        const dirsToCreate = Array.from(checkpoint.directories)
          .sort((a, b) => a.length - b.length);

        for (const dir of dirsToCreate) {
          if (!currentDirs.has(dir)) {
            try {
              await activeVFS.createDirectory(checkpoint.projectId, dir);
            } catch {
            }
          }
        }
      }

      // Restore each file silently so listeners (preview compile, file-tree
      // reload) don't fire N times — one event is dispatched after the loop.
      // Without this, restoring a checkpoint with many files (e.g. 250 image
      // frames) triggers a reload storm as the debounce fires mid-loop and
      // each compile races the next batch of writes.
      for (const [path, content] of checkpoint.files) {
        let actualContent: string | ArrayBuffer;

        if (typeof content === 'object' && content.encoding === 'base64') {
          actualContent = this.base64ToArrayBuffer(content.data);
        } else {
          actualContent = content as string;
        }

        const exists = currentFiles.some(f => f.path === path);
        if (exists) {
          try {
            await activeVFS.updateFile(checkpoint.projectId, path, actualContent, { silent: true });
          } catch {
            await activeVFS.createFile(checkpoint.projectId, path, actualContent, { silent: true });
          }
        } else {
          await activeVFS.createFile(checkpoint.projectId, path, actualContent, { silent: true });
        }
      }

      // After the files, so a restored edge function and the code that calls it land together,
      // and so a backend failure cannot leave the file half half-written.
      if (checkpoint.backend && options.backend !== false) {
        await restoreBackend(activeVFS, checkpoint.backend, checkpoint.projectId);
      }

      // A restore changes the files as an edit does, so it is recorded and pushed as one. Left in
      // this browser, a server run starts from the server's older copy and a reload pulls it back.
      await activeVFS.updateProject(await activeVFS.getProject(checkpoint.projectId));
      activeVFS.scheduleAutoSync(checkpoint.projectId);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }

      this.currentCheckpoint = checkpointId;
      this.keepIndex(checkpointId, indexFiles(checkpoint.files));
      return true;
    } catch (error) {
      logger.error('Failed to restore checkpoint:', error);
      return false;
    }
  }
  
  /**
   * Get all checkpoint metadata for a project (lightweight - no file contents)
   */
  async getCheckpoints(projectId: string): Promise<CheckpointMetadata[]> {
    await this.ensureProjectLoaded(projectId);

    return Array.from(this.checkpointMetadata.values())
      .filter(cp => cp.projectId === projectId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  
  /**
   * Get the current checkpoint metadata
   */
  getCurrentCheckpoint(): CheckpointMetadata | null {
    if (!this.currentCheckpoint) return null;
    return this.checkpointMetadata.get(this.currentCheckpoint) || null;
  }

  /**
   * Check if a checkpoint exists
   */
  async checkpointExists(checkpointId: string): Promise<boolean> {
    if (!checkpointId || typeof checkpointId !== 'string') {
      return false;
    }

    await this.initDB();
    if (this.checkpointMetadata.has(checkpointId)) return true;

    // Its project may not be loaded: ask for the key alone, which reads no snapshot.
    return new Promise((resolve, reject) => {
      const request = this.getDB().transaction([this.storeName], 'readonly').objectStore(this.storeName).getKey(checkpointId);
      request.onsuccess = () => resolve(request.result !== undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async pinCheckpoint(checkpointId: string): Promise<boolean> {
    return this.setPinned(checkpointId, true);
  }

  async unpinCheckpoint(checkpointId: string): Promise<boolean> {
    return this.setPinned(checkpointId, false);
  }

  /**
   * Save's step past the previous save: take off a pin an earlier Save put on it, leaving one the
   * person made.
   */
  async releaseSavePin(checkpointId: string): Promise<boolean> {
    await this.initDB();
    const full = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!full) return false;
    if (full.pinnedBy === 'user') return true;
    return this.setPinned(checkpointId, false);
  }

  /**
   * Name a checkpoint. The name is the person's own text, so it is stored as the description and
   * shown as typed, in place of the app's translated label. A named checkpoint is kept, so pruning
   * never takes one the person named.
   */
  async renameCheckpoint(checkpointId: string, name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;
    await this.initDB();
    const full = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!full) return false;
    await this.ensureProjectLoaded(full.projectId);
    const meta = this.checkpointMetadata.get(checkpointId);
    if (!meta) return false;

    for (const record of [full, meta]) {
      record.description = trimmed;
      record.label = undefined;
      record.pinned = true;
      record.pinnedBy = 'user';
    }
    await this.saveCheckpointToDB(full);
    return true;
  }

  /**
   * Delete one checkpoint, pinned or not. Not the project's current save, which Discard Changes
   * goes back to. Anything else pointing at it (an Undo step, a chat turn's restore) already
   * reports a checkpoint that no longer exists.
   */
  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    await this.initDB();
    const full = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!full) return false;
    try {
      if ((await getActiveVFS().getProject(full.projectId))?.lastSavedCheckpointId === checkpointId) return false;
    } catch { /* no project record: nothing depends on it */ }

    await this.deleteCheckpointFromDB(checkpointId);
    this.checkpointMetadata.delete(checkpointId);
    return true;
  }

  private async setPinned(checkpointId: string, pinned: boolean): Promise<boolean> {
    await this.initDB();

    const full = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!full) return false;
    await this.ensureProjectLoaded(full.projectId);

    const meta = this.checkpointMetadata.get(checkpointId);
    if (!meta) return false;

    meta.pinned = pinned;
    meta.pinnedBy = pinned ? 'user' : undefined;
    this.checkpointMetadata.set(checkpointId, meta);

    full.pinned = pinned;
    full.pinnedBy = meta.pinnedBy;
    await this.saveCheckpointToDB(full);

    if (!pinned) {
      await this.pruneUnpinned(meta.projectId);
    }

    return true;
  }

  /**
   * Clear all non-pinned checkpoints for a project
   */
  async clearCheckpoints(projectId: string): Promise<void> {
    await this.ensureProjectLoaded(projectId);

    const toDelete: string[] = [];
    for (const [id, meta] of this.checkpointMetadata) {
      if (meta.projectId === projectId && !meta.pinned) {
        this.checkpointMetadata.delete(id);
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      await this.deleteCheckpointFromDB(id);
    }

    if (this.currentCheckpoint && toDelete.includes(this.currentCheckpoint)) {
      this.currentCheckpoint = null;
    }
  }

  /**
   * Clear non-manual, non-pinned checkpoints for a project.
   * Called when conversation is cleared.
   */
  async clearAutoCheckpoints(projectId: string): Promise<void> {
    await this.ensureProjectLoaded(projectId);

    const toDelete: string[] = [];
    for (const [id, meta] of this.checkpointMetadata) {
      if (meta.projectId === projectId && meta.kind !== 'manual' && !meta.pinned) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.checkpointMetadata.delete(id);
      await this.deleteCheckpointFromDB(id);
    }

    if (this.currentCheckpoint && toDelete.includes(this.currentCheckpoint)) {
      this.currentCheckpoint = null;
    }

    if (toDelete.length > 0) {
      logger.debug(`[CheckpointManager] Cleared ${toDelete.length} auto-checkpoints for project ${projectId}`);
    }
  }

  /**
   * Unload all checkpoint metadata for a project from memory
   * Checkpoints remain in IndexedDB and can be reloaded on demand
   * This is called when leaving a project to free up memory
   */
  unloadProject(projectId: string): void {
    // Read again on the next open, so checkpoints written meanwhile (a run in another tab) show.
    this.loadedProjects.delete(projectId);
    let unloadedCount = 0;
    for (const [id, meta] of this.checkpointMetadata) {
      if (meta.projectId === projectId) {
        this.checkpointMetadata.delete(id);
        unloadedCount++;
      }
    }

    // Reset current checkpoint if it was from this project
    if (this.currentCheckpoint) {
      const current = this.checkpointMetadata.get(this.currentCheckpoint);
      if (!current) {
        this.currentCheckpoint = null;
      }
    }

    if (unloadedCount > 0) {
      logger.debug(`[CheckpointManager] Unloaded ${unloadedCount} checkpoint metadata for project ${projectId} from memory`);
    }
  }

}

export const checkpointManager = new CheckpointManager();
