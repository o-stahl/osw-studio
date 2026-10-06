import JSZip from 'jszip';
import { Project, VirtualFile } from './types';
import { Checkpoint } from './checkpoint';
import { arrayBufferToBase64, base64ToArrayBuffer } from './binary-encoding';
import { logger } from '@/lib/utils';
import { translator } from '@/lib/i18n/runtime';

export interface BackupData {
  version: string;
  exportDate: string;
  databases: {
    /**
     * One key per IndexedDB object store. Older backups carry only projects/files/fileTree
     * (+ conversations/checkpoints at the top level); anything present is restored, anything
     * missing is skipped, so both directions stay compatible.
     */
    vfs: Record<string, unknown[]> & {
      projects: Project[];
      files: VirtualFile[];
      fileTree: unknown[];
    };
    conversations: any[]; // Legacy field, kept so older builds can still read this file
    checkpoints: Checkpoint[]; // Legacy field, kept for the same reason
  };
  metadata: {
    projectCount: number;
    totalSize: number;
    exportedFrom: 'deepstudio' | 'oswstudio';
  };
}

export type BackupImportStage = 'reading' | 'validating' | 'clearing' | 'importing' | 'done';

export interface ImportOptions {
  mode: 'replace' | 'merge';
  onProgress?: (progress: number, stage: BackupImportStage) => void;
}

/** Marker for a value that was an ArrayBuffer before JSON encoding. */
interface EncodedBinary {
  _isBinaryBase64: true;
  data: string;
}

function isEncodedBinary(value: unknown): value is EncodedBinary {
  return (
    typeof value === 'object'
    && value !== null
    && (value as EncodedBinary)._isBinaryBase64 === true
    && typeof (value as EncodedBinary).data === 'string'
  );
}

/**
 * A tag check rather than `instanceof`: IndexedDB hands back structured clones, which can carry a
 * constructor from another realm. `value instanceof ArrayBuffer` is then false for something that
 * is unmistakably an ArrayBuffer, and the content would be silently written out as `{}`.
 */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

export class BackupService {
  private static readonly BACKUP_VERSION = '1.9.0';
  private static readonly FILE_EXTENSION = '.osws';
  private static readonly MAX_IMPORT_SIZE = 100 * 1024 * 1024; // 100MB
  /** Stores whose records track when they last synced with a server. */
  private static readonly SYNC_TRACKED_STORES = ['projects', 'skills'];

  /**
   * Export all IndexedDB data to a downloadable backup file
   */
  static async exportAllData(): Promise<void> {
    try {
      logger.info('Starting data export...');

      const vfs = await this.readLiveDatabase();

      const backupData: BackupData = {
        version: this.BACKUP_VERSION,
        exportDate: new Date().toISOString(),
        databases: {
          vfs,
          conversations: [], // Legacy field, now part of the unified export
          checkpoints: [], // Legacy field, now part of the unified export
        },
        metadata: {
          projectCount: vfs.projects.length,
          totalSize: 0,
          exportedFrom: 'oswstudio',
        },
      };

      backupData.metadata.totalSize = this.calculateDataSize(backupData);

      // Create compressed backup file
      const zip = new JSZip();
      zip.file('backup.json', JSON.stringify(backupData, null, 2));

      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      // Download the file
      const filename = `oswstudio-backup-${new Date().toISOString().split('T')[0]}${this.FILE_EXTENSION}`;
      this.downloadBlob(blob, filename);

      logger.info(`Export completed: ${backupData.metadata.projectCount} projects, ${this.formatBytes(backupData.metadata.totalSize)}`);
    } catch (error) {
      logger.error('Export failed:', error);
      throw new Error(translator()('settings.backup.exportFailed', { error: error instanceof Error ? error.message : translator()('common.labels.unknown') }));
    }
  }

  /**
   * Import data from a backup file
   */
  static async importAllData(file: File, options: ImportOptions = { mode: 'merge' }): Promise<void> {
    try {
      // Validate file
      if (!file.name.endsWith(this.FILE_EXTENSION)) {
        throw new Error(translator()('settings.backup.invalidType', { ext: this.FILE_EXTENSION }));
      }

      if (file.size > this.MAX_IMPORT_SIZE) {
        throw new Error(translator()('settings.backup.tooLarge', { size: this.formatBytes(this.MAX_IMPORT_SIZE) }));
      }

      options.onProgress?.(10, 'reading');

      // Read and parse backup file
      const zip = new JSZip();
      const zipData = await zip.loadAsync(file);
      const backupFile = zipData.file('backup.json');

      if (!backupFile) {
        throw new Error(translator()('settings.backup.invalidFormat'));
      }

      const backupJson = await backupFile.async('string');
      const backupData: BackupData = JSON.parse(backupJson);

      // Validate backup data
      this.validateBackupData(backupData);

      options.onProgress?.(30, 'validating');

      // Older backups keep conversations and checkpoints beside vfs rather than inside it.
      const stores: Record<string, unknown[]> = {
        ...backupData.databases.vfs,
        conversations:
          (backupData.databases.vfs as Record<string, unknown[]>).conversations
          || backupData.databases.conversations
          || [],
        checkpoints:
          (backupData.databases.vfs as Record<string, unknown[]>).checkpoints
          || backupData.databases.checkpoints
          || [],
      };

      for (const name of this.SYNC_TRACKED_STORES) {
        if (Array.isArray(stores[name])) {
          stores[name] = this.stripForeignSyncState(stores[name]);
        }
      }

      const db = await this.getLiveDatabase();

      if (options.mode === 'replace') {
        options.onProgress?.(40, 'clearing');
        await this.clearLiveDatabase(db);
      }

      options.onProgress?.(50, 'importing');
      const written = await this.writeStores(db, stores);

      options.onProgress?.(100, 'done');

      logger.info(
        `Import completed: ${(stores.projects || []).length} projects restored into ${db.name} (${written.join(', ')})` // i18n-ignore: a log line
      );
    } catch (error) {
      logger.error('Import failed:', error);
      throw new Error(translator()('settings.backup.importFailed', { error: error instanceof Error ? error.message : translator()('common.labels.unknown') }));
    }
  }

  /**
   * Validate if a file is a valid backup
   */
  static async validateBackupFile(file: File): Promise<{ valid: boolean; reason?: string; metadata?: BackupData['metadata'] }> {
    try {
      if (!file.name.endsWith(this.FILE_EXTENSION)) {
        return { valid: false, reason: translator()('settings.backup.invalidType', { ext: this.FILE_EXTENSION }) };
      }

      if (file.size > this.MAX_IMPORT_SIZE) {
        return { valid: false, reason: translator()('settings.backup.tooLarge', { size: this.formatBytes(this.MAX_IMPORT_SIZE) }) };
      }

      const zip = new JSZip();
      const zipData = await zip.loadAsync(file);
      const backupFile = zipData.file('backup.json');

      if (!backupFile) {
        return { valid: false, reason: translator()('settings.backup.invalidFormat') };
      }

      const backupJson = await backupFile.async('string');
      const backupData: BackupData = JSON.parse(backupJson);

      this.validateBackupData(backupData);

      return { valid: true, metadata: backupData.metadata };
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : translator()('common.labels.unknown') };
    }
  }

  // Private helper methods

  /**
   * The database the app is actually using.
   *
   * Never open one by name here: outside browser mode the live database is named after the
   * workspace, and its schema version moves with the app. Opening a hardcoded name and version
   * meant export failed outright and import wrote into an unrelated database while reporting
   * success. The adapter owns both, so ask it.
   */
  private static async getLiveDatabase(): Promise<IDBDatabase> {
    const { vfs } = await import('@/lib/vfs');
    await vfs.init();
    return vfs.getDatabase();
  }

  /**
   * Read every object store in the live schema.
   *
   * Driven by the database's own store list rather than a hardcoded one, so a store added later
   * is backed up automatically instead of being silently missing from every backup.
   */
  private static async readLiveDatabase(): Promise<BackupData['databases']['vfs']> {
    const db = await this.getLiveDatabase();
    const storeNames = Array.from(db.objectStoreNames);
    const result: Record<string, unknown[]> = {};

    if (storeNames.length > 0) {
      await new Promise<void>((resolve, reject) => {
        // One transaction for the whole read, so the backup is a consistent snapshot.
        const tx = db.transaction(storeNames, 'readonly');
        for (const name of storeNames) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            result[name] = (request.result || []).map((record) => this.encodeBinary(record)) as unknown[];
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Export transaction aborted'));
      });
    }

    return {
      projects: [],
      files: [],
      fileTree: [],
      ...result,
    } as BackupData['databases']['vfs'];
  }

  /**
   * Drop the sync stamps a restored record carries in from the backup.
   *
   * lastSyncedAt and serverUpdatedAt describe a sync to whichever instance the backup was taken
   * from. Restored verbatim, every later comparison is made against that foreign history. For a
   * project that means it can never settle:
   *
   *  - if this server also has the project, both sides look changed since that stamp, so it reads
   *    'conflict' — and a conflicting push is rejected outright, so it cannot be resolved by
   *    pushing;
   *  - if this server has never seen it, the reconcile's "the local record says this was pushed,
   *    yet the server does not have it" guard vetoes the upload, leaving it on 'Local only' until
   *    it is pushed by hand.
   *
   * Skills carry the same two stamps and so report the same false drift, though nothing blocks
   * pushing one by hand. syncStatus is a project-only field; deleting it from a record that has
   * none is a no-op.
   *
   * A restored record has not synced to this server, whatever the backup claims. Saying so lets
   * the ordinary reconcile push it, which is the behaviour the restore path was built for.
   */
  private static stripForeignSyncState(records: unknown[]): unknown[] {
    return records.map((record) => {
      if (!record || typeof record !== 'object') return record;
      const copy = { ...(record as Record<string, unknown>) };
      delete copy.lastSyncedAt;
      delete copy.serverUpdatedAt;
      delete copy.syncStatus;
      return copy;
    });
  }

  /**
   * Write the backup's records into the live database.
   *
   * Keys with no matching object store are skipped rather than failing the whole import, so a
   * backup taken on a newer build still restores everything this build understands.
   * Returns the store names that were written.
   */
  private static async writeStores(db: IDBDatabase, stores: Record<string, unknown[]>): Promise<string[]> {
    const targets = Object.keys(stores).filter(
      (name) => db.objectStoreNames.contains(name) && Array.isArray(stores[name]) && stores[name].length > 0
    );
    const skipped = Object.keys(stores).filter(
      (name) => !db.objectStoreNames.contains(name) && Array.isArray(stores[name]) && stores[name].length > 0
    );
    if (skipped.length > 0) {
      logger.warn(`[Backup] Backup contains unknown stores, skipped: ${skipped.join(', ')}`);
    }
    if (targets.length === 0) return [];

    await new Promise<void>((resolve, reject) => {
      // A single transaction so a failure part-way through rolls the whole restore back rather
      // than leaving half the data in place. Every put is issued synchronously: awaiting between
      // them would let the transaction auto-commit before the rest were queued.
      const tx = db.transaction(targets, 'readwrite');
      for (const name of targets) {
        const store = tx.objectStore(name);
        for (const record of stores[name]) {
          store.put(this.decodeBinary(record));
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Import transaction aborted'));
    });

    return targets;
  }

  /**
   * Empty every store in the live database for a replace-mode import.
   *
   * Clears in place rather than deleting the database. Deleting meant closing every open
   * connection first (which never actually happened, so deletion blocked and timed out), and
   * recreating the database from the backup service left it on an outdated schema version.
   */
  private static async clearLiveDatabase(db: IDBDatabase): Promise<void> {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');
      for (const name of storeNames) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Clear transaction aborted'));
    });

    logger.info('[Backup] Existing data cleared');
  }

  /**
   * Replace ArrayBuffers with a base64 marker so binary file content survives JSON.
   * Without this every image and font in a backup was written out as `{}`.
   */
  private static encodeBinary(value: unknown): unknown {
    if (isArrayBuffer(value)) {
      return { _isBinaryBase64: true, data: arrayBufferToBase64(value) };
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.encodeBinary(entry));
    }
    if (value instanceof Date || value === null || typeof value !== 'object') {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this.encodeBinary(entry);
    }
    return out;
  }

  /** Inverse of encodeBinary. Records from older backups pass through untouched. */
  private static decodeBinary(value: unknown): unknown {
    if (isEncodedBinary(value)) {
      return base64ToArrayBuffer(value.data);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.decodeBinary(entry));
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = this.decodeBinary(entry);
    }
    return out;
  }

  private static validateBackupData(data: BackupData): void {
    if (!data.version || !data.exportDate || !data.databases || !data.metadata) {
      throw new Error(translator()('settings.backup.invalidStructure'));
    }

    if (!data.databases.vfs || !data.databases.conversations || !data.databases.checkpoints) {
      throw new Error(translator()('settings.backup.incomplete'));
    }

    // Version compatibility check (for future versions)
    const backupVersion = data.version.split('.').map(Number);
    const currentVersion = this.BACKUP_VERSION.split('.').map(Number);

    if (backupVersion[0] > currentVersion[0]) {
      throw new Error(translator()('settings.backup.incompatible', { version: String(data.version), current: this.BACKUP_VERSION }));
    }
  }

  private static calculateDataSize(data: BackupData): number {
    return JSON.stringify(data).length;
  }

  private static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private static downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
