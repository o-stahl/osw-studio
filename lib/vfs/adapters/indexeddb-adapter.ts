/**
 * IndexedDB Storage Adapter
 *
 * Wraps the existing IndexedDB implementation to conform to StorageAdapter interface.
 * Used in both browser mode (only storage) and Server mode (working storage).
 */

import { Project, VirtualFile, FileTreeNode, CustomTemplate, EdgeFunction, ServerFunction, Secret, ScheduledFunction } from '../types';
import { Skill } from '../skills/types';
import { StorageAdapter } from './types';
import { FALLBACK_RUNTIME, normalizeProjectSettings, settingsNeedNormalizing } from '../project-settings';

const DEFAULT_DB_NAME = 'osw-studio-db';
const DB_VERSION = 8; // v8: repair malformed project settings and fill in a missing runtime

export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private dbName: string;

  constructor(dbName?: string) {
    this.dbName = dbName || DEFAULT_DB_NAME;
  }

  async init(): Promise<void> {
    // Re-init if the connection was lost (e.g., close() called, HMR, or browser eviction)
    if (this.initPromise && this.db) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        // VFS object stores
        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('name', 'name', { unique: false });
          projectStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('files')) {
          const fileStore = db.createObjectStore('files', { keyPath: 'id' });
          fileStore.createIndex('projectId', 'projectId', { unique: false });
          fileStore.createIndex('path', ['projectId', 'path'], { unique: true });
          fileStore.createIndex('type', 'type', { unique: false });
        }

        if (!db.objectStoreNames.contains('fileTree')) {
          const treeStore = db.createObjectStore('fileTree', { keyPath: 'id' });
          treeStore.createIndex('projectId', 'projectId', { unique: false });
          treeStore.createIndex('path', ['projectId', 'path'], { unique: true });
          treeStore.createIndex('parentPath', ['projectId', 'parentPath'], { unique: false });
        }

        // Conversations object store (browser-only, not part of adapter interface)
        if (!db.objectStoreNames.contains('conversations')) {
          const conversationStore = db.createObjectStore('conversations', { keyPath: 'id' });
          conversationStore.createIndex('projectId', 'projectId', { unique: false });
          conversationStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
        }

        // Checkpoints object store (browser-only, not part of adapter interface)
        if (!db.objectStoreNames.contains('checkpoints')) {
          const checkpointStore = db.createObjectStore('checkpoints', { keyPath: 'id' });
          checkpointStore.createIndex('projectId', 'projectId', { unique: false });
          checkpointStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Custom Templates object store
        if (!db.objectStoreNames.contains('customTemplates')) {
          const templateStore = db.createObjectStore('customTemplates', { keyPath: 'id' });
          templateStore.createIndex('name', 'name', { unique: false });
          templateStore.createIndex('importedAt', 'importedAt', { unique: false });
        }

        // Custom Skills object store (migrated from localStorage)
        if (!db.objectStoreNames.contains('skills')) {
          const skillsStore = db.createObjectStore('skills', { keyPath: 'id' });
          skillsStore.createIndex('name', 'name', { unique: false });
          skillsStore.createIndex('isBuiltIn', 'isBuiltIn', { unique: false });
        }

        // Debug Events object store
        if (!db.objectStoreNames.contains('debugEvents')) {
          const debugEventsStore = db.createObjectStore('debugEvents', { keyPath: 'id' });
          debugEventsStore.createIndex('projectId', 'projectId', { unique: false });
          debugEventsStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Edge Functions (project-scoped backend features)
        if (!db.objectStoreNames.contains('edgeFunctions')) {
          const edgeFnStore = db.createObjectStore('edgeFunctions', { keyPath: 'id' });
          edgeFnStore.createIndex('projectId', 'projectId', { unique: false });
          edgeFnStore.createIndex('projectIdName', ['projectId', 'name'], { unique: true });
        }

        // Server Functions (project-scoped backend features)
        if (!db.objectStoreNames.contains('serverFunctions')) {
          const serverFnStore = db.createObjectStore('serverFunctions', { keyPath: 'id' });
          serverFnStore.createIndex('projectId', 'projectId', { unique: false });
          serverFnStore.createIndex('projectIdName', ['projectId', 'name'], { unique: true });
        }

        // Secrets (project-scoped backend features)
        if (!db.objectStoreNames.contains('secrets')) {
          const secretsStore = db.createObjectStore('secrets', { keyPath: 'id' });
          secretsStore.createIndex('projectId', 'projectId', { unique: false });
          secretsStore.createIndex('projectIdName', ['projectId', 'name'], { unique: true });
        }

        // Scheduled Functions (project-scoped backend features)
        if (!db.objectStoreNames.contains('scheduledFunctions')) {
          const schedFnStore = db.createObjectStore('scheduledFunctions', { keyPath: 'id' });
          schedFnStore.createIndex('projectId', 'projectId', { unique: false });
          schedFnStore.createIndex('projectIdName', ['projectId', 'name'], { unique: true });
        }

        // v6: Migrate runtime 'static' → 'handlebars' for existing projects and custom templates
        if (oldVersion < 6) {
          const tx = (event.target as IDBOpenDBRequest).transaction!;

          if (db.objectStoreNames.contains('projects')) {
            const projectStore = tx.objectStore('projects');
            projectStore.openCursor().onsuccess = (e) => {
              const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
              if (cursor) {
                const project = cursor.value;
                // Normalized before the field is read or written. `project.settings` is not
                // always the record the type says: a stored JSON string is truthy, so
                // `settings || {}` kept it and the assignment below threw TypeError on a string
                // primitive -- aborting this cursor and leaving every later project unmigrated.
                const settings = normalizeProjectSettings(project.settings);
                if (!settings.runtime || settings.runtime === 'static') {
                  settings.runtime = 'handlebars';
                }
                project.settings = settings;
                cursor.update(project);
                cursor.continue();
              }
            };
          }

          if (db.objectStoreNames.contains('customTemplates')) {
            const templateStore = tx.objectStore('customTemplates');
            templateStore.openCursor().onsuccess = (e) => {
              const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
              if (cursor) {
                const template = cursor.value;
                if (!template.runtime || template.runtime === 'static') {
                  template.runtime = 'handlebars';
                  cursor.update(template);
                }
                cursor.continue();
              }
            };
          }
        }

        // v8: Repair project settings that are not the record the type says, and fill in a runtime.
        //
        // Reading them is already normalized (`hydrateProject`), so this is about what is *stored*:
        // until a project is written back through a path that normalizes, its row keeps a JSON
        // string, stacked encoding layers, or the character keys a spread left behind -- and
        // anything reading the row directly still sees them.
        //
        // Separate from v6 rather than folded into it: v6 has already run for existing installs,
        // and the projects its cursor never reached because of the throw above are exactly the ones
        // that need this.
        if (oldVersion < 8 && db.objectStoreNames.contains('projects')) {
          const tx = (event.target as IDBOpenDBRequest).transaction!;
          const projectStore = tx.objectStore('projects');
          projectStore.openCursor().onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (!cursor) return;
            const project = cursor.value;
            const settings = normalizeProjectSettings(project.settings);
            // A missing runtime is filled in, not only a malformed record. This is what v6 set out
            // to do; the projects it never reached because its cursor threw are exactly the ones
            // still without one, and they have been rendered as the fallback ever since. Writing it
            // down is also what stops a checkpoint from capturing "no runtime" and a later restore
            // from deleting a choice made after it.
            if (!settings.runtime) settings.runtime = FALLBACK_RUNTIME;
            if (settingsNeedNormalizing(project.settings) || project.settings?.runtime !== settings.runtime) {
              // updatedAt is deliberately not touched: a migration is not an edit, and bumping it
              // would show every project in the workspace as "Local newer" in Server Sync.
              project.settings = settings;
              cursor.update(project);
            }
            cursor.continue();
          };
        }
      };
    });
    return this.initPromise;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDB(): IDBDatabase {
    if (!this.db) {
      throw new Error('IndexedDB not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Public getter for shared database access (used by checkpoint and conversation managers)
   * This is NOT part of the StorageAdapter interface but needed for legacy compatibility
   */
  getDatabase(): IDBDatabase {
    return this.getDB();
  }

  // ============================================
  // Projects
  // ============================================

  async createProject(project: Project): Promise<void> {
    const tx = this.getDB().transaction(['projects'], 'readwrite');
    const store = tx.objectStore('projects');
    await this.promisify(store.add(project));
  }

  async getProject(id: string): Promise<Project | null> {
    const tx = this.getDB().transaction(['projects'], 'readonly');
    const store = tx.objectStore('projects');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateProject(result as Project) : null;
  }

  async updateProject(project: Project): Promise<void> {
    const tx = this.getDB().transaction(['projects'], 'readwrite');
    const store = tx.objectStore('projects');
    await this.promisify(store.put(project));
  }

  async deleteProject(id: string): Promise<void> {
    const db = this.getDB();

    // Phase 1 (read): Collect all item IDs to delete from each store
    const files = await this.listFiles(id);
    const fileIds = files.map(f => f.id);

    const treeNodes = await this.getAllTreeNodes(id);
    const treeNodeIds = treeNodes.map(n => n.id);

    const edgeFunctions = await this.listEdgeFunctions(id);
    const edgeFunctionIds = edgeFunctions.map(f => f.id);

    const serverFunctions = await this.listServerFunctions(id);
    const serverFunctionIds = serverFunctions.map(f => f.id);

    const secrets = await this.listSecrets(id);
    const secretIds = secrets.map(s => s.id);

    const scheduledFunctions = await this.listScheduledFunctions(id);
    const scheduledFunctionIds = scheduledFunctions.map(f => f.id);

    // Phase 2 (write): Delete all items in a single multi-store transaction for atomicity
    const history = ['checkpoints', 'debugEvents', 'conversations'].filter(name => db.objectStoreNames.contains(name));
    const storeNames = ['projects', 'files', 'fileTree', 'edgeFunctions', 'serverFunctions', 'secrets', 'scheduledFunctions', ...history];
    const tx = db.transaction(storeNames, 'readwrite');

    // The project's chat, checkpoints and old conversations, found by the projectId index.
    for (const name of history) {
      tx.objectStore(name).index('projectId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursor | null>).result;
        if (!cursor) return;
        tx.objectStore(name).delete(cursor.primaryKey);
        cursor.continue();
      };
    }

    const deleteFromStore = (storeName: string, ids: string[]) => {
      const store = tx.objectStore(storeName);
      for (const itemId of ids) {
        store.delete(itemId);
      }
    };

    deleteFromStore('files', fileIds);
    deleteFromStore('fileTree', treeNodeIds);
    deleteFromStore('edgeFunctions', edgeFunctionIds);
    deleteFromStore('serverFunctions', serverFunctionIds);
    deleteFromStore('secrets', secretIds);
    deleteFromStore('scheduledFunctions', scheduledFunctionIds);
    tx.objectStore('projects').delete(id);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  async listProjects(fields?: string[]): Promise<Project[]> {
    const tx = this.getDB().transaction(['projects'], 'readonly');
    const store = tx.objectStore('projects');
    const result = await this.promisify(store.getAll());
    const projects = (result as Project[] | undefined)?.map((project) => this.hydrateProject(project)) || [];

    // If specific fields requested, filter them (client-side for IndexedDB)
    if (fields && fields.length > 0) {
      return projects.map(project => {
        const filtered: any = {};
        fields.forEach(field => {
          if (field in project) {
            filtered[field] = project[field as keyof typeof project];
          }
        });
        return filtered;
      });
    }

    return projects;
  }

  // ============================================
  // Files
  // ============================================

  async createFile(file: VirtualFile): Promise<void> {
    const tx = this.getDB().transaction(['files'], 'readwrite');
    const store = tx.objectStore('files');
    await this.promisify(store.add(file));
  }

  async getFile(projectId: string, path: string): Promise<VirtualFile | null> {
    const tx = this.getDB().transaction(['files'], 'readonly');
    const store = tx.objectStore('files');
    const index = store.index('path');
    const result = await this.promisify(index.get([projectId, path]));
    return result || null;
  }

  async updateFile(file: VirtualFile): Promise<void> {
    const tx = this.getDB().transaction(['files'], 'readwrite');
    const store = tx.objectStore('files');
    await this.promisify(store.put(file));
  }

  async deleteFile(projectId: string, path: string): Promise<void> {
    const file = await this.getFile(projectId, path);
    if (file) {
      const tx = this.getDB().transaction(['files'], 'readwrite');
      const store = tx.objectStore('files');
      await this.promisify(store.delete(file.id));
    }
  }

  async listFiles(projectId: string): Promise<VirtualFile[]> {
    const tx = this.getDB().transaction(['files'], 'readonly');
    const store = tx.objectStore('files');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return result || [];
  }

  async listFilePaths(projectId: string): Promise<string[]> {
    // A key cursor over the [projectId, path] index: the paths, and none of the contents. The upper
    // bound is an array because arrays sort after every string, so no path falls outside it.
    const tx = this.getDB().transaction(['files'], 'readonly');
    const index = tx.objectStore('files').index('path');
    const range = IDBKeyRange.bound([projectId, ''], [projectId, []]);
    return new Promise((resolve, reject) => {
      const paths: string[] = [];
      const request = index.openKeyCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(paths); return; }
        paths.push((cursor.key as [string, string])[1]);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteProjectFiles(projectId: string): Promise<void> {
    const files = await this.listFiles(projectId);
    const tx = this.getDB().transaction(['files'], 'readwrite');
    const store = tx.objectStore('files');

    for (const file of files) {
      await this.promisify(store.delete(file.id));
    }
  }

  // ============================================
  // File Tree
  // ============================================

  async createTreeNode(node: FileTreeNode): Promise<void> {
    const tx = this.getDB().transaction(['fileTree'], 'readwrite');
    const store = tx.objectStore('fileTree');
    await this.promisify(store.add(node));
  }

  async getTreeNode(projectId: string, path: string): Promise<FileTreeNode | null> {
    const tx = this.getDB().transaction(['fileTree'], 'readonly');
    const store = tx.objectStore('fileTree');
    const index = store.index('path');
    const result = await this.promisify(index.get([projectId, path]));
    return result || null;
  }

  async updateTreeNode(node: FileTreeNode): Promise<void> {
    const tx = this.getDB().transaction(['fileTree'], 'readwrite');
    const store = tx.objectStore('fileTree');
    await this.promisify(store.put(node));
  }

  async deleteTreeNode(projectId: string, path: string): Promise<void> {
    const node = await this.getTreeNode(projectId, path);
    if (node) {
      const tx = this.getDB().transaction(['fileTree'], 'readwrite');
      const store = tx.objectStore('fileTree');
      await this.promisify(store.delete(node.id));
    }
  }

  async getChildNodes(projectId: string, parentPath: string | null): Promise<FileTreeNode[]> {
    const tx = this.getDB().transaction(['fileTree'], 'readonly');
    const store = tx.objectStore('fileTree');
    const index = store.index('parentPath');
    const key = parentPath === null ? [projectId] : [projectId, parentPath];
    const result = await this.promisify(index.getAll(key));
    return result || [];
  }

  async getAllTreeNodes(projectId: string): Promise<FileTreeNode[]> {
    const tx = this.getDB().transaction(['fileTree'], 'readonly');
    const store = tx.objectStore('fileTree');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return result || [];
  }

  // ============================================
  // Custom Templates
  // ============================================

  async saveCustomTemplate(template: CustomTemplate): Promise<void> {
    const tx = this.getDB().transaction(['customTemplates'], 'readwrite');
    const store = tx.objectStore('customTemplates');
    await this.promisify(store.put(template));
  }

  async getCustomTemplate(id: string): Promise<CustomTemplate | null> {
    const tx = this.getDB().transaction(['customTemplates'], 'readonly');
    const store = tx.objectStore('customTemplates');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateCustomTemplate(result as CustomTemplate) : null;
  }

  async getAllCustomTemplates(): Promise<CustomTemplate[]> {
    const tx = this.getDB().transaction(['customTemplates'], 'readonly');
    const store = tx.objectStore('customTemplates');
    const results = await this.promisify(store.getAll());
    return results.map(t => this.hydrateCustomTemplate(t as CustomTemplate));
  }

  async deleteCustomTemplate(id: string): Promise<void> {
    const tx = this.getDB().transaction(['customTemplates'], 'readwrite');
    const store = tx.objectStore('customTemplates');
    await this.promisify(store.delete(id));
  }

  // ============================================
  // Custom Skills
  // ============================================

  async createSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void> {
    const tx = this.getDB().transaction(['skills'], 'readwrite');
    const store = tx.objectStore('skills');
    const skillToStore: Skill = { ...skill, isBuiltIn: false };
    await this.promisify(store.add(skillToStore));
  }

  async getSkill(id: string): Promise<Skill | null> {
    const tx = this.getDB().transaction(['skills'], 'readonly');
    const store = tx.objectStore('skills');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateSkill(result as Skill) : null;
  }

  async updateSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void> {
    const tx = this.getDB().transaction(['skills'], 'readwrite');
    const store = tx.objectStore('skills');
    const skillToStore: Skill = { ...skill, isBuiltIn: false };
    await this.promisify(store.put(skillToStore));
  }

  async deleteSkill(id: string): Promise<void> {
    const tx = this.getDB().transaction(['skills'], 'readwrite');
    const store = tx.objectStore('skills');
    await this.promisify(store.delete(id));
  }

  async getAllSkills(): Promise<Skill[]> {
    const tx = this.getDB().transaction(['skills'], 'readonly');
    const store = tx.objectStore('skills');
    const result = await this.promisify(store.getAll());
    // Filter to only custom skills (isBuiltIn: false)
    const customSkills = result.filter((s: Skill) => !s.isBuiltIn);
    return customSkills.map(s => this.hydrateSkill(s as Skill));
  }

  // ============================================
  // Edge Functions (Project-scoped)
  // ============================================

  async createEdgeFunction(fn: EdgeFunction): Promise<void> {
    const tx = this.getDB().transaction(['edgeFunctions'], 'readwrite');
    const store = tx.objectStore('edgeFunctions');
    await this.promisify(store.add(fn));
  }

  async getEdgeFunction(id: string): Promise<EdgeFunction | null> {
    const tx = this.getDB().transaction(['edgeFunctions'], 'readonly');
    const store = tx.objectStore('edgeFunctions');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateEdgeFunction(result as EdgeFunction) : null;
  }

  async listEdgeFunctions(projectId: string): Promise<EdgeFunction[]> {
    const tx = this.getDB().transaction(['edgeFunctions'], 'readonly');
    const store = tx.objectStore('edgeFunctions');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return (result || []).map((fn) => this.hydrateEdgeFunction(fn as EdgeFunction));
  }

  async updateEdgeFunction(fn: EdgeFunction): Promise<void> {
    const tx = this.getDB().transaction(['edgeFunctions'], 'readwrite');
    const store = tx.objectStore('edgeFunctions');
    await this.promisify(store.put(fn));
  }

  async deleteEdgeFunction(id: string): Promise<void> {
    const tx = this.getDB().transaction(['edgeFunctions'], 'readwrite');
    const store = tx.objectStore('edgeFunctions');
    await this.promisify(store.delete(id));
  }

  // ============================================
  // Server Functions (Project-scoped)
  // ============================================

  async createServerFunction(fn: ServerFunction): Promise<void> {
    const tx = this.getDB().transaction(['serverFunctions'], 'readwrite');
    const store = tx.objectStore('serverFunctions');
    await this.promisify(store.add(fn));
  }

  async getServerFunction(id: string): Promise<ServerFunction | null> {
    const tx = this.getDB().transaction(['serverFunctions'], 'readonly');
    const store = tx.objectStore('serverFunctions');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateServerFunction(result as ServerFunction) : null;
  }

  async listServerFunctions(projectId: string): Promise<ServerFunction[]> {
    const tx = this.getDB().transaction(['serverFunctions'], 'readonly');
    const store = tx.objectStore('serverFunctions');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return (result || []).map((fn) => this.hydrateServerFunction(fn as ServerFunction));
  }

  async updateServerFunction(fn: ServerFunction): Promise<void> {
    const tx = this.getDB().transaction(['serverFunctions'], 'readwrite');
    const store = tx.objectStore('serverFunctions');
    await this.promisify(store.put(fn));
  }

  async deleteServerFunction(id: string): Promise<void> {
    const tx = this.getDB().transaction(['serverFunctions'], 'readwrite');
    const store = tx.objectStore('serverFunctions');
    await this.promisify(store.delete(id));
  }

  // ============================================
  // Secrets (Project-scoped)
  // ============================================

  async createSecret(secret: Secret): Promise<void> {
    const tx = this.getDB().transaction(['secrets'], 'readwrite');
    const store = tx.objectStore('secrets');
    await this.promisify(store.add(secret));
  }

  async getSecret(id: string): Promise<Secret | null> {
    const tx = this.getDB().transaction(['secrets'], 'readonly');
    const store = tx.objectStore('secrets');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateSecret(result as Secret) : null;
  }

  async listSecrets(projectId: string): Promise<Secret[]> {
    const tx = this.getDB().transaction(['secrets'], 'readonly');
    const store = tx.objectStore('secrets');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return (result || []).map((s) => this.hydrateSecret(s as Secret));
  }

  async updateSecret(secret: Secret): Promise<void> {
    const tx = this.getDB().transaction(['secrets'], 'readwrite');
    const store = tx.objectStore('secrets');
    await this.promisify(store.put(secret));
  }

  async deleteSecret(id: string): Promise<void> {
    const tx = this.getDB().transaction(['secrets'], 'readwrite');
    const store = tx.objectStore('secrets');
    await this.promisify(store.delete(id));
  }

  // ============================================
  // Scheduled Functions (Project-scoped)
  // ============================================

  async createScheduledFunction(fn: ScheduledFunction): Promise<void> {
    const tx = this.getDB().transaction(['scheduledFunctions'], 'readwrite');
    const store = tx.objectStore('scheduledFunctions');
    await this.promisify(store.add(fn));
  }

  async getScheduledFunction(id: string): Promise<ScheduledFunction | null> {
    const tx = this.getDB().transaction(['scheduledFunctions'], 'readonly');
    const store = tx.objectStore('scheduledFunctions');
    const result = await this.promisify(store.get(id));
    return result ? this.hydrateScheduledFunction(result as ScheduledFunction) : null;
  }

  async listScheduledFunctions(projectId: string): Promise<ScheduledFunction[]> {
    const tx = this.getDB().transaction(['scheduledFunctions'], 'readonly');
    const store = tx.objectStore('scheduledFunctions');
    const index = store.index('projectId');
    const result = await this.promisify(index.getAll(projectId));
    return (result || []).map((fn) => this.hydrateScheduledFunction(fn as ScheduledFunction));
  }

  async updateScheduledFunction(fn: ScheduledFunction): Promise<void> {
    const tx = this.getDB().transaction(['scheduledFunctions'], 'readwrite');
    const store = tx.objectStore('scheduledFunctions');
    await this.promisify(store.put(fn));
  }

  async deleteScheduledFunction(id: string): Promise<void> {
    const tx = this.getDB().transaction(['scheduledFunctions'], 'readwrite');
    const store = tx.objectStore('scheduledFunctions');
    await this.promisify(store.delete(id));
  }

  // ============================================
  // Helper Methods
  // ============================================

  private promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private hydrateProject(project: Project): Project {
    // The sync timestamps are hydrated too: a project written back straight from a JSON API
    // response stores them as ISO strings, and comparing a Date against a string silently reports
    // 'synced'. Absent values stay null — a fabricated lastSyncedAt would misread as "already
    // synced" on a project that never was.
    return {
      ...project,
      createdAt: project.createdAt ? new Date(project.createdAt) : new Date(),
      updatedAt: project.updatedAt ? new Date(project.updatedAt) : new Date(),
      lastSavedAt: project.lastSavedAt ? new Date(project.lastSavedAt) : null,
      previewUpdatedAt: project.previewUpdatedAt ? new Date(project.previewUpdatedAt) : undefined,
      lastSyncedAt: project.lastSyncedAt ? new Date(project.lastSyncedAt) : null,
      serverUpdatedAt: project.serverUpdatedAt ? new Date(project.serverUpdatedAt) : null,
      revision: typeof project.revision === 'number' ? project.revision : undefined,
      // Same reason as the dates above, and the same write-back: a project stored from an API
      // response holds whatever that response held, and for settings that has meant a JSON string.
      // See lib/vfs/project-settings.ts.
      settings: normalizeProjectSettings(project.settings)
    };
  }

  private hydrateCustomTemplate(template: CustomTemplate): CustomTemplate {
    return {
      ...template,
      importedAt: template.importedAt ? new Date(template.importedAt) : new Date()
    };
  }

  private hydrateSkill(skill: Skill): Skill {
    return {
      ...skill,
      createdAt: skill.createdAt ? new Date(skill.createdAt) : new Date(),
      updatedAt: skill.updatedAt ? new Date(skill.updatedAt) : new Date()
    };
  }

  private hydrateEdgeFunction(fn: EdgeFunction): EdgeFunction {
    return {
      ...fn,
      createdAt: fn.createdAt ? new Date(fn.createdAt) : new Date(),
      updatedAt: fn.updatedAt ? new Date(fn.updatedAt) : new Date(),
    };
  }

  private hydrateServerFunction(fn: ServerFunction): ServerFunction {
    return {
      ...fn,
      createdAt: fn.createdAt ? new Date(fn.createdAt) : new Date(),
      updatedAt: fn.updatedAt ? new Date(fn.updatedAt) : new Date(),
    };
  }

  private hydrateSecret(secret: Secret): Secret {
    return {
      ...secret,
      createdAt: secret.createdAt ? new Date(secret.createdAt) : new Date(),
      updatedAt: secret.updatedAt ? new Date(secret.updatedAt) : new Date(),
    };
  }

  private hydrateScheduledFunction(fn: ScheduledFunction): ScheduledFunction {
    return {
      ...fn,
      createdAt: fn.createdAt ? new Date(fn.createdAt) : new Date(),
      updatedAt: fn.updatedAt ? new Date(fn.updatedAt) : new Date(),
      lastRunAt: fn.lastRunAt ? new Date(fn.lastRunAt) : undefined,
      nextRunAt: fn.nextRunAt ? new Date(fn.nextRunAt) : undefined,
    };
  }
}
