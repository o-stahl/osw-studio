/**
 * Runtime Database Manager
 *
 * Manages the runtime portion of per-deployment SQLite databases containing:
 * - Deployment info/settings (single row)
 * - Files and file tree nodes
 * - Edge functions and execution logs
 * - Server functions
 * - Secrets (encrypted)
 * - Scheduled functions
 * - User-created tables (DDL execution)
 *
 * Each deployment gets its own runtime database at deployments/{deploymentId}/runtime.sqlite
 */

import type { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { FileTreeNode, Deployment, EdgeFunction, FunctionLog, TableInfo, ServerFunction, Secret, ScheduledFunction } from '../types';
import { encryptSecret, isEncryptionConfigured } from '../../edge-functions/secrets-crypto';
import { getRuntimeDatabaseConnection, closeRuntimeDatabase } from './sqlite-connection';

/**
 * Helper to ensure a value is a Date and convert to ISO string
 */
function toISOString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.toISOString();
}

/**
 * Helper to ensure a value is a Date and convert to ISO string (non-null)
 */
function toISOStringRequired(value: Date | string): string {
  if (typeof value === 'string') return value;
  return value.toISOString();
}

/**
 * Helper to parse JSON safely with a fallback
 */
function parseJSON<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Helper to parse Date from ISO string
 */
function parseDate(value: string | null | undefined): Date {
  if (!value) return new Date();
  return new Date(value);
}

/**
 * Per-deployment runtime database manager
 */
export class RuntimeDatabase {
  private db: Database;
  private deploymentId: string;
  private initialized = false;

  constructor(deploymentId: string) {
    this.deploymentId = deploymentId;
    this.db = getRuntimeDatabaseConnection(deploymentId);
  }

  /**
   * Initialize the database schema
   */
  init(): void {
    if (this.initialized) return;

    // Deployment info (single row)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS site_info (
        id TEXT PRIMARY KEY DEFAULT 'main',
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        under_construction INTEGER NOT NULL DEFAULT 0,
        custom_domain TEXT,
        head_scripts TEXT NOT NULL DEFAULT '[]',
        body_scripts TEXT NOT NULL DEFAULT '[]',
        cdn_links TEXT NOT NULL DEFAULT '[]',
        analytics TEXT NOT NULL DEFAULT '{}',
        seo TEXT NOT NULL DEFAULT '{}',
        compliance TEXT NOT NULL DEFAULT '{}',
        settings_version INTEGER NOT NULL DEFAULT 1,
        last_published_version INTEGER,
        preview_image TEXT,
        preview_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      )
    `);

    // Files
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT DEFAULT '{}'
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`);

    // File tree nodes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_tree_nodes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_path TEXT,
        is_expanded INTEGER DEFAULT 0,
        children TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}'
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent_path ON file_tree_nodes(parent_path)`);

    // Edge Functions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edge_functions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        code TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'ANY',
        enabled INTEGER NOT NULL DEFAULT 1,
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_functions_name ON edge_functions(name)`);

    // Function Execution Logs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS function_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        function_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER,
        duration_ms INTEGER,
        error TEXT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (function_id) REFERENCES edge_functions(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_function_logs_function_id ON function_logs(function_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_function_logs_timestamp ON function_logs(timestamp)`);

    // Server Functions (callable from edge functions)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_functions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        code TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_server_functions_name ON server_functions(name)`);

    // Secrets (encrypted key-value storage)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name)`);

    // Scheduled Functions (cron-triggered edge function execution)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_functions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        function_id TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (function_id) REFERENCES edge_functions(id) ON DELETE CASCADE
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_functions_name ON scheduled_functions(name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_functions_next_run ON scheduled_functions(next_run_at)`);

    this.initialized = true;
  }

  /**
   * Close the database connection
   */
  close(): void {
    closeRuntimeDatabase(this.deploymentId);
  }

  // ============================================
  // Deployment Info
  // ============================================

  createDeploymentInfo(deployment: Deployment): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO site_info (
        id, project_id, name, slug, under_construction,
        custom_domain, head_scripts, body_scripts, cdn_links,
        analytics, seo, compliance, settings_version,
        last_published_version, preview_image, preview_updated_at,
        created_at, updated_at, published_at
      ) VALUES (
        'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      deployment.projectId,
      deployment.name,
      deployment.slug ?? null,
      deployment.underConstruction ? 1 : 0,
      deployment.customDomain ?? null,
      JSON.stringify(deployment.headScripts ?? []),
      JSON.stringify(deployment.bodyScripts ?? []),
      JSON.stringify(deployment.cdnLinks ?? []),
      JSON.stringify(deployment.analytics ?? {}),
      JSON.stringify(deployment.seo ?? {}),
      JSON.stringify(deployment.compliance ?? {}),
      deployment.settingsVersion ?? 1,
      deployment.lastPublishedVersion ?? null,
      deployment.previewImage ?? null,
      toISOString(deployment.previewUpdatedAt),
      toISOStringRequired(deployment.createdAt),
      toISOStringRequired(deployment.updatedAt),
      toISOString(deployment.publishedAt)
    );
  }

  getDeploymentInfo(): Deployment | null {
    const row = this.db.prepare('SELECT * FROM site_info WHERE id = ?').get('main') as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: this.deploymentId,
      projectId: row.project_id as string,
      name: row.name as string,
      slug: row.slug as string | undefined,
      underConstruction: Boolean(row.under_construction),
      customDomain: row.custom_domain as string | undefined,
      headScripts: parseJSON(row.head_scripts as string, []),
      bodyScripts: parseJSON(row.body_scripts as string, []),
      cdnLinks: parseJSON(row.cdn_links as string, []),
      analytics: parseJSON(row.analytics as string, { enabled: false, provider: 'builtin' as const, privacyMode: true }),
      seo: parseJSON(row.seo as string, {}),
      compliance: parseJSON(row.compliance as string, { enabled: false, bannerPosition: 'bottom' as const, bannerStyle: 'bar' as const, message: '', acceptButtonText: 'Accept', declineButtonText: 'Decline', mode: 'opt-in' as const, blockAnalytics: false }),
      settingsVersion: row.settings_version as number,
      lastPublishedVersion: row.last_published_version as number | undefined,
      previewImage: row.preview_image as string | undefined,
      previewUpdatedAt: row.preview_updated_at ? parseDate(row.preview_updated_at as string) : undefined,
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
      publishedAt: row.published_at ? parseDate(row.published_at as string) : null,
    };
  }

  updateDeploymentInfo(deployment: Partial<Deployment>): void {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (deployment.name !== undefined) { updates.push('name = ?'); values.push(deployment.name); }
    if (deployment.slug !== undefined) { updates.push('slug = ?'); values.push(deployment.slug); }
    if (deployment.underConstruction !== undefined) { updates.push('under_construction = ?'); values.push(deployment.underConstruction ? 1 : 0); }
    if (deployment.customDomain !== undefined) { updates.push('custom_domain = ?'); values.push(deployment.customDomain); }
    if (deployment.headScripts !== undefined) { updates.push('head_scripts = ?'); values.push(JSON.stringify(deployment.headScripts)); }
    if (deployment.bodyScripts !== undefined) { updates.push('body_scripts = ?'); values.push(JSON.stringify(deployment.bodyScripts)); }
    if (deployment.cdnLinks !== undefined) { updates.push('cdn_links = ?'); values.push(JSON.stringify(deployment.cdnLinks)); }
    if (deployment.analytics !== undefined) { updates.push('analytics = ?'); values.push(JSON.stringify(deployment.analytics)); }
    if (deployment.seo !== undefined) { updates.push('seo = ?'); values.push(JSON.stringify(deployment.seo)); }
    if (deployment.compliance !== undefined) { updates.push('compliance = ?'); values.push(JSON.stringify(deployment.compliance)); }
    if (deployment.settingsVersion !== undefined) { updates.push('settings_version = ?'); values.push(deployment.settingsVersion); }
    if (deployment.lastPublishedVersion !== undefined) { updates.push('last_published_version = ?'); values.push(deployment.lastPublishedVersion); }
    if (deployment.previewImage !== undefined) { updates.push('preview_image = ?'); values.push(deployment.previewImage); }
    if (deployment.previewUpdatedAt !== undefined) { updates.push('preview_updated_at = ?'); values.push(toISOString(deployment.previewUpdatedAt)); }
    if (deployment.updatedAt !== undefined) { updates.push('updated_at = ?'); values.push(toISOStringRequired(deployment.updatedAt)); }
    if (deployment.publishedAt !== undefined) { updates.push('published_at = ?'); values.push(toISOString(deployment.publishedAt)); }

    if (updates.length === 0) return;

    if (!deployment.updatedAt) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
    }

    const sql = `UPDATE site_info SET ${updates.join(', ')} WHERE id = 'main'`;
    this.db.prepare(sql).run(...values);
  }

  // This class exposes no file accessors: published sites are served from disk, and the runtime
  // database is used only for edge functions, scheduled functions, secrets and user queries. Its
  // files table is kept because user SQL can reach it.

  // ============================================
  // File Tree Nodes
  // ============================================

  createTreeNode(node: FileTreeNode): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_tree_nodes (id, path, name, type, parent_path, is_expanded, children, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      node.id,
      node.path,
      node.name,
      node.type,
      node.parentPath,
      node.isExpanded ? 1 : 0,
      JSON.stringify(node.children ?? []),
      JSON.stringify(node.metadata ?? {})
    );
  }

  getTreeNode(path: string): FileTreeNode | null {
    const row = this.db.prepare('SELECT * FROM file_tree_nodes WHERE path = ?').get(path) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToTreeNode(row);
  }

  updateTreeNode(node: FileTreeNode): void {
    const stmt = this.db.prepare(`
      UPDATE file_tree_nodes SET
        name = ?, type = ?, parent_path = ?, is_expanded = ?, children = ?, metadata = ?
      WHERE path = ?
    `);

    stmt.run(
      node.name,
      node.type,
      node.parentPath,
      node.isExpanded ? 1 : 0,
      JSON.stringify(node.children ?? []),
      JSON.stringify(node.metadata ?? {}),
      node.path
    );
  }

  deleteTreeNode(path: string): void {
    this.db.prepare('DELETE FROM file_tree_nodes WHERE path = ?').run(path);
  }

  getChildNodes(parentPath: string | null): FileTreeNode[] {
    const rows = this.db.prepare(
      'SELECT * FROM file_tree_nodes WHERE parent_path IS ? ORDER BY type DESC, path'
    ).all(parentPath) as Record<string, unknown>[];

    return rows.map(row => this.rowToTreeNode(row));
  }

  getAllTreeNodes(): FileTreeNode[] {
    const rows = this.db.prepare('SELECT * FROM file_tree_nodes ORDER BY path').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToTreeNode(row));
  }

  private rowToTreeNode(row: Record<string, unknown>): FileTreeNode {
    return {
      id: row.id as string,
      projectId: this.deploymentId,
      path: row.path as string,
      name: row.name as string,
      type: row.type as 'file' | 'directory',
      parentPath: row.parent_path as string | null,
      isExpanded: Boolean(row.is_expanded),
      children: parseJSON(row.children as string, []),
      metadata: parseJSON(row.metadata as string, {}),
    };
  }

  // ============================================
  // Edge Functions: CRUD
  // ============================================

  createFunction(fn: Omit<EdgeFunction, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>): string {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO edge_functions (
        id, name, description, code, method, enabled, timeout_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      fn.name,
      fn.description ?? null,
      fn.code,
      fn.method,
      fn.enabled ? 1 : 0,
      fn.timeoutMs,
      now,
      now
    );

    return id;
  }

  getFunction(id: string): EdgeFunction | null {
    const row = this.db.prepare('SELECT * FROM edge_functions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToFunction(row);
  }

  getFunctionByName(name: string): EdgeFunction | null {
    const row = this.db.prepare('SELECT * FROM edge_functions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToFunction(row);
  }

  updateFunction(id: string, updates: Partial<Omit<EdgeFunction, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description); }
    if (updates.code !== undefined) { setClauses.push('code = ?'); values.push(updates.code); }
    if (updates.method !== undefined) { setClauses.push('method = ?'); values.push(updates.method); }
    if (updates.enabled !== undefined) { setClauses.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.timeoutMs !== undefined) { setClauses.push('timeout_ms = ?'); values.push(updates.timeoutMs); }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE edge_functions SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  deleteFunction(id: string): void {
    this.db.prepare('DELETE FROM edge_functions WHERE id = ?').run(id);
  }

  listFunctions(): EdgeFunction[] {
    const rows = this.db.prepare('SELECT * FROM edge_functions ORDER BY name').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToFunction(row));
  }

  private rowToFunction(row: Record<string, unknown>): EdgeFunction {
    return {
      id: row.id as string,
      projectId: '',
      name: row.name as string,
      description: row.description as string | undefined,
      code: row.code as string,
      method: row.method as EdgeFunction['method'],
      enabled: Boolean(row.enabled),
      timeoutMs: row.timeout_ms as number,
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
    };
  }

  // ============================================
  // Edge Functions: Logging
  // ============================================

  logFunctionExecution(functionId: string, data: {
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    error?: string;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO function_logs (function_id, method, path, status_code, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      functionId,
      data.method,
      data.path,
      data.statusCode,
      data.durationMs,
      data.error ?? null
    );
  }

  getFunctionLogs(functionId: string, limit: number = 100): FunctionLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM function_logs WHERE function_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(functionId, limit) as Record<string, unknown>[];

    return rows.map(row => this.rowToFunctionLog(row));
  }

  getRecentLogs(limit: number = 100): FunctionLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM function_logs ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map(row => this.rowToFunctionLog(row));
  }

  clearFunctionLogs(functionId?: string, beforeDate?: Date): void {
    if (functionId && beforeDate) {
      this.db.prepare('DELETE FROM function_logs WHERE function_id = ? AND timestamp < ?')
        .run(functionId, beforeDate.toISOString());
    } else if (functionId) {
      this.db.prepare('DELETE FROM function_logs WHERE function_id = ?').run(functionId);
    } else if (beforeDate) {
      this.db.prepare('DELETE FROM function_logs WHERE timestamp < ?').run(beforeDate.toISOString());
    } else {
      this.db.prepare('DELETE FROM function_logs').run();
    }
  }

  private rowToFunctionLog(row: Record<string, unknown>): FunctionLog {
    return {
      id: row.id as number,
      functionId: row.function_id as string,
      method: row.method as string,
      path: row.path as string,
      statusCode: row.status_code as number,
      durationMs: row.duration_ms as number,
      error: row.error as string | undefined,
      timestamp: parseDate(row.timestamp as string),
    };
  }

  // ============================================
  // Server Functions: CRUD
  // ============================================

  createServerFunction(fn: Omit<ServerFunction, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>): string {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO server_functions (
        id, name, description, code, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      fn.name,
      fn.description ?? null,
      fn.code,
      fn.enabled ? 1 : 0,
      now,
      now
    );

    return id;
  }

  getServerFunction(id: string): ServerFunction | null {
    const row = this.db.prepare('SELECT * FROM server_functions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToServerFunction(row);
  }

  getServerFunctionByName(name: string): ServerFunction | null {
    const row = this.db.prepare('SELECT * FROM server_functions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToServerFunction(row);
  }

  updateServerFunction(id: string, updates: Partial<Omit<ServerFunction, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description); }
    if (updates.code !== undefined) { setClauses.push('code = ?'); values.push(updates.code); }
    if (updates.enabled !== undefined) { setClauses.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE server_functions SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  deleteServerFunction(id: string): void {
    this.db.prepare('DELETE FROM server_functions WHERE id = ?').run(id);
  }

  listServerFunctions(): ServerFunction[] {
    const rows = this.db.prepare('SELECT * FROM server_functions ORDER BY name').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToServerFunction(row));
  }

  private rowToServerFunction(row: Record<string, unknown>): ServerFunction {
    return {
      id: row.id as string,
      projectId: '',
      name: row.name as string,
      description: row.description as string | undefined,
      code: row.code as string,
      enabled: Boolean(row.enabled),
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
    };
  }

  // ============================================
  // Secrets Management
  // ============================================

  createSecret(name: string, value: string, description?: string): string {
    if (!isEncryptionConfigured()) {
      throw new Error('Secrets encryption not configured. Set SECRETS_ENCRYPTION_KEY environment variable.');
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const encrypted = encryptSecret(value);

    this.db.prepare(`
      INSERT INTO secrets (id, name, encrypted_value, iv, auth_tag, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, encrypted.encryptedValue, encrypted.iv, encrypted.authTag, description || null, now, now);

    return id;
  }

  getSecret(id: string): Secret | null {
    const row = this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSecret(row);
  }

  getSecretByName(name: string): Secret | null {
    const row = this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSecret(row);
  }

  updateSecretValue(id: string, value: string): void {
    if (!isEncryptionConfigured()) {
      throw new Error('Secrets encryption not configured. Set SECRETS_ENCRYPTION_KEY environment variable.');
    }

    const now = new Date().toISOString();
    const encrypted = encryptSecret(value);

    this.db.prepare(`
      UPDATE secrets
      SET encrypted_value = ?, iv = ?, auth_tag = ?, updated_at = ?
      WHERE id = ?
    `).run(encrypted.encryptedValue, encrypted.iv, encrypted.authTag, now, id);
  }

  updateSecretMetadata(id: string, updates: { name?: string; description?: string }): void {
    const now = new Date().toISOString();

    if (updates.name !== undefined) {
      this.db.prepare('UPDATE secrets SET name = ?, updated_at = ? WHERE id = ?')
        .run(updates.name, now, id);
    }

    if (updates.description !== undefined) {
      this.db.prepare('UPDATE secrets SET description = ?, updated_at = ? WHERE id = ?')
        .run(updates.description, now, id);
    }
  }

  deleteSecret(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }

  listSecrets(): Secret[] {
    const rows = this.db.prepare('SELECT * FROM secrets ORDER BY name').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToSecret(row));
  }

  listSecretsWithValues(): Array<{
    name: string;
    encryptedValue: string;
    iv: string;
    authTag: string;
  }> {
    const rows = this.db.prepare('SELECT name, encrypted_value, iv, auth_tag FROM secrets').all() as Record<string, unknown>[];
    return rows.map(row => ({
      name: row.name as string,
      encryptedValue: row.encrypted_value as string,
      iv: row.iv as string,
      authTag: row.auth_tag as string,
    }));
  }

  private rowToSecret(row: Record<string, unknown>): Secret {
    return {
      id: row.id as string,
      projectId: '',
      name: row.name as string,
      description: row.description as string | undefined,
      hasValue: row.encrypted_value !== null && row.encrypted_value !== '',
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
    };
  }

  createSecretPlaceholder(name: string, description?: string): string {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO secrets (id, name, encrypted_value, iv, auth_tag, description, created_at, updated_at)
      VALUES (?, ?, '', '', '', ?, ?, ?)
    `).run(id, name, description || null, now, now);

    return id;
  }

  // ============================================
  // Scheduled Functions: CRUD
  // ============================================

  createScheduledFunction(fn: Omit<ScheduledFunction, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>): string {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO scheduled_functions (
        id, name, description, function_id, cron_expression, timezone,
        config, enabled, last_run_at, next_run_at, last_status, last_error,
        last_duration_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      fn.name,
      fn.description ?? null,
      fn.functionId,
      fn.cronExpression,
      fn.timezone || 'UTC',
      JSON.stringify(fn.config || {}),
      fn.enabled ? 1 : 0,
      toISOString(fn.lastRunAt),
      toISOString(fn.nextRunAt),
      fn.lastStatus ?? null,
      fn.lastError ?? null,
      fn.lastDurationMs ?? null,
      now,
      now
    );

    return id;
  }

  getScheduledFunction(id: string): ScheduledFunction | null {
    const row = this.db.prepare('SELECT * FROM scheduled_functions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToScheduledFunction(row);
  }

  getScheduledFunctionByName(name: string): ScheduledFunction | null {
    const row = this.db.prepare('SELECT * FROM scheduled_functions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToScheduledFunction(row);
  }

  updateScheduledFunction(id: string, updates: Partial<Omit<ScheduledFunction, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description); }
    if (updates.functionId !== undefined) { setClauses.push('function_id = ?'); values.push(updates.functionId); }
    if (updates.cronExpression !== undefined) { setClauses.push('cron_expression = ?'); values.push(updates.cronExpression); }
    if (updates.timezone !== undefined) { setClauses.push('timezone = ?'); values.push(updates.timezone); }
    if (updates.config !== undefined) { setClauses.push('config = ?'); values.push(JSON.stringify(updates.config)); }
    if (updates.enabled !== undefined) { setClauses.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.lastRunAt !== undefined) { setClauses.push('last_run_at = ?'); values.push(toISOString(updates.lastRunAt)); }
    if (updates.nextRunAt !== undefined) { setClauses.push('next_run_at = ?'); values.push(toISOString(updates.nextRunAt)); }
    if (updates.lastStatus !== undefined) { setClauses.push('last_status = ?'); values.push(updates.lastStatus); }
    if (updates.lastError !== undefined) { setClauses.push('last_error = ?'); values.push(updates.lastError); }
    if (updates.lastDurationMs !== undefined) { setClauses.push('last_duration_ms = ?'); values.push(updates.lastDurationMs); }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    const sql = `UPDATE scheduled_functions SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  deleteScheduledFunction(id: string): void {
    this.db.prepare('DELETE FROM scheduled_functions WHERE id = ?').run(id);
  }

  listScheduledFunctions(): ScheduledFunction[] {
    const rows = this.db.prepare('SELECT * FROM scheduled_functions ORDER BY name').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledFunction(row));
  }

  listDueScheduledFunctions(): ScheduledFunction[] {
    const rows = this.db.prepare(
      `SELECT * FROM scheduled_functions WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).all() as Record<string, unknown>[];
    return rows.map(row => this.rowToScheduledFunction(row));
  }

  private rowToScheduledFunction(row: Record<string, unknown>): ScheduledFunction {
    return {
      id: row.id as string,
      projectId: '',
      name: row.name as string,
      description: row.description as string | undefined,
      functionId: row.function_id as string,
      cronExpression: row.cron_expression as string,
      timezone: row.timezone as string,
      config: parseJSON(row.config as string, {}),
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at ? parseDate(row.last_run_at as string) : undefined,
      nextRunAt: row.next_run_at ? parseDate(row.next_run_at as string) : undefined,
      lastStatus: row.last_status as ScheduledFunction['lastStatus'],
      lastError: row.last_error as string | undefined,
      lastDurationMs: row.last_duration_ms as number | undefined,
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
    };
  }

  // ============================================
  // DDL Execution
  // ============================================

  executeDDL(sql: string): void {
    this.db.exec(sql);
  }

  // ============================================
  // Schema Management & Raw SQL
  // ============================================

  private static readonly SYSTEM_TABLES = [
    'site_info',
    'files',
    'file_tree_nodes',
    'edge_functions',
    'function_logs',
    'server_functions',
    'secrets',
    'scheduled_functions',
  ];

  private static readonly BLOCKED_PATTERNS = /^\s*(ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

  /**
   * The most rows one user statement hands back. `better-sqlite3` is synchronous and offers no
   * interrupt, so a statement cannot be stopped part way through from this thread; what can be
   * bounded is how much it returns, which is the memory and the response size.
   */
  private static readonly MAX_RESULT_ROWS = 5000;

  private static readonly TRIGGER_PATTERN = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;

  executeRawSQL(sql: string, params?: unknown[]): {
    columns: string[];
    rows: unknown[][];
    rowsAffected: number;
    /** The rowid of the last row a write inserted. */
    lastInsertRowid?: number;
    truncated?: boolean;
  } {
    if (RuntimeDatabase.BLOCKED_PATTERNS.test(sql)) {
      throw new Error('Statement type not allowed');
    }

    const trimmedSql = sql.trim().toLowerCase();

    const isSelect = trimmedSql.startsWith('select');

    if (isSelect) {
      const stmt = this.db.prepare(sql);
      // Pulled one row at a time and stopped at the cap, rather than `all()`, so the rows past it
      // are never materialised. The caller writes the query, so without this the size of the
      // answer is their choice: a whole table arriving in one response is both the memory it takes
      // here and the payload it becomes.
      const rows: unknown[][] = [];
      let columns: string[] = [];
      let truncated = false;
      const iterator = params ? stmt.iterate(...params) : stmt.iterate();
      for (const row of iterator) {
        if (columns.length === 0) columns = Object.keys(row as Record<string, unknown>);
        if (rows.length >= RuntimeDatabase.MAX_RESULT_ROWS) {
          truncated = true;
          // Releases the statement; without it the unread rows keep the query open.
          if (typeof (iterator as { return?: () => unknown }).return === 'function') {
            (iterator as { return: () => unknown }).return();
          }
          break;
        }
        rows.push(columns.map(col => (row as Record<string, unknown>)[col]));
      }

      if (rows.length === 0) {
        return { columns: [], rows: [], rowsAffected: 0 };
      }

      return { columns, rows, rowsAffected: 0, ...(truncated ? { truncated } : {}) };
    } else {
      const stmt = this.db.prepare(sql);
      const result = params ? stmt.run(...params) : stmt.run();

      return {
        columns: [],
        rows: [],
        rowsAffected: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    }
  }

  getTableSchema(): TableInfo[] {
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    return tables.flatMap(table => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) return [];

      const isSystemTable = RuntimeDatabase.SYSTEM_TABLES.includes(table.name);

      const columns = this.db.prepare(`PRAGMA table_info('${table.name}')`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const countResult = this.db.prepare(`SELECT COUNT(*) as count FROM "${table.name}"`).get() as { count: number };

      return {
        name: table.name,
        columns: columns.map(col => ({
          name: col.name,
          type: col.type,
          nullable: !col.notnull,
          primaryKey: col.pk > 0,
          defaultValue: col.dflt_value ?? undefined,
        })),
        rowCount: countResult.count,
        isSystemTable,
      };
    });
  }

  getTableData(tableName: string, limit: number = 100, offset: number = 0): {
    columns: string[];
    rows: unknown[][];
    total: number;
  } {
    const validTables = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName);

    if (!validTables) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    const countResult = this.db.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as { count: number };

    const rows = this.db.prepare(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];

    if (rows.length === 0) {
      return { columns: [], rows: [], total: countResult.count };
    }

    const columns = Object.keys(rows[0]);
    const rowsArray = rows.map(row => columns.map(col => row[col]));

    return {
      columns,
      rows: rowsArray,
      total: countResult.count,
    };
  }

  isSystemTable(tableName: string): boolean {
    return RuntimeDatabase.SYSTEM_TABLES.includes(tableName);
  }

  executeUserQuery(sql: string, params?: unknown[]): {
    columns: string[];
    rows: unknown[][];
    rowsAffected: number;
    truncated?: boolean;
    error?: string;
  } {
    const systemTableError = this.validateNotSystemTable(sql);
    if (systemTableError) {
      return {
        columns: [],
        rows: [],
        rowsAffected: 0,
        error: systemTableError,
      };
    }

    try {
      return this.executeRawSQL(sql, params);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        columns: [],
        rows: [],
        rowsAffected: 0,
        error: message,
      };
    }
  }

  /**
   * Which tables a statement writes, read from its compiled program rather than its text.
   *
   * Matching verb spellings could not hold: `INSERT OR REPLACE`, `REPLACE INTO`, a CTE before the
   * INSERT, `main.secrets`, `[secrets]` and a bare `DELETE FROM` (which compiles to `Clear`, not
   * `OpenWrite`) all reach a table without matching a start-anchored `INSERT INTO x`. SQLite has
   * already resolved every alias, quote and schema prefix by the time it emits opcodes, so the
   * program is the one description of the statement that cannot be reworded.
   *
   * `OpenWrite`/`Destroy` carry the root page in p2 and `Clear` in p1; sqlite_master maps a root
   * page back to its table, and an index page back to the table it belongs to.
   */
  private writtenTables(sql: string): Array<{ table: string; temp: boolean }> {
    let program: Array<{ opcode: string; p1: number; p2: number; p3: number }>;
    try {
      program = this.db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: string; p1: number; p2: number; p3: number }>;
    } catch {
      // Not compilable: executing it will raise the real syntax error for the caller.
      return [];
    }

    // Keyed by database *and* page. Each attached database numbers its own pages from one, so
    // `temp` page 2 and `main` page 2 are different tables; looking up a bare page number reported
    // a caller's own temp table as a write to whichever main table happened to share the number.
    const owners = new Map<string, string>();
    const addSchema = (dbIndex: number, source: string) => {
      try {
        const rows = this.db.prepare(
          `SELECT name, tbl_name, rootpage FROM ${source} WHERE rootpage IS NOT NULL AND rootpage > 0`
        ).all() as Array<{ name: string; tbl_name: string | null; rootpage: number }>;
        for (const row of rows) {
          owners.set(`${dbIndex}:${row.rootpage}`, String(row.tbl_name || row.name).toLowerCase());
        }
      } catch {
        // `temp` has no schema table until the connection creates its first temp object.
      }
    };
    addSchema(0, 'main.sqlite_master');
    addSchema(1, 'temp.sqlite_master');

    // Which operand carries the page and which the database differs per opcode, so each is read
    // from the field SQLite documents for it: OpenWrite P2/P3, Clear P1/P2, Destroy P1/P3.
    const written = new Set<string>();
    for (const op of program) {
      if (op.opcode === 'OpenWrite') written.add(`${Number(op.p3)}:${Number(op.p2)}`);
      else if (op.opcode === 'Clear') written.add(`${Number(op.p2)}:${Number(op.p1)}`);
      else if (op.opcode === 'Destroy') written.add(`${Number(op.p3)}:${Number(op.p1)}`);
    }

    // Resolved in whichever schema the write landed in, not just `main`. Skipping the other
    // schemas was the hole: `CREATE TABLE temp.edge_functions` builds a table an unqualified read
    // resolves to first, so the write was invisible here while the executor picked it up. A temp
    // table of the caller's own naming still resolves to a name that is not a system table, so it
    // stays allowed.
    const names: Array<{ table: string; temp: boolean }> = [];
    const seen = new Set<string>();
    for (const key of written) {
      const owner = owners.get(key);
      if (!owner || seen.has(owner)) continue;
      seen.add(owner);
      names.push({ table: owner, temp: !key.startsWith('0:') });
    }
    return names;
  }

  private validateNotSystemTable(sql: string): string | null {
    // A trigger body runs later, under whatever statement fires it, so its writes never appear in
    // the program compiled here. Nothing in the SQL editor needs one.
    if (RuntimeDatabase.TRIGGER_PATTERN.test(sql)) {
      return 'Cannot create triggers: a trigger body could write to a system table when it fires';
    }

    // An unqualified name resolves to `temp` before `main`, and the runtime connection is cached
    // across requests, so a temp object carrying a system table's name silently replaces what
    // every later read on that connection sees — including the edge-function executor's, which
    // looks up `edge_functions` and `secrets` unqualified.
    const create = sql.match(
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(TEMP\s+|TEMPORARY\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`\[]?(\w+)["'`\]]?\s*\.\s*)?["'`\[]?(\w+)["'`\]]?/i
    );
    if (create) {
      const [, keyword, schema, name] = create;
      // `CREATE TEMP TABLE x` and `CREATE TABLE temp.x` produce the same object, and an empty one
      // is already enough to hide the real rows from every unqualified read on this connection.
      const intoTemp = Boolean(keyword) || (schema ?? '').toLowerCase() === 'temp';
      if (intoTemp && RuntimeDatabase.SYSTEM_TABLES.includes(name.toLowerCase())) {
        return `Cannot shadow system table: ${name.toLowerCase()}`;
      }
    }

    // ALTER leaves no root-page trace of its target — it only rewrites the schema — so its name is
    // read directly, allowing for a schema prefix and any of SQLite's quoting styles.
    const alterMatch = sql.match(
      /^\s*(?:DROP|ALTER)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:["'`\[]?\w+["'`\]]?\s*\.\s*)?["'`\[]?(\w+)["'`\]]?/i
    );
    if (alterMatch) {
      const target = alterMatch[1].toLowerCase();
      if (RuntimeDatabase.SYSTEM_TABLES.includes(target)) {
        return `Cannot modify system table: ${target}`;
      }
    }

    for (const { table, temp } of this.writtenTables(sql)) {
      if (!RuntimeDatabase.SYSTEM_TABLES.includes(table)) continue;
      return temp
        ? `Cannot shadow system table: ${table}`
        : `Cannot write to system table: ${table}`;
    }

    return null;
  }

  getSchemaForExport(): string {
    const tables = this.getTableSchema();
    const userTables = tables.filter(t => !t.isSystemTable);

    if (userTables.length === 0) {
      return '-- No user tables defined\n-- Create tables using the SQL Editor or edge functions\n';
    }

    let sql = '-- Database Schema\n';
    sql += `-- ${userTables.length} user table(s)\n\n`;

    for (const table of userTables) {
      sql += `-- Table: ${table.name} (${table.rowCount} rows)\n`;
      sql += `CREATE TABLE ${table.name} (\n`;
      sql += table.columns.map(col => {
        let def = `  ${col.name} ${col.type}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        if (!col.nullable) def += ' NOT NULL';
        if (col.defaultValue !== undefined) def += ` DEFAULT ${col.defaultValue}`;
        return def;
      }).join(',\n');
      sql += '\n);\n\n';
    }

    return sql;
  }
}
