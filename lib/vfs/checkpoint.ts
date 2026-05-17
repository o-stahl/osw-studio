import { getActiveVFS } from './index';
import { logger } from '@/lib/utils';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';

export type CheckpointKind = 'auto' | 'manual';

// File content can be either a string or base64-encoded binary data
interface CheckpointFileContent {
  data: string;
  encoding?: 'base64';
}

// Full checkpoint with file contents (only used during create/restore)
export interface Checkpoint {
  id: string;
  timestamp: string;
  description: string;
  files: Map<string, string | CheckpointFileContent>;
  directories: Set<string>;
  projectId: string;
  kind: CheckpointKind;
  pinned?: boolean;
  baseRevisionId?: string | null;
}

// Lightweight metadata for listing (kept in RAM)
export interface CheckpointMetadata {
  id: string;
  timestamp: string;
  description: string;
  projectId: string;
  kind: CheckpointKind;
  pinned?: boolean;
  baseRevisionId?: string | null;
}

// Serializable checkpoint format for storage
interface StoredCheckpoint {
  id: string;
  timestamp: string;
  description: string;
  files: [string, string | CheckpointFileContent][];
  directories: string[];
  projectId: string;
  kind?: CheckpointKind;
  pinned?: boolean;
  baseRevisionId?: string | null;
}

// Compressed checkpoint format — lz-string UTF-16 encoded files+directories
interface StoredCheckpointCompressed {
  id: string;
  timestamp: string;
  description: string;
  projectId: string;
  kind?: CheckpointKind;
  pinned?: boolean;
  baseRevisionId?: string | null;
  compressed: true;
  compressedData: string; // lz-string UTF-16 compressed JSON of { files, directories }
}

type StoredCheckpointAny = StoredCheckpoint | StoredCheckpointCompressed;

interface CreateCheckpointOptions {
  kind?: CheckpointKind;
  baseRevisionId?: string | null;
}

const MAX_UNPINNED_PER_PROJECT = 5;

class CheckpointManager {
  // LAZY LOADING: Only store metadata in RAM, not full checkpoint data
  private checkpointMetadata: Map<string, CheckpointMetadata> = new Map();
  private currentCheckpoint: string | null = null;
  private storeName = 'checkpoints';
  private isInitialized = false;

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
    await this.loadCheckpointMetadataFromDB();
  }

  /**
   * Get shared database connection from VFS
   */
  private getDB(): IDBDatabase {
    const activeVFS = getActiveVFS();
    return activeVFS.getDatabase();
  }

  /**
   * LAZY LOADING: Only load checkpoint metadata into RAM, not file contents.
   * Full checkpoint data stays in IndexedDB and is loaded on-demand during restore.
   */
  private async loadCheckpointMetadataFromDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const db = this.getDB();
      const transaction = db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        const storedCheckpoints = request.result as StoredCheckpointAny[];
        this.checkpointMetadata.clear();

        for (const stored of storedCheckpoints) {
          // Only store metadata, NOT file contents
          const metadata: CheckpointMetadata = {
            id: stored.id,
            timestamp: stored.timestamp,
            description: stored.description,
            projectId: stored.projectId,
            kind: stored.kind || 'auto',
            pinned: stored.pinned ?? false,
            baseRevisionId: stored.baseRevisionId ?? null
          };
          this.checkpointMetadata.set(stored.id, metadata);
        }

        resolve();
      };

      request.onerror = () => {
        logger.error('Failed to load checkpoint metadata from DB');
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
        } else {
          // Legacy uncompressed format
          const legacy = stored as StoredCheckpoint;
          files = new Map(legacy.files);
          directories = new Set(legacy.directories);
        }

        const checkpoint: Checkpoint = {
          id: stored.id,
          timestamp: stored.timestamp,
          description: stored.description,
          projectId: stored.projectId,
          kind: stored.kind || 'auto',
          pinned: stored.pinned ?? false,
          baseRevisionId: stored.baseRevisionId ?? null,
          files,
          directories
        };
        resolve(checkpoint);
      };

      request.onerror = () => {
        logger.error('Failed to load checkpoint from DB');
        reject(request.error);
      };
    });
  }
  
  /**
   * Save a checkpoint to IndexedDB
   */
  private async saveCheckpointToDB(checkpoint: Checkpoint): Promise<void> {
    await this.initDB();

    let record: StoredCheckpoint | StoredCheckpointCompressed;

    try {
      const payload = JSON.stringify({
        files: Array.from(checkpoint.files.entries()),
        directories: Array.from(checkpoint.directories)
      });
      const compressedData = compressToUTF16(payload);

      record = {
        id: checkpoint.id,
        timestamp: checkpoint.timestamp,
        description: checkpoint.description,
        projectId: checkpoint.projectId,
        kind: checkpoint.kind,
        pinned: checkpoint.pinned ?? false,
        baseRevisionId: checkpoint.baseRevisionId ?? null,
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
        baseRevisionId: checkpoint.baseRevisionId ?? null
      };
    }

    return new Promise((resolve, reject) => {
      let db: IDBDatabase;
      try {
        db = this.getDB();
      } catch (err) {
        reject(err);
        return;
      }
      const transaction = db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => {
        logger.error('Failed to save checkpoint to DB');
        reject(request.error);
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
      const transaction = db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(checkpointId);

      request.onsuccess = () => resolve();
      request.onerror = () => {
        logger.error('Failed to delete checkpoint from DB');
        reject(request.error);
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
    await this.initDB();
    const activeVFS = getActiveVFS();
    await activeVFS.init();

    const files = await activeVFS.listDirectory(projectId, '/');
    const fileContents = new Map<string, string | CheckpointFileContent>();
    const directories = new Set<string>();

    for (const file of files) {
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

    const checkpoint: Checkpoint = {
      id: `cp_${Date.now()}`,
      timestamp: new Date().toISOString(),
      description,
      files: fileContents,
      directories,
      projectId,
      kind: options.kind || 'auto',
      baseRevisionId: options.baseRevisionId ?? null
    };

    const metadata: CheckpointMetadata = {
      id: checkpoint.id,
      timestamp: checkpoint.timestamp,
      description: checkpoint.description,
      projectId: checkpoint.projectId,
      kind: checkpoint.kind,
      pinned: false,
      baseRevisionId: checkpoint.baseRevisionId
    };
    this.checkpointMetadata.set(checkpoint.id, metadata);
    this.currentCheckpoint = checkpoint.id;

    await this.saveCheckpointToDB(checkpoint);
    await this.pruneUnpinned(projectId);

    return checkpoint;
  }

  private async pruneUnpinned(projectId: string): Promise<void> {
    const unpinned = Array.from(this.checkpointMetadata.values())
      .filter(cp => cp.projectId === projectId && !cp.pinned)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (unpinned.length <= MAX_UNPINNED_PER_PROJECT) return;

    const toDelete = unpinned.slice(0, unpinned.length - MAX_UNPINNED_PER_PROJECT);
    for (const cp of toDelete) {
      this.checkpointMetadata.delete(cp.id);
      await this.deleteCheckpointFromDB(cp.id);
    }

    if (toDelete.length > 0) {
      logger.debug(`[CheckpointManager] Pruned ${toDelete.length} old checkpoints for project ${projectId}`);
    }
  }
  
  /**
   * Restore project to a checkpoint
   */
  async restoreCheckpoint(checkpointId: string): Promise<boolean> {
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
          await activeVFS.updateFile(checkpoint.projectId, path, actualContent, { silent: true });
        } else {
          await activeVFS.createFile(checkpoint.projectId, path, actualContent, { silent: true });
        }
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }

      this.currentCheckpoint = checkpointId;
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
    await this.initDB();

    // If we have no metadata for this project, reload from IDB — another project's
    // data may have been loaded and this one was never fetched or was unloaded.
    const hasAny = Array.from(this.checkpointMetadata.values()).some(cp => cp.projectId === projectId);
    if (!hasAny) {
      await this.loadCheckpointMetadataFromDB();
    }

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

    // Check metadata (which is always loaded)
    return this.checkpointMetadata.has(checkpointId);
  }

  async pinCheckpoint(checkpointId: string): Promise<boolean> {
    return this.setPinned(checkpointId, true);
  }

  async unpinCheckpoint(checkpointId: string): Promise<boolean> {
    return this.setPinned(checkpointId, false);
  }

  private async setPinned(checkpointId: string, pinned: boolean): Promise<boolean> {
    await this.initDB();

    const meta = this.checkpointMetadata.get(checkpointId);
    if (!meta) return false;

    meta.pinned = pinned;
    this.checkpointMetadata.set(checkpointId, meta);

    const full = await this.loadSingleCheckpointFromDB(checkpointId);
    if (!full) return false;

    full.pinned = pinned;
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
    await this.initDB();

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
    await this.initDB();

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

    // Force metadata reload on next operation so checkpoints created
    // while the workspace was unmounted (e.g. during background generation)
    // are visible when the project is re-opened
    if (unloadedCount > 0) {
      this.isInitialized = false;
      logger.debug(`[CheckpointManager] Unloaded ${unloadedCount} checkpoint metadata for project ${projectId} from memory`);
    }
  }

}

export const checkpointManager = new CheckpointManager();
