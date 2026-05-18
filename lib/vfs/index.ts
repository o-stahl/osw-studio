import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { logger } from '@/lib/utils';
import {
  Project,
  VirtualFile,
  FileTreeNode,
  getFileTypeFromPath,
  getSpecificMimeType,
  FILE_SIZE_LIMITS,
} from './types';
import { saveManager } from './save-manager';
import { skillsService } from './skills';
import { StorageAdapter } from './adapters/types';
import { createClientAdapter } from './adapters/factory';
import { IndexedDBAdapter } from './adapters/indexeddb-adapter';
import { getRuntimeConfig } from '@/lib/runtimes/registry';

export class VirtualFileSystem {
  private adapter: StorageAdapter;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private transientFiles: Map<string, VirtualFile> = new Map();
  private generatedFiles: Map<string, VirtualFile> = new Map();
  private syncTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Debounce sync calls

  constructor(adapter?: StorageAdapter) {
    this.adapter = adapter ?? createClientAdapter();
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      if (!this.initPromise) {
        this.initPromise = (async () => {
          await this.adapter.init();
          await this.mountTransientSkills();
          this.initialized = true;
        })();
      }
      await this.initPromise;
    } else {
      // Already initialized — re-check adapter connection (handles HMR / connection loss)
      await this.adapter.init();
    }
  }

  /**
   * Get the underlying storage adapter for direct template/skill operations
   */
  getStorageAdapter(): StorageAdapter {
    if (!this.initialized) {
      throw new Error('VirtualFileSystem not initialized. Call init() first.');
    }
    return this.adapter;
  }

  /**
   * Get direct database access for checkpoint and conversation managers
   * Only works with IndexedDBAdapter
   */
  getDatabase(): IDBDatabase {
    if (!(this.adapter instanceof IndexedDBAdapter)) {
      throw new Error('Direct database access only available with IndexedDBAdapter');
    }
    return this.adapter.getDatabase();
  }

  /**
   * Mount skills as transient files at /.skills/
   */
  private async mountTransientSkills(): Promise<void> {
    try {
      const skills = await skillsService.getEnabledSkills();

      for (const skill of skills) {
        const path = `/.skills/${skill.id}.md`;
        const transientFile: VirtualFile = {
          id: `transient-skill-${skill.id}`,
          projectId: 'transient', // Not associated with any project
          path,
          name: `${skill.id}.md`,
          type: 'text',
          content: skill.content,
          mimeType: 'text/markdown',
          size: new Blob([skill.content]).size,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
          metadata: {
            isTransient: true,
            isBuiltIn: skill.isBuiltIn
          }
        };

        this.transientFiles.set(path, transientFile);
      }

      logger.info(`[VFS] Mounted ${this.transientFiles.size} transient skill files`);
    } catch (error) {
      logger.error('[VFS] Failed to mount transient skills', error);
    }
  }

  /**
   * Check if a path is transient (managed in-memory, not persisted to adapter).
   * Only known transient namespaces: /.server/ (backend context) and /.skills/ (skills)
   */
  private isTransientPath(path: string): boolean {
    return path.startsWith('/.server/') || path.startsWith('/.skills/');
  }

  // --- Generated files (bundle.js, bundle.css) ---

  setGeneratedFile(path: string, content: string, mimeType: string): void {
    const now = new Date();
    this.generatedFiles.set(path, {
      id: `generated-${path}`,
      projectId: 'generated',
      path,
      name: path.split('/').pop() || path,
      type: path.endsWith('.css') ? 'css' : 'js',
      content,
      mimeType,
      size: content.length,
      createdAt: now,
      updatedAt: now,
      metadata: { isGenerated: true },
    });
  }

  clearGeneratedFiles(): void {
    this.generatedFiles.clear();
  }

  getGeneratedFiles(): VirtualFile[] {
    return Array.from(this.generatedFiles.values());
  }

  isGeneratedPath(path: string): boolean {
    return this.generatedFiles.has(path);
  }

  /**
   * Reload transient skills (call after adding/updating/deleting skills)
   */
  async reloadTransientSkills(): Promise<void> {
    // Preserve server context files when reloading skills
    const serverContextFiles = new Map<string, VirtualFile>();
    for (const [path, file] of this.transientFiles) {
      if (path.startsWith('/.server/')) {
        serverContextFiles.set(path, file);
      }
    }

    this.transientFiles.clear();
    await this.mountTransientSkills();

    // Restore server context files
    for (const [path, file] of serverContextFiles) {
      this.transientFiles.set(path, file);
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('filesChanged'));
    }
  }

  // Track current server context (project-scoped features + optional deployment runtime)
  private serverContextProjectId: string | null = null;
  private runtimeDeploymentId: string | null = null;
  private serverContextMetadata: {
    projectId: string;
    runtimeDeploymentId?: string;
    hasDatabase: boolean;
    edgeFunctionCount: number;
    serverFunctionCount: number;
    secretCount: number;
    scheduledFunctionCount: number;
  } | null = null;

  /**
   * Get current server context project ID
   */
  getServerContextProjectId(): string | null {
    return this.serverContextProjectId;
  }

  /**
   * Get runtime deployment ID (for sqlite3, logs)
   */
  getRuntimeDeploymentId(): string | null {
    return this.runtimeDeploymentId;
  }

  /**
   * Check if server context is mounted
   */
  hasServerContext(): boolean {
    return this.serverContextProjectId !== null;
  }

  /**
   * Get server context metadata
   */
  getServerContextMetadata(): {
    projectId: string;
    runtimeDeploymentId?: string;
    hasDatabase: boolean;
    edgeFunctionCount: number;
    serverFunctionCount: number;
    secretCount: number;
    scheduledFunctionCount: number;
  } | null {
    return this.serverContextMetadata;
  }

  /**
   * Mount project backend context
   * Reads backend features from the project's IndexedDB/SQLite stores and creates transient files.
   * This is auto-mounted when a project opens in the workspace.
   */
  async mountProjectBackendContext(projectId: string): Promise<void> {
    // Only works in Server Mode — Backend features exist in IndexedDB in both modes,
    // but the /.server/ context is only mounted in Server Mode where deployments can use them
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
      return;
    }

    try {
      // Clear existing server context
      this.unmountBackendContext();

      const {
        generateEdgeFunctionFile,
        generateServerFunctionFile,
        generateSecretFile,
        generateScheduledFunctionFile,
      } = await import('./server-context');

      // Read backend features from the adapter (IndexedDB on client, SQLite on server)
      const adapter = this.adapter;
      const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
      const serverFunctions = adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
      const secrets = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];
      const scheduledFunctions = adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(projectId) : [];

      // Mount edge functions
      for (const fn of edgeFunctions) {
        this.mountTransientFile(`/.server/edge-functions/${fn.name}.json`, generateEdgeFunctionFile(fn), false);
      }

      // Mount server functions
      for (const fn of serverFunctions) {
        this.mountTransientFile(`/.server/server-functions/${fn.name}.json`, generateServerFunctionFile(fn), false);
      }

      // Mount secrets
      for (const secret of secrets) {
        this.mountTransientFile(`/.server/secrets/${secret.name}.json`, generateSecretFile(secret), false);
      }

      // Mount scheduled functions
      for (const fn of scheduledFunctions) {
        const edgeFn = edgeFunctions.find(ef => ef.id === fn.functionId);
        this.mountTransientFile(
          `/.server/scheduled-functions/${fn.name}.json`,
          generateScheduledFunctionFile(fn, edgeFn?.name ?? 'unknown'),
          false
        );
      }

      // Mount database schema if present in localStorage
      if (typeof window !== 'undefined') {
        const dbSchema = localStorage.getItem(`osw-db-schema-${projectId}`);
        if (dbSchema) {
          this.mountTransientFile('/.server/db/schema.sql', dbSchema, true);
        }
      }

      // Ensure all known server context directories are visible (even if empty)
      const knownDirs = ['edge-functions', 'server-functions', 'secrets', 'scheduled-functions', 'db'];
      for (const dir of knownDirs) {
        const dirPrefix = `/.server/${dir}/`;
        const hasFiles = Array.from(this.transientFiles.keys()).some(p => p.startsWith(dirPrefix));
        if (!hasFiles) {
          this.mountTransientFile(`/.server/${dir}/.gitkeep`, '', true);
        }
      }

      // Store metadata
      this.serverContextProjectId = projectId;
      this.serverContextMetadata = {
        projectId,
        runtimeDeploymentId: this.runtimeDeploymentId || undefined,
        hasDatabase: !!this.runtimeDeploymentId,
        edgeFunctionCount: edgeFunctions.filter(f => f.enabled).length,
        serverFunctionCount: serverFunctions.filter(f => f.enabled).length,
        secretCount: secrets.length,
        scheduledFunctionCount: scheduledFunctions.filter(f => f.enabled).length,
      };

      // Persist projectId to sessionStorage for HMR resilience
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('vfs_serverContextProjectId', projectId);
      }

      logger.info(`[VFS] Mounted project server context for project ${projectId}`);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
    } catch (error) {
      logger.error('[VFS] Failed to mount project server context', error);
    }
  }

  /**
   * Mount deployment runtime context (optional, for sqlite3 and logs)
   * Only available when a deployment exists AND is published.
   */
  async mountDeploymentRuntimeContext(deploymentId: string): Promise<void> {
    if (process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
      return;
    }

    try {
      // On server side, get database schema
      if (typeof window === 'undefined') {
        const { getSQLiteAdapter } = await import(/* webpackIgnore: true */ './adapters/server');
        const sqliteAdapter = getSQLiteAdapter();
        await sqliteAdapter.init();
        const deploymentDb = sqliteAdapter.getDeploymentDatabaseForAnalytics(deploymentId);
        if (deploymentDb) {
          const schema = deploymentDb.getSchemaForExport();
          this.mountTransientFile('/.server/db/schema.sql', schema, true);
        }
      } else {
        // Client side: fetch schema from API
        try {
          // Use workspace-scoped URL if in server mode with a workspace cookie
          const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
          const wsCookie = isServerMode && typeof document !== 'undefined' && document.cookie.match(/osw_workspace=([^;]+)/);
          const ctxUrl = wsCookie
            ? `/api/w/${wsCookie[1]}/admin/deployments/${deploymentId}/server-context`
            : `/api/admin/deployments/${deploymentId}/server-context`;
          const response = await fetch(ctxUrl);
          if (response.ok) {
            const data = await response.json();
            const schemaFile = data.files?.find((f: { path: string }) => f.path === '/.server/db/schema.sql');
            if (schemaFile) {
              this.mountTransientFile('/.server/db/schema.sql', schemaFile.content, true);
            }
          }
        } catch {
          logger.warn('[VFS] Could not fetch deployment schema');
        }
      }

      this.runtimeDeploymentId = deploymentId;

      // Update metadata to include runtime info
      if (this.serverContextMetadata) {
        this.serverContextMetadata.runtimeDeploymentId = deploymentId;
        this.serverContextMetadata.hasDatabase = true;
      }

      // Persist to sessionStorage for HMR resilience
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('vfs_runtimeDeploymentId', deploymentId);
      }

      logger.info(`[VFS] Connected deployment runtime: ${deploymentId}`);

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
    } catch (error) {
      logger.error('[VFS] Failed to mount deployment runtime context', error);
    }
  }

  /**
   * Disconnect deployment runtime context
   */
  unmountDeploymentRuntimeContext(): void {
    if (this.runtimeDeploymentId) {
      // Remove schema file
      this.transientFiles.delete('/.server/db/schema.sql');

      this.runtimeDeploymentId = null;

      if (this.serverContextMetadata) {
        this.serverContextMetadata.runtimeDeploymentId = undefined;
        this.serverContextMetadata.hasDatabase = false;
      }

      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('vfs_runtimeDeploymentId');
      }

      logger.info('[VFS] Disconnected deployment runtime');

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
    }
  }

  /**
   * Refresh server context (re-reads from adapter stores)
   * Call after orchestrator completes to ensure file explorer is up to date
   */
  async refreshServerContext(): Promise<void> {
    if (!this.serverContextProjectId) return;
    await this.mountProjectBackendContext(this.serverContextProjectId);

    // Re-mount runtime if connected
    if (this.runtimeDeploymentId) {
      await this.mountDeploymentRuntimeContext(this.runtimeDeploymentId);
    }
  }

  /**
   * Unmount all backend context (project features + runtime)
   */
  unmountBackendContext(): void {
    const removed: string[] = [];

    for (const path of this.transientFiles.keys()) {
      if (path.startsWith('/.server/')) {
        this.transientFiles.delete(path);
        removed.push(path);
      }
    }

    if (this.serverContextProjectId || this.runtimeDeploymentId) {
      logger.info(`[VFS] Unmounted server context (${removed.length} files)`);
      this.serverContextProjectId = null;
      this.runtimeDeploymentId = null;
      this.serverContextMetadata = null;

      // Clear sessionStorage when unmounting
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('vfs_serverContextProjectId');
        sessionStorage.removeItem('vfs_runtimeDeploymentId');
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
    }
  }

  /**
   * Get all transient files in a directory
   */
  getTransientFilesInDirectory(dirPath: string): VirtualFile[] {
    const normalizedPath = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    const files: VirtualFile[] = [];

    for (const [path, file] of this.transientFiles) {
      if (path.startsWith(normalizedPath)) {
        files.push(file);
      }
    }

    return files;
  }

  /**
   * Mount a single transient file
   * @param isReadOnly - If false, the file can be edited via shell commands (edge functions, server functions)
   */
  private mountTransientFile(path: string, content: string, isReadOnly = true): void {
    const file: VirtualFile = {
      id: `transient-server-${path.replace(/[^a-z0-9]/gi, '-')}`,
      projectId: 'transient',
      path,
      name: path.split('/').pop() || '',
      type: 'text',
      content,
      mimeType: path.endsWith('.sql') ? 'text/sql' :
                path.endsWith('.json') ? 'application/json' :
                path.endsWith('.js') ? 'application/javascript' :
                'text/markdown',
      size: new Blob([content]).size,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        isTransient: true,
        isServerContext: true,
        isReadOnly,
      }
    };

    this.transientFiles.set(path, file);
  }

  /**
   * Update a server context file (/.server/)
   * Validates content and syncs to project IndexedDB/SQLite stores
   */
  private async updateServerContextFile(path: string, content: string): Promise<VirtualFile> {
    // Recover projectId from sessionStorage if needed (HMR resilience)
    if (!this.serverContextProjectId && typeof sessionStorage !== 'undefined') {
      const storedProjectId = sessionStorage.getItem('vfs_serverContextProjectId');
      if (storedProjectId) {
        logger.info(`[VFS] Recovered serverContextProjectId from sessionStorage: ${storedProjectId}`);
        this.serverContextProjectId = storedProjectId;
      }
    }

    if (!this.serverContextProjectId) {
      throw new Error('No project server context mounted.');
    }

    // Check for read-only files
    if (path === '/.server/db/schema.sql') {
      throw new Error(`Cannot modify ${path} - read-only file`);
    }

    // Route to appropriate handler
    if (path.startsWith('/.server/edge-functions/') && path.endsWith('.json')) {
      return await this.upsertEdgeFunctionFromFile(path, content);
    }
    if (path.startsWith('/.server/server-functions/') && path.endsWith('.json')) {
      return await this.upsertServerFunctionFromFile(path, content);
    }
    if (path.startsWith('/.server/secrets/') && path.endsWith('.json')) {
      return await this.upsertSecretFromFile(path, content);
    }
    if (path.startsWith('/.server/scheduled-functions/') && path.endsWith('.json')) {
      return await this.upsertScheduledFunctionFromFile(path, content);
    }

    throw new Error(`Cannot modify ${path} - unrecognized server context path`);
  }

  /**
   * Upsert edge function from file content into project stores
   */
  private async upsertEdgeFunctionFromFile(path: string, content: string): Promise<VirtualFile> {
    const { validateEdgeFunctionData, generateEdgeFunctionFile } = await import('./server-context');
    const { v4: uuidv4Gen } = await import('uuid');

    let data: unknown;
    try { data = JSON.parse(content); } catch (e: unknown) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const validation = validateEdgeFunctionData(data);
    if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

    const fnData = data as { name: string; method: string; code: string; description?: string; enabled?: boolean; timeoutMs?: number };
    const projectId = this.serverContextProjectId!;
    const adapter = this.adapter;

    // Find existing by filename
    const filename = path.split('/').pop()!.replace('.json', '');
    const existing = adapter.listEdgeFunctions
      ? (await adapter.listEdgeFunctions(projectId)).find(f => f.name === filename)
      : undefined;

    const now = new Date();
    if (existing && adapter.updateEdgeFunction) {
      const updated = { ...existing, name: fnData.name, code: fnData.code, method: fnData.method as any, description: fnData.description, enabled: fnData.enabled ?? true, timeoutMs: fnData.timeoutMs ?? 5000, updatedAt: now };
      await adapter.updateEdgeFunction(updated);

      if (fnData.name !== filename) {
        this.transientFiles.delete(path);
        const newPath = `/.server/edge-functions/${fnData.name}.json`;
        this.mountTransientFile(newPath, generateEdgeFunctionFile(updated), false);
        this.removeGitkeep('/.server/edge-functions/');
        this.notifyFilesChanged();
        return this.transientFiles.get(newPath)!;
      }

      this.mountTransientFile(path, generateEdgeFunctionFile(updated), false);
    } else if (adapter.createEdgeFunction) {
      const newFn = { id: uuidv4Gen(), projectId, name: fnData.name, code: fnData.code, method: fnData.method as any, description: fnData.description, enabled: fnData.enabled ?? true, timeoutMs: fnData.timeoutMs ?? 5000, createdAt: now, updatedAt: now };
      await adapter.createEdgeFunction(newFn);
      this.mountTransientFile(path, generateEdgeFunctionFile(newFn), false);
    }

    this.removeGitkeep('/.server/edge-functions/');
    this.notifyFilesChanged();
    this.triggerServerFeatureSync(projectId);
    const result = this.transientFiles.get(path);
    if (!result) throw new Error(`Failed to create server context file at ${path}`);
    return result;
  }

  /**
   * Upsert server function from file content into project stores
   */
  private async upsertServerFunctionFromFile(path: string, content: string): Promise<VirtualFile> {
    const { validateServerFunctionData, generateServerFunctionFile } = await import('./server-context');
    const { v4: uuidv4Gen } = await import('uuid');

    let data: unknown;
    try { data = JSON.parse(content); } catch (e: unknown) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const validation = validateServerFunctionData(data);
    if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

    const fnData = data as { name: string; code: string; description?: string; enabled?: boolean };
    const projectId = this.serverContextProjectId!;
    const adapter = this.adapter;

    const filename = path.split('/').pop()!.replace('.json', '');
    const existing = adapter.listServerFunctions
      ? (await adapter.listServerFunctions(projectId)).find(f => f.name === filename)
      : undefined;

    const now = new Date();
    if (existing && adapter.updateServerFunction) {
      const updated = { ...existing, name: fnData.name, code: fnData.code, description: fnData.description, enabled: fnData.enabled ?? true, updatedAt: now };
      await adapter.updateServerFunction(updated);

      if (fnData.name !== filename) {
        this.transientFiles.delete(path);
        const newPath = `/.server/server-functions/${fnData.name}.json`;
        this.mountTransientFile(newPath, generateServerFunctionFile(updated), false);
        this.removeGitkeep('/.server/server-functions/');
        this.notifyFilesChanged();
        return this.transientFiles.get(newPath)!;
      }

      this.mountTransientFile(path, generateServerFunctionFile(updated), false);
    } else if (adapter.createServerFunction) {
      const newFn = { id: uuidv4Gen(), projectId, name: fnData.name, code: fnData.code, description: fnData.description, enabled: fnData.enabled ?? true, createdAt: now, updatedAt: now };
      await adapter.createServerFunction(newFn);
      this.mountTransientFile(path, generateServerFunctionFile(newFn), false);
    }

    this.removeGitkeep('/.server/server-functions/');
    this.notifyFilesChanged();
    this.triggerServerFeatureSync(projectId);
    const result = this.transientFiles.get(path);
    if (!result) throw new Error(`Failed to create server context file at ${path}`);
    return result;
  }

  /**
   * Upsert secret from file content into project stores
   */
  private async upsertSecretFromFile(path: string, content: string): Promise<VirtualFile> {
    const { validateSecretData, generateSecretFile } = await import('./server-context');
    const { v4: uuidv4Gen } = await import('uuid');

    let data: unknown;
    try { data = JSON.parse(content); } catch (e: unknown) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const validation = validateSecretData(data);
    if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

    const secretData = data as { name: string; description?: string };
    const projectId = this.serverContextProjectId!;
    const adapter = this.adapter;

    const filename = path.split('/').pop()!.replace('.json', '');
    const existing = adapter.listSecrets
      ? (await adapter.listSecrets(projectId)).find(s => s.name === filename)
      : undefined;

    const now = new Date();
    if (existing && adapter.updateSecret) {
      const updated = { ...existing, name: secretData.name, description: secretData.description, updatedAt: now };
      await adapter.updateSecret(updated);

      if (secretData.name !== filename) {
        this.transientFiles.delete(path);
        const newPath = `/.server/secrets/${secretData.name}.json`;
        this.mountTransientFile(newPath, generateSecretFile(updated), false);
        this.removeGitkeep('/.server/secrets/');
        this.notifyFilesChanged();
        return this.transientFiles.get(newPath)!;
      }

      this.mountTransientFile(path, generateSecretFile(updated), false);
    } else if (adapter.createSecret) {
      const newSecret = { id: uuidv4Gen(), projectId, name: secretData.name, description: secretData.description, hasValue: false, createdAt: now, updatedAt: now };
      await adapter.createSecret(newSecret);
      this.mountTransientFile(path, generateSecretFile(newSecret), false);
    }

    this.removeGitkeep('/.server/secrets/');
    this.notifyFilesChanged();
    this.triggerServerFeatureSync(projectId);
    const result = this.transientFiles.get(path);
    if (!result) throw new Error(`Failed to create server context file at ${path}`);
    return result;
  }

  /**
   * Upsert scheduled function from file content into project stores
   */
  private async upsertScheduledFunctionFromFile(path: string, content: string): Promise<VirtualFile> {
    const { validateScheduledFunctionData, generateScheduledFunctionFile } = await import('./server-context');
    const { v4: uuidv4Gen } = await import('uuid');

    let data: unknown;
    try { data = JSON.parse(content); } catch (e: unknown) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }

    const validation = validateScheduledFunctionData(data);
    if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join('; ')}`);

    const fnData = data as { name: string; functionName: string; cronExpression: string; timezone?: string; enabled?: boolean; description?: string; config?: Record<string, unknown> };
    const projectId = this.serverContextProjectId!;
    const adapter = this.adapter;

    // Resolve functionName to functionId
    const edgeFunctions = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
    const edgeFn = edgeFunctions.find(f => f.name === fnData.functionName);
    if (!edgeFn) {
      throw new Error(`Edge function "${fnData.functionName}" not found. Create it first.`);
    }

    const filename = path.split('/').pop()!.replace('.json', '');
    const existing = adapter.listScheduledFunctions
      ? (await adapter.listScheduledFunctions(projectId)).find(f => f.name === filename)
      : undefined;

    const now = new Date();
    if (existing && adapter.updateScheduledFunction) {
      const updated = { ...existing, name: fnData.name, functionId: edgeFn.id, cronExpression: fnData.cronExpression, timezone: fnData.timezone || 'UTC', description: fnData.description, enabled: fnData.enabled ?? true, config: fnData.config || {}, updatedAt: now };
      await adapter.updateScheduledFunction(updated);

      if (fnData.name !== filename) {
        this.transientFiles.delete(path);
        const newPath = `/.server/scheduled-functions/${fnData.name}.json`;
        this.mountTransientFile(newPath, generateScheduledFunctionFile(updated, fnData.functionName), false);
        this.removeGitkeep('/.server/scheduled-functions/');
        this.notifyFilesChanged();
        return this.transientFiles.get(newPath)!;
      }

      this.mountTransientFile(path, generateScheduledFunctionFile(updated, fnData.functionName), false);
    } else if (adapter.createScheduledFunction) {
      const newFn = { id: uuidv4Gen(), projectId, name: fnData.name, functionId: edgeFn.id, cronExpression: fnData.cronExpression, timezone: fnData.timezone || 'UTC', description: fnData.description, enabled: fnData.enabled ?? true, config: fnData.config || {}, createdAt: now, updatedAt: now };
      await adapter.createScheduledFunction(newFn);
      this.mountTransientFile(path, generateScheduledFunctionFile(newFn, fnData.functionName), false);
    }

    this.removeGitkeep('/.server/scheduled-functions/');
    this.notifyFilesChanged();
    this.triggerServerFeatureSync(projectId);
    const result = this.transientFiles.get(path);
    if (!result) throw new Error(`Failed to create server context file at ${path}`);
    return result;
  }

  /**
   * Remove .gitkeep stub from a directory if real files exist
   */
  private removeGitkeep(dirPath: string): void {
    const gitkeepPath = dirPath + '.gitkeep';
    if (this.transientFiles.has(gitkeepPath)) {
      this.transientFiles.delete(gitkeepPath);
    }
  }

  /**
   * Notify file explorer of changes
   */
  private notifyFilesChanged(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('filesChanged'));
    }
  }

  /**
   * Trigger debounced backend feature sync (for server mode)
   * After writing to IndexedDB, schedule a sync to the server
   *
   * WARNING: This is currently a no-op placeholder called from 5 production paths
   * (edge functions, server functions, secrets, scheduled functions, and delete).
   * In Server Mode, users must manually sync (push) backend features before publishing.
   * The publish pipeline reads from core SQLite, not IndexedDB.
   */
  private triggerServerFeatureSync(_projectId: string): void {
    // No-op — automatic sync not yet implemented.
    // Users must manually push backend features via the sync panel before publishing.
  }

  /**
   * Create a new server context file (/.server/)
   * Validates content and creates in project stores
   */
  private async createServerContextFile(path: string, content: string): Promise<VirtualFile> {
    if (!this.serverContextProjectId && typeof sessionStorage !== 'undefined') {
      const storedProjectId = sessionStorage.getItem('vfs_serverContextProjectId');
      if (storedProjectId) {
        this.serverContextProjectId = storedProjectId;
      }
    }

    if (!this.serverContextProjectId) {
      throw new Error('No project server context mounted.');
    }

    if (this.transientFiles.has(path)) {
      throw new Error(`File already exists: ${path}`);
    }

    // Route to appropriate handler (upsert handles create too)
    return await this.updateServerContextFile(path, content);
  }

  /**
   * Delete a server context file (/.server/)
   * Deletes from project stores
   */
  async deleteServerContextFile(path: string): Promise<void> {
    if (!this.serverContextProjectId && typeof sessionStorage !== 'undefined') {
      const storedProjectId = sessionStorage.getItem('vfs_serverContextProjectId');
      if (storedProjectId) {
        this.serverContextProjectId = storedProjectId;
      }
    }

    if (!this.serverContextProjectId) {
      throw new Error('No project server context mounted.');
    }

    if (path === '/.server/db/schema.sql') {
      throw new Error(`Cannot delete ${path} - read-only file`);
    }

    const projectId = this.serverContextProjectId;
    const adapter = this.adapter;
    const filename = path.split('/').pop()!.replace('.json', '');

    if (path.startsWith('/.server/edge-functions/') && path.endsWith('.json')) {
      const items = adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
      const item = items.find(f => f.name === filename);
      if (item && adapter.deleteEdgeFunction) {
        await adapter.deleteEdgeFunction(item.id);
      }
    } else if (path.startsWith('/.server/server-functions/') && path.endsWith('.json')) {
      const items = adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
      const item = items.find(f => f.name === filename);
      if (item && adapter.deleteServerFunction) {
        await adapter.deleteServerFunction(item.id);
      }
    } else if (path.startsWith('/.server/secrets/') && path.endsWith('.json')) {
      const items = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];
      const item = items.find(s => s.name === filename);
      if (item && adapter.deleteSecret) {
        await adapter.deleteSecret(item.id);
      }
    } else if (path.startsWith('/.server/scheduled-functions/') && path.endsWith('.json')) {
      const items = adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(projectId) : [];
      const item = items.find(f => f.name === filename);
      if (item && adapter.deleteScheduledFunction) {
        await adapter.deleteScheduledFunction(item.id);
      }
    } else {
      throw new Error(`Cannot delete ${path} - read-only file`);
    }

    this.transientFiles.delete(path);
    this.notifyFilesChanged();
    this.triggerServerFeatureSync(projectId);
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error('VirtualFileSystem not initialized. Call init() first.');
    }
  }

  /**
   * Trigger auto-sync in background (debounced)
   * Only runs in Server Mode and in browser environment
   */
  private triggerAutoSync(projectId: string) {
    // Only sync in browser and Server Mode
    if (typeof window === 'undefined' || process.env.NEXT_PUBLIC_SERVER_MODE !== 'true') {
      return;
    }

    // Clear existing timeout for this project (debounce)
    const existingTimeout = this.syncTimeouts.get(projectId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Schedule sync after 2 seconds of inactivity
    const timeout = setTimeout(async () => {
      try {
        const { autoSyncProject } = await import('./auto-sync');
        await autoSyncProject(projectId);
      } catch (error) {
        logger.error(`[VFS] Auto-sync failed for project ${projectId}:`, error);
      } finally {
        this.syncTimeouts.delete(projectId);
      }
    }, 2000);

    this.syncTimeouts.set(projectId, timeout);
  }

  /**
   * Flush any pending sync for a project immediately (don't wait for debounce).
   * Called when leaving a project to ensure sync completes.
   */
  async flushSyncTimeout(projectId: string): Promise<void> {
    const timeout = this.syncTimeouts.get(projectId);
    if (timeout) {
      clearTimeout(timeout);
      this.syncTimeouts.delete(projectId);
      try {
        const { autoSyncProject } = await import('./auto-sync');
        await autoSyncProject(projectId);
      } catch (error) {
        logger.error(`[VFS] Flush sync failed for project ${projectId}:`, error);
      }
    }
  }

  /**
   * Flush all pending sync timeouts immediately.
   * Called on beforeunload — best-effort only, as the browser may kill async
   * operations before they complete. Primary sync guarantee is flushSyncTimeout()
   * on workspace exit, which runs before navigation.
   */
  flushAllSyncTimeouts(): void {
    if (this.syncTimeouts.size === 0) return;
    for (const [projectId, timeout] of this.syncTimeouts) {
      clearTimeout(timeout);
      import('./auto-sync').then(({ autoSyncProject }) => {
        autoSyncProject(projectId);
      }).catch(() => {});
    }
    this.syncTimeouts.clear();
  }

  async createFile(projectId: string, path: string, content: string | ArrayBuffer, options?: { silent?: boolean }): Promise<VirtualFile> {
    this.ensureInitialized();

    try {
      // Clean path of any trailing newlines or escape sequences
      const cleanPath = path.replace(/\\n$|\\r$|\n$|\r$/, '').trim();
      path = cleanPath;

      // Handle server context file creation (/.server/)
      if (path.startsWith('/.server/')) {
        return await this.createServerContextFile(path, content as string);
      }

      const existing = await this.adapter.getFile(projectId, path);
      if (existing) {
        logger.error('VFS: File already exists', { projectId, path });
        throw new Error(`File already exists: ${path}`);
      }

      const type = getFileTypeFromPath(path);

      const size = content instanceof ArrayBuffer ? content.byteLength : new Blob([content]).size;
      const sizeLimit = FILE_SIZE_LIMITS[type];
      if (size > sizeLimit) {
        throw new Error(`File too large. Maximum size for ${type} files is ${Math.round(sizeLimit / 1024 / 1024)}MB`);
      }

      const file: VirtualFile = {
        id: uuidv4(),
        projectId,
        path,
        name: path.split('/').pop() || '',
        type,
        content,
        mimeType: getSpecificMimeType(path),
        size,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          isEntry: path === '/index.html'
        }
      };

      await this.adapter.createFile(file);

      await this.updateFileTree(projectId, path, 'create', options?.silent === true);
      saveManager.markDirty(projectId);

      return file;
    } catch (error) {
      throw error;
    }
  }

  async readFile(projectId: string, path: string): Promise<VirtualFile> {
    this.ensureInitialized();

    // Validate inputs
    if (!projectId || typeof projectId !== 'string') {
      logger.error('VFS: Invalid projectId for readFile', { projectId, path });
      throw new Error('Invalid projectId provided');
    }

    if (!path || typeof path !== 'string') {
      logger.error('VFS: Invalid path for readFile', { projectId, path });
      throw new Error('Invalid file path provided');
    }

    // Clean path of any trailing newlines or escape sequences
    const cleanPath = path.replace(/\\n$|\\r$|\n$|\r$/, '').trim();

    if (!cleanPath) {
      logger.error('VFS: Empty path after cleaning for readFile', { projectId, originalPath: path, cleanPath });
      throw new Error('Empty file path after cleaning');
    }

    // Check transient files first (for /.skills/, /.agents/, etc.)
    if (this.isTransientPath(cleanPath)) {
      const transientFile = this.transientFiles.get(cleanPath);
      if (transientFile) {
        return transientFile;
      }
      throw new Error(`Transient file not found: ${cleanPath}`);
    }

    // Check generated files (bundle.js, bundle.css)
    const generatedFile = this.generatedFiles.get(cleanPath);
    if (generatedFile) {
      return generatedFile;
    }

    const file = await this.adapter.getFile(projectId, cleanPath);
    if (!file) {
      logger.debug('VFS: File not found for read', { projectId, path: cleanPath, originalPath: path });
      throw new Error(`File not found: ${cleanPath}`);
    }

    return file;
  }

  async fileExists(projectId: string, path: string): Promise<boolean> {
    this.ensureInitialized();

    try {
      // Check transient files first
      if (this.isTransientPath(path)) {
        return this.transientFiles.has(path);
      }

      // Check generated files
      if (this.generatedFiles.has(path)) {
        return true;
      }

      const file = await this.adapter.getFile(projectId, path);
      return !!file;
    } catch {
      return false;
    }
  }

  async updateFile(projectId: string, path: string, content: string | ArrayBuffer, options?: { silent?: boolean }): Promise<VirtualFile> {
    this.ensureInitialized();

    try {
      // Clean and validate path before database operation
      const cleanPath = path.replace(/\\n$|\\r$|\n$|\r$/, '').trim();
      if (cleanPath.includes('\n') || cleanPath.includes('@@') || cleanPath.includes('\\n') || cleanPath.length > 200) {
        logger.error('VFS: Invalid path detected', { projectId, path: path.slice(0, 100) + '...' });
        throw new Error(`Invalid file path: ${path.slice(0, 50)}...`);
      }

      // Use cleaned path for lookup
      path = cleanPath;

      // Handle server context file writes (/.server/)
      if (path.startsWith('/.server/')) {
        return await this.updateServerContextFile(path, content as string);
      }

      const file = await this.adapter.getFile(projectId, path);
      if (!file) {
        logger.error('VFS: File not found for update', { projectId, path });
        throw new Error(`File not found: ${path}`);
      }

      file.content = content;
      file.size = content instanceof ArrayBuffer ? content.byteLength : new Blob([content]).size;
      file.updatedAt = new Date();

      await this.adapter.updateFile(file);
      saveManager.markDirty(projectId);

      if (!options?.silent && typeof window !== 'undefined') {
        const detail = { projectId, path };
        window.dispatchEvent(new CustomEvent('fileContentChanged', { detail }));
        window.dispatchEvent(new Event('filesChanged'));
      }

      return file;
    } catch (error) {
      throw error;
    }
  }

  async deleteFile(projectId: string, path: string, options?: { silent?: boolean }): Promise<void> {
    this.ensureInitialized();

    try {
      await this.adapter.deleteFile(projectId, path);
      await this.updateFileTree(projectId, path, 'delete', options?.silent === true);
      saveManager.markDirty(projectId);
    } catch (error) {
      throw error;
    }
  }

  async renameFile(projectId: string, oldPath: string, newPath: string): Promise<VirtualFile> {
    this.ensureInitialized();
    
    const file = await this.readFile(projectId, oldPath);
    await this.deleteFile(projectId, oldPath);
    return await this.createFile(projectId, newPath, file.content as string);
  }

  async createDirectory(projectId: string, path: string): Promise<void> {
    this.ensureInitialized();
    
    const existing = await this.adapter.getTreeNode(projectId, path);
    if (existing) {
      return;
    }
    
    const name = path.split('/').pop() || path;
    const node: FileTreeNode = {
      id: uuidv4(),
      projectId,
      path,
      name,
      type: 'directory',
      parentPath: this.getParentPath(path),
      children: []
    };

      await this.adapter.createTreeNode(node);
      saveManager.markDirty(projectId);
      
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
  }

  async listDirectory(projectId: string, path: string, options?: { includeTransient?: boolean }): Promise<VirtualFile[]> {
    this.ensureInitialized();

    const allFiles = await this.adapter.listFiles(projectId);

    let files: VirtualFile[];
    if (path === '/') {
      files = allFiles;
    } else {
      files = allFiles.filter(file => {
        const filePath = file.path;
        const dirPath = path.endsWith('/') ? path : path + '/';
        return filePath.startsWith(dirPath) &&
               filePath.slice(dirPath.length).indexOf('/') === -1;
      });
    }

    // Include generated files (bundle.js, bundle.css) — always visible at root
    if (path === '/' && this.generatedFiles.size > 0) {
      const existingPaths = new Set(files.map(f => f.path));
      for (const gf of this.generatedFiles.values()) {
        if (!existingPaths.has(gf.path)) {
          files.push(gf);
        }
      }
    }

    // Include transient files if requested
    if (options?.includeTransient) {
      const transientFilesArray = Array.from(this.transientFiles.values());

      if (path === '/') {
        // Root: include all transient files
        files = [...files, ...transientFilesArray];
      } else {
        // Subdirectory: filter transient files by path
        const dirPath = path.endsWith('/') ? path : path + '/';

        // Direct children (files at this exact level)
        const matchingTransient = transientFilesArray.filter(file => {
          return file.path.startsWith(dirPath) &&
                 file.path.slice(dirPath.length).indexOf('/') === -1;
        });

        // Synthesize directory entries from deeper transient files
        const synthDirs = new Set<string>();
        for (const file of transientFilesArray) {
          if (file.path.startsWith(dirPath)) {
            const rest = file.path.slice(dirPath.length);
            const slashIdx = rest.indexOf('/');
            if (slashIdx !== -1) {
              synthDirs.add(rest.slice(0, slashIdx));
            }
          }
        }

        const now = new Date();
        const synthEntries: VirtualFile[] = Array.from(synthDirs).map(dirName => ({
          id: `transient-dir-${dirPath}${dirName}`,
          projectId: 'transient',
          path: dirPath + dirName,
          name: dirName,
          type: 'text' as const,
          content: '',
          mimeType: '',
          size: 0,
          createdAt: now,
          updatedAt: now,
          metadata: { isTransient: true, isServerContext: true, isReadOnly: true },
        }));

        files = [...files, ...matchingTransient, ...synthEntries];
      }
    }

    return files;
  }

  async getAllFilesAndDirectories(projectId: string, options?: { includeTransient?: boolean }): Promise<Array<VirtualFile | { path: string; name: string; type: 'directory' }>> {
    this.ensureInitialized();

    const allFiles = await this.adapter.listFiles(projectId);

    const treeNodes = await this.adapter.getAllTreeNodes(projectId);

    const directories = treeNodes
      .filter(node => node.type === 'directory')
      .map(node => ({
        path: node.path,
        name: node.path.split('/').filter(Boolean).pop() || node.path,
        type: 'directory' as const
      }));

    let result: Array<VirtualFile | { path: string; name: string; type: 'directory' }> = [...allFiles, ...directories];

    // Include generated files (bundle.js, bundle.css) — always visible
    if (this.generatedFiles.size > 0) {
      const existingPaths = new Set(result.map(item => item.path));
      for (const gf of this.generatedFiles.values()) {
        if (!existingPaths.has(gf.path)) {
          result.push(gf);
        }
      }
    }

    // Include transient files if requested
    if (options?.includeTransient) {
      const transientFilesArray = Array.from(this.transientFiles.values());
      result = [...result, ...transientFilesArray];
    }

    return result;
  }

  async deleteDirectory(projectId: string, path: string): Promise<void> {
    this.ensureInitialized();

    const allFiles = await this.adapter.listFiles(projectId);
    const dirPath = path.endsWith('/') ? path : path + '/';

    // Delete each contained file silently so listeners (preview compile,
    // file-tree reload) don't fire N times — one event is dispatched at the
    // end of this method instead.
    for (const file of allFiles) {
      if (file.path.startsWith(dirPath)) {
        await this.deleteFile(projectId, file.path, { silent: true });
      }
    }

    await this.adapter.deleteTreeNode(projectId, path);
    saveManager.markDirty(projectId);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('filesChanged'));
    }
  }

  async renameDirectory(projectId: string, oldPath: string, newPath: string): Promise<void> {
    this.ensureInitialized();
    
    const oldNode = await this.adapter.getTreeNode(projectId, oldPath);
    if (oldNode) {
      await this.adapter.deleteTreeNode(projectId, oldPath);
      
      const newNode: FileTreeNode = {
        id: uuidv4(),
        projectId,
        path: newPath,
        name: newPath.split('/').pop() || newPath,
        type: 'directory',
        parentPath: this.getParentPath(newPath),
        children: oldNode.children
      };
      await this.adapter.createTreeNode(newNode);
      saveManager.markDirty(projectId);
    }
    
    const oldDirPath = oldPath.endsWith('/') ? oldPath : oldPath + '/';
    const newDirPath = newPath.endsWith('/') ? newPath : newPath + '/';
    
    const allFiles = await this.adapter.listFiles(projectId);
    const filesToMove = allFiles.filter(file => file.path.startsWith(oldDirPath));
    
    for (const file of filesToMove) {
      const relativePath = file.path.substring(oldDirPath.length);
      const newFilePath = newDirPath + relativePath;
      await this.renameFile(projectId, file.path, newFilePath);
    }
    
    const allTreeNodes = await this.adapter.getAllTreeNodes(projectId);
    const subdirNodes = allTreeNodes.filter(node => 
      node.type === 'directory' && 
      node.path.startsWith(oldDirPath) &&
      node.path !== oldPath
    );
    
    for (const node of subdirNodes) {
      const relativePath = node.path.substring(oldDirPath.length);
      const newSubdirPath = newDirPath + relativePath;
      
      await this.adapter.deleteTreeNode(projectId, node.path);
      const newNode: FileTreeNode = {
        id: uuidv4(),
        projectId,
        path: newSubdirPath,
        name: newSubdirPath.split('/').pop() || newSubdirPath,
        type: 'directory',
        parentPath: this.getParentPath(newSubdirPath),
        children: node.children
      };
      await this.adapter.createTreeNode(newNode);
    }
    
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('filesChanged'));
    }
  }

  async moveFile(projectId: string, oldPath: string, newPath: string): Promise<VirtualFile> {
    this.ensureInitialized();
    
    const existing = await this.adapter.getFile(projectId, newPath);
    if (existing) {
      throw new Error(`File already exists at destination: ${newPath}`);
    }
    
    const file = await this.readFile(projectId, oldPath);
    
    const movedFile = await this.createFile(projectId, newPath, file.content);
    
    await this.deleteFile(projectId, oldPath);
    
    return movedFile;
  }

  async moveDirectory(projectId: string, oldPath: string, newPath: string): Promise<void> {
    this.ensureInitialized();
    
    const normalizedNew = newPath.endsWith('/') ? newPath : newPath + '/';
    const normalizedOld = oldPath.endsWith('/') ? oldPath : oldPath + '/';
    
    if (normalizedNew.startsWith(normalizedOld)) {
      throw new Error('Cannot move a directory into itself');
    }
    
    await this.renameDirectory(projectId, oldPath, newPath);
  }

  async createProject(name: string, description?: string, id?: string): Promise<Project> {
    this.ensureInitialized();

    try {
      const project: Project = {
        id: id || uuidv4(),
        name,
        description,
        createdAt: new Date(),
        updatedAt: new Date(),
        settings: {},
        lastSavedCheckpointId: null,
        lastSavedAt: null,
        costTracking: {
          totalCost: 0,
          providerBreakdown: {},
          sessionHistory: []
        }
      };

      await this.adapter.createProject(project);
      
      const rootNode: FileTreeNode = {
        id: uuidv4(),
        projectId: project.id,
        path: '/',
        name: '/',
        type: 'directory',
        parentPath: null,
        children: []
      };
      
      await this.adapter.createTreeNode(rootNode);
      
      return project;
    } catch (error) {
      throw error;
    }
  }

  async getProject(id: string): Promise<Project> {
    this.ensureInitialized();
    
    const project = await this.adapter.getProject(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    
    return project;
  }

  async updateProject(project: Project, options?: { preserveUpdatedAt?: boolean }): Promise<void> {
    this.ensureInitialized();

    // Only update timestamp if not preserving (for sync metadata updates)
    if (!options?.preserveUpdatedAt) {
      project.updatedAt = new Date();
    }
    await this.adapter.updateProject(project);
  }

  async updateProjectCost(
    projectId: string, 
    usage: { 
      cost: number; 
      provider: string; 
      tokenUsage?: { input: number; output: number };
      sessionId?: string;
      mode?: 'absolute' | 'delta';
    }
  ): Promise<void> {
    this.ensureInitialized();

    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!project.costTracking || !project.costTracking.providerBreakdown) {
      project.costTracking = {
        totalCost: project.costTracking?.totalCost ?? 0,
        providerBreakdown: project.costTracking?.providerBreakdown ?? {},
        sessionHistory: project.costTracking?.sessionHistory ?? []
      };
    }

    project.costTracking.totalCost += usage.cost;

    if (!project.costTracking.providerBreakdown[usage.provider]) {
      project.costTracking.providerBreakdown[usage.provider] = {
        totalCost: 0,
        tokenUsage: { input: 0, output: 0 },
        requestCount: 0,
        lastUpdated: new Date()
      };
    }

    const providerStats = project.costTracking.providerBreakdown[usage.provider];
    providerStats.totalCost += usage.cost;
    if (usage.mode !== 'delta') {
      providerStats.requestCount += 1;
    }
    providerStats.lastUpdated = new Date();

    if (usage.tokenUsage) {
      providerStats.tokenUsage.input += usage.tokenUsage.input;
      providerStats.tokenUsage.output += usage.tokenUsage.output;
    }

    if (usage.sessionId && usage.mode !== 'delta') {
      if (!project.costTracking.sessionHistory) {
        project.costTracking.sessionHistory = [];
      }
      
      project.costTracking.sessionHistory.push({
        sessionId: usage.sessionId,
        cost: usage.cost,
        provider: usage.provider,
        timestamp: new Date(),
        tokenUsage: usage.tokenUsage
      });

      if (project.costTracking.sessionHistory.length > 100) {
        project.costTracking.sessionHistory = project.costTracking.sessionHistory.slice(-100);
      }
    }

    await this.updateProject(project);
  }

  async applyProjectCostDelta(
    projectId: string,
    usage: {
      costDelta: number;
      provider: string;
      tokenUsageDelta?: { input: number; output: number };
      sessionId?: string;
    }
  ): Promise<void> {
    this.ensureInitialized();

    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (!project.costTracking) {
      project.costTracking = {
        totalCost: 0,
        providerBreakdown: {},
        sessionHistory: []
      };
    }

    project.costTracking.totalCost += usage.costDelta;

    if (!project.costTracking.providerBreakdown[usage.provider]) {
      project.costTracking.providerBreakdown[usage.provider] = {
        totalCost: 0,
        tokenUsage: { input: 0, output: 0 },
        requestCount: 0,
        lastUpdated: new Date()
      };
    }

    const providerStats = project.costTracking.providerBreakdown[usage.provider];
    providerStats.totalCost += usage.costDelta;
    providerStats.lastUpdated = new Date();

    if (usage.tokenUsageDelta) {
      providerStats.tokenUsage.input += usage.tokenUsageDelta.input;
      providerStats.tokenUsage.output += usage.tokenUsageDelta.output;
    }

    if (usage.sessionId) {
      if (!project.costTracking.sessionHistory) {
        project.costTracking.sessionHistory = [];
      }

      project.costTracking.sessionHistory.push({
        sessionId: usage.sessionId,
        cost: usage.costDelta,
        provider: usage.provider,
        timestamp: new Date(),
        tokenUsage: usage.tokenUsageDelta,
        correction: true
      });

      if (project.costTracking.sessionHistory.length > 100) {
        project.costTracking.sessionHistory = project.costTracking.sessionHistory.slice(-100);
      }
    }

    await this.updateProject(project);
  }

  async deleteProject(id: string): Promise<void> {
    this.ensureInitialized();
    
    await this.adapter.deleteProject(id);
  }

  async listProjects(): Promise<Project[]> {
    this.ensureInitialized();

    return await this.adapter.listProjects();
  }

  async listFiles(projectId: string): Promise<VirtualFile[]> {
    this.ensureInitialized();

    return await this.adapter.listFiles(projectId);
  }

  async getFileTree(projectId: string): Promise<FileTreeNode | null> {
    this.ensureInitialized();
    
    return await this.adapter.getTreeNode(projectId, '/');
  }

  async searchFiles(
    projectId: string, 
    query: string,
    options?: {
      regex?: boolean;
      fileType?: string;
      limit?: number;
      searchIn?: 'content' | 'filename' | 'both';
    }
  ): Promise<VirtualFile[]> {
    this.ensureInitialized();
    
    const allFiles = await this.adapter.listFiles(projectId);
    const { 
      regex = false, 
      fileType, 
      limit = 20, 
      searchIn = 'both' 
    } = options || {};
    
    let filesToSearch = allFiles;
    if (fileType) {
      const extension = fileType.startsWith('.') ? fileType : `.${fileType}`;
      filesToSearch = allFiles.filter(file => file.path.endsWith(extension));
    }
    
    const searchFunction = regex 
      ? (text: string) => {
          try {
            const pattern = new RegExp(query, 'i');
            return pattern.test(text);
          } catch {
            return text.toLowerCase().includes(query.toLowerCase());
          }
        }
      : (text: string) => text.toLowerCase().includes(query.toLowerCase());
    
    const results = filesToSearch.filter(file => {
      if (searchIn === 'filename') {
        return searchFunction(file.name) || searchFunction(file.path);
      } else if (searchIn === 'content') {
        return typeof file.content === 'string' && searchFunction(file.content);
      } else {
        return searchFunction(file.name) || 
               searchFunction(file.path) ||
               (typeof file.content === 'string' && searchFunction(file.content));
      }
    });
    
    return results.slice(0, limit);
  }

  async findReferences(
    projectId: string,
    identifier: string,
    type: 'class' | 'id' | 'function' | 'variable' | 'any' = 'any'
  ): Promise<Array<{ file: VirtualFile; matches: Array<{ line: number; text: string }> }>> {
    this.ensureInitialized();
    
    const allFiles = await this.adapter.listFiles(projectId);
    const results: Array<{ file: VirtualFile; matches: Array<{ line: number; text: string }> }> = [];
    
    const patterns: RegExp[] = [];
    
    switch (type) {
      case 'class':
        patterns.push(new RegExp(`class=["'][^"']*\\b${identifier}\\b[^"']*["']`, 'gi'));
        patterns.push(new RegExp(`\\.${identifier}\\b`, 'g'));
        patterns.push(new RegExp(`classList\\.(add|remove|toggle|contains)\\(['"\`]${identifier}['"\`]`, 'g'));
        break;
      
      case 'id':
        patterns.push(new RegExp(`id=["']${identifier}["']`, 'gi'));
        patterns.push(new RegExp(`#${identifier}\\b`, 'g'));
        patterns.push(new RegExp(`getElementById\\(['"\`]${identifier}['"\`]`, 'g'));
        patterns.push(new RegExp(`querySelector\\(['"\`]#${identifier}['"\`]`, 'g'));
        break;
      
      case 'function':
        patterns.push(new RegExp(`function\\s+${identifier}\\s*\\(`, 'g'));
        patterns.push(new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*(?:\\([^)]*\\)|[^=])\\s*=>`, 'g'));
        patterns.push(new RegExp(`${identifier}\\s*\\(`, 'g'));
        break;
      
      case 'variable':
        patterns.push(new RegExp(`(?:const|let|var)\\s+${identifier}\\b`, 'g'));
        patterns.push(new RegExp(`\\b${identifier}\\b`, 'g'));
        break;
      
      case 'any':
      default:
        patterns.push(new RegExp(`\\b${identifier}\\b`, 'gi'));
        break;
    }
    
    for (const file of allFiles) {
      if (typeof file.content !== 'string') continue;
      
      const matches: Array<{ line: number; text: string }> = [];
      const lines = file.content.split('\n');
      
      lines.forEach((line, index) => {
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            matches.push({
              line: index + 1,
              text: line.trim()
            });
            break;
          }
        }
      });
      
      if (matches.length > 0) {
        results.push({ file, matches });
      }
    }
    
    return results;
  }

  async getFileStats(projectId: string, path: string): Promise<{
    path: string;
    size: number;
    lines: number;
    type: string;
    preview: string[];
    lastModified: Date;
  }> {
    this.ensureInitialized();
    
    const file = await this.adapter.getFile(projectId, path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    
    const content = typeof file.content === 'string' ? file.content : '';
    const lines = content.split('\n');
    
    return {
      path: file.path,
      size: file.size,
      lines: lines.length,
      type: file.type,
      preview: lines.slice(0, 10),
      lastModified: file.updatedAt
    };
  }

  async getProjectSize(projectId: string): Promise<number> {
    this.ensureInitialized();
    
    const files = await this.adapter.listFiles(projectId);
    return files.reduce((total, file) => total + file.size, 0);
  }

  async getProjectStats(projectId: string): Promise<{
    fileCount: number;
    totalSize: number;
    fileTypes: Record<string, number>;
    formattedSize: string;
  }> {
    this.ensureInitialized();
    
    const files = await this.adapter.listFiles(projectId);
    
    let totalSize = 0;
    const fileTypes: Record<string, number> = {};
    
    for (const file of files) {
      totalSize += file.size;
      
      const ext = file.path.split('.').pop()?.toUpperCase() || 'OTHER';
      fileTypes[ext] = (fileTypes[ext] || 0) + 1;
    }
    
    let formattedSize: string;
    if (totalSize < 1024) {
      formattedSize = `${totalSize} B`;
    } else if (totalSize < 1024 * 1024) {
      formattedSize = `${(totalSize / 1024).toFixed(1)} KB`;
    } else {
      formattedSize = `${(totalSize / (1024 * 1024)).toFixed(2)} MB`;
    }
    
    return {
      fileCount: files.length,
      totalSize,
      fileTypes,
      formattedSize
    };
  }

  async exportProject(projectId: string): Promise<{ project: Project; files: VirtualFile[] }> {
    this.ensureInitialized();
    
    const project = await this.getProject(projectId);
    const files = await this.adapter.listFiles(projectId);
    
    return { project, files };
  }

  async exportProjectAsZip(projectId: string): Promise<Blob> {
    this.ensureInitialized();

    const zip = new JSZip();

    try {
      const project = await this.getProject(projectId);
      const runtime = project?.settings?.runtime || 'handlebars';
      const runtimeConfig = getRuntimeConfig(runtime);

      // For terminal-mode runtimes (Python, Lua), package raw source files
      if (runtimeConfig.previewMode === 'terminal') {
        const files = await this.adapter.listFiles(projectId);
        for (const file of files) {
          if (this.shouldExcludeFromExport(file.path)) continue;
          const zipPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
          if (typeof file.content === 'string') {
            zip.file(zipPath, file.content);
          } else {
            zip.file(zipPath, file.content);
          }
        }

        // Add a README with run instructions
        const readmeLines = [
          `# ${project?.name || 'Project'}`,
          '',
          project?.description || '',
          '',
          '## How to Run',
          '',
        ];
        if (runtime === 'python') {
          readmeLines.push('```bash', 'python main.py', '```');
        } else if (runtime === 'lua') {
          readmeLines.push('```bash', 'lua main.lua', '```');
        }
        zip.file('README.md', readmeLines.join('\n'));

        return zip.generateAsync({ type: 'blob' });
      }

      // Create VirtualServer instance and compile the project
      const { VirtualServer } = await import('@/lib/preview/virtual-server');
      const server = new VirtualServer(this, projectId, { runtime: project?.settings?.runtime });
      const compiledProject = await server.compileProject();
      
      // Add compiled files to ZIP, filtering out template-related files
      for (const file of compiledProject.files) {
        const zipPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
        
        // Skip template files, data files, and template directories
        if (this.shouldExcludeFromExport(file.path)) {
          continue;
        }

        zip.file(zipPath, file.content);
      }

      // For bundled projects: also include raw source files (.tsx/.ts/.jsx)
      // and inject package.json + vite.config.ts for local development
      const allFiles = await this.adapter.listFiles(projectId);
      const hasBundleableFiles = allFiles.some(f =>
        f.path.endsWith('.tsx') || f.path.endsWith('.ts') || f.path.endsWith('.jsx')
      );

      if (hasBundleableFiles) {
        // Add source files that were compiled into the bundle
        for (const file of allFiles) {
          if (file.path.endsWith('.tsx') || file.path.endsWith('.ts') || file.path.endsWith('.jsx')) {
            const zipPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
            if (typeof file.content === 'string') {
              zip.file(zipPath, file.content);
            }
          }
        }

        // Inject package.json for local dev with Vite
        const projectSlug = (project?.name || 'my-app').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        zip.file('package.json', JSON.stringify({
          name: projectSlug,
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
          devDependencies: {
            '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0',
            typescript: '^5.6.0', vite: '^6.0.0', '@vitejs/plugin-react': '^4.0.0'
          }
        }, null, 2));

        zip.file('vite.config.ts',
          `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`
        );
      }

      // Clean up VirtualServer resources
      server.cleanupBlobUrls();

    } catch (error) {
      logger.warn('Failed to compile Handlebars templates during export, falling back to raw files:', error);
      
      // Fallback to original behavior if Handlebars compilation fails
      const files = await this.adapter.listFiles(projectId);
      
      for (const file of files) {
        const zipPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
        
        // Skip template files even in fallback mode
        if (this.shouldExcludeFromExport(file.path)) {
          continue;
        }

        zip.file(zipPath, file.content);
      }
    }

    const blob = await zip.generateAsync({ 
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: {
        level: 6
      }
    });
    
    return blob;
  }

  private shouldExcludeFromExport(filePath: string): boolean {
    // Exclude template files and related development files
    if (filePath.endsWith('.hbs') || filePath.endsWith('.handlebars')) {
      return true;
    }
    
    // Exclude templates directory
    if (filePath.startsWith('/templates/')) {
      return true;
    }
    
    // Exclude data.json file (since it's compiled into HTML)
    if (filePath === '/data.json') {
      return true;
    }

    // Exclude dot-prefixed files and directories (e.g. .PROMPT.md, .DESIGN.md, .skills/)
    const firstSegment = filePath.split('/').filter(Boolean)[0];
    if (firstSegment && firstSegment.startsWith('.')) {
      return true;
    }

    return false;
  }

  async duplicateProject(projectId: string): Promise<Project> {
    this.ensureInitialized();
    
    const originalProject = await this.getProject(projectId);
    const files = await this.adapter.listFiles(projectId);
    
    const newName = `${originalProject.name} (Copy)`.slice(0, 50);
    const newProject = await this.createProject(
      newName,
      originalProject.description
    );
    
    await saveManager.runWithSuppressedDirty(newProject.id, async () => {
      for (const file of files) {
        await this.createFile(newProject.id, file.path, file.content);
      }
    });

    return newProject;
  }

  async importProject(data: { project: Project; files: VirtualFile[] }): Promise<Project> {
    this.ensureInitialized();
    
    const newProject = await this.createProject(data.project.name, data.project.description);
    
    await saveManager.runWithSuppressedDirty(newProject.id, async () => {
      for (const file of data.files) {
        await this.createFile(newProject.id, file.path, file.content as string);
      }
    });

    return newProject;
  }

  private getParentPath(path: string): string | null {
    if (path === '/') return null;
    
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1) return '/';
    
    parts.pop();
    return '/' + parts.join('/');
  }

  private async updateFileTree(projectId: string, path: string, operation: 'create' | 'delete', silent = false): Promise<void> {
    const parentPath = this.getParentPath(path);
    if (parentPath === null) return;
    
    let parentNode = await this.adapter.getTreeNode(projectId, parentPath);
    
    if (!parentNode && operation === 'create') {
      await this.createDirectory(projectId, parentPath);
      parentNode = await this.adapter.getTreeNode(projectId, parentPath);
    }
    
    if (parentNode) {
      const children = parentNode.children || [];
      
      if (operation === 'create' && !children.includes(path)) {
        children.push(path);
      } else if (operation === 'delete') {
        const index = children.indexOf(path);
        if (index > -1) {
          children.splice(index, 1);
        }
      }
      
      parentNode.children = children;
      await this.adapter.updateTreeNode(parentNode);

      if (!silent && typeof window !== 'undefined') {
        window.dispatchEvent(new Event('filesChanged'));
      }
    }
  }
}

export const vfs = new VirtualFileSystem();

let _contextVFSProvider: (() => VirtualFileSystem | undefined) | null = null;

export function registerContextVFSProvider(provider: () => VirtualFileSystem | undefined): void {
  _contextVFSProvider = provider;
}

export function getActiveVFS(): VirtualFileSystem {
  return _contextVFSProvider?.() ?? vfs;
}

export * from './types';
