/**
 * SQLite Storage Adapter
 *
 * Implements StorageAdapter interface using SQLite via better-sqlite3.
 * This adapter handles the core database (osws.sqlite) for:
 * - Projects (metadata)
 * - Files and File Tree Nodes (synced project files)
 * - Deployments (publish settings and configuration)
 * - Custom Templates
 * - Skills
 *
 * Deployment-specific databases (deployments/{deploymentId}/deployment.sqlite) are ONLY created
 * when a deployment explicitly enables the "Database" feature for edge functions.
 * Analytics data is stored in these optional deployment databases.
 */

import { admitWorkspaceWrite } from '@/lib/api/storage-quota';
import path from 'path';
import { BLOB_ENCODING, putBlob, readBlob } from './blob-store';
import { logger } from '@/lib/utils';
import type { Database } from 'better-sqlite3';
import { StorageAdapter } from './types';
import { Project, VirtualFile, FileTreeNode, CustomTemplate, Deployment, EdgeFunction, ServerFunction, Secret, ScheduledFunction } from '../types';
import { normalizeProjectSettings } from '../project-settings';
import { Skill } from '../skills/types';
import type { ModelTemplate, ModelAssignment } from '@/lib/llm/models/assignment';
import type { CustomConnection } from '@/lib/llm/providers/connection-record';
import {
  getCoreDatabase,
  getDeploymentDatabase,
  closeDeploymentDatabase,
  deleteDeploymentDatabase,
  deleteProjectDatabase,
  listDeploymentIds,
  closeAllConnections,
  closeCoreDatabaseByPath,
} from './sqlite-connection';
import { DeploymentDatabase } from './deployment-database';
import { AnalyticsDatabase } from './analytics-database';
import { ProjectDatabase } from './project-database';
import type { AnalyticsConfig, ComplianceConfig, ReviewConfig, SeoConfig } from '../types';

// Default configs for Deployment
const DEFAULT_ANALYTICS: AnalyticsConfig = {
  enabled: false,
  provider: 'builtin',
  privacyMode: true,
};

const DEFAULT_COMPLIANCE: ComplianceConfig = {
  enabled: false,
  bannerPosition: 'bottom',
  bannerStyle: 'bar',
  message: 'This site uses cookies to improve your experience.', // i18n-ignore: default banner text for the site's visitors, editable in Compliance
  acceptButtonText: 'Accept', // i18n-ignore: default banner text for the site's visitors
  declineButtonText: 'Decline', // i18n-ignore: default banner text for the site's visitors
  mode: 'opt-in',
  blockAnalytics: true,
};

const DEFAULT_SEO: SeoConfig = {};

const DEFAULT_REVIEW: ReviewConfig = { enabled: false };

// Migration definitions
interface Migration {
  id: string;
  up: (db: Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    id: 'initial_schema_v1',
    up: (db) => {
      // Migration tracking
      db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Projects (metadata only)
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_saved_at TEXT,
          last_saved_checkpoint_id TEXT,
          settings TEXT DEFAULT '{}',
          cost_tracking TEXT DEFAULT '{}',
          preview_image TEXT,
          last_synced_at TEXT,
          server_updated_at TEXT
        )
      `);

      // Custom Templates
      db.exec(`
        CREATE TABLE IF NOT EXISTS custom_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          version TEXT,
          files TEXT DEFAULT '[]',
          directories TEXT DEFAULT '[]',
          assets TEXT DEFAULT '[]',
          metadata TEXT DEFAULT '{}',
          imported_at TEXT NOT NULL
        )
      `);

      // Skills
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          content TEXT NOT NULL,
          markdown TEXT NOT NULL,
          is_built_in INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      // Index for skills
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skills_is_built_in ON skills(is_built_in)
      `);
    }
  },
  {
    id: 'add_files_and_tree_v2',
    up: (db) => {
      // Files - synced project files stored in core database
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('html', 'css', 'js', 'json', 'text', 'template', 'image', 'video', 'binary')),
          content TEXT,
          mime_type TEXT,
          size INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT DEFAULT '{}',
          UNIQUE(project_id, path),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Index for efficient file lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id)
      `);

      // File tree nodes - hierarchical structure for file explorer
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_tree_nodes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('file', 'directory')),
          parent_path TEXT,
          is_expanded INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}',
          UNIQUE(project_id, path),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Index for efficient tree lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_project_id ON file_tree_nodes(project_id)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent ON file_tree_nodes(project_id, parent_path)
      `);

      // Sites table - deployment settings and publishing info (renamed to deployments in v4 migration)
      db.exec(`
        CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          slug TEXT,
          -- Vestigial: nothing reads or writes this. A deployment is live when its built files
          -- exist, so publish/unpublish replaced the flag. Left in place because dropping it
          -- also means dropping site_info.enabled from every deployment's runtime.sqlite, which
          -- has no migration tracking yet. See TODO.md.
          enabled INTEGER DEFAULT 1,
          under_construction INTEGER DEFAULT 0,
          custom_domain TEXT,
          head_scripts TEXT DEFAULT '[]',
          body_scripts TEXT DEFAULT '[]',
          cdn_links TEXT DEFAULT '[]',
          analytics TEXT DEFAULT '{}',
          seo TEXT DEFAULT '{}',
          compliance TEXT DEFAULT '{}',
          settings_version INTEGER DEFAULT 1,
          last_published_version INTEGER,
          preview_image TEXT,
          preview_updated_at TEXT,
          database_enabled INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          published_at TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Index for deployment lookups (renamed in v4 migration)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sites_project_id ON sites(project_id)
      `);
    }
  },
  {
    id: 'add_request_log_v3',
    up: (db) => {
      // Request log for tracking deployment traffic (server-level analytics)
      db.exec(`
        CREATE TABLE IF NOT EXISTS request_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id TEXT NOT NULL,
          path TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          ip_hash TEXT,
          user_agent TEXT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);

      // Indexes for efficient querying
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_request_log_timestamp ON request_log(timestamp)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_request_log_site_id ON request_log(site_id)
      `);
    }
  },
  {
    id: 'rename_sites_to_deployments_v4',
    up: (db) => {
      // Rename sites table to deployments
      // NOTE: request_log.site_id was intentionally NOT renamed to deployment_id because
      // SQLite ALTER TABLE does not support column renames without full table recreation.
      // The column is correctly aliased as `deploymentId` in TypeScript queries (see request-logger.ts).
      db.exec(`ALTER TABLE sites RENAME TO deployments`);

      // Drop old index and create new one with updated name
      db.exec(`DROP INDEX IF EXISTS idx_sites_project_id`);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id)
      `);
    }
  },
  {
    id: 'add_project_server_features_v5',
    up: (db) => {
      // Project-scoped edge functions
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_edge_functions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          code TEXT NOT NULL,
          method TEXT NOT NULL DEFAULT 'GET' CHECK(method IN ('GET', 'POST', 'PUT', 'DELETE', 'ANY')),
          enabled INTEGER DEFAULT 1,
          timeout_ms INTEGER DEFAULT 5000,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, name),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_edge_functions_project_id ON project_edge_functions(project_id)`);

      // Project-scoped server functions
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_server_functions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          code TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, name),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_server_functions_project_id ON project_server_functions(project_id)`);

      // Project-scoped secrets
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_secrets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          has_value INTEGER DEFAULT 0,
          value TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, name),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_secrets_project_id ON project_secrets(project_id)`);

      // Project-scoped scheduled functions
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_scheduled_functions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          function_id TEXT NOT NULL,
          cron_expression TEXT NOT NULL,
          timezone TEXT DEFAULT 'UTC',
          config TEXT DEFAULT '{}',
          enabled INTEGER DEFAULT 1,
          last_run_at TEXT,
          next_run_at TEXT,
          last_status TEXT,
          last_error TEXT,
          last_duration_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, name),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_project_scheduled_functions_project_id ON project_scheduled_functions(project_id)`);
    }
  },
  {
    id: 'add_model_templates_v6',
    up: (db) => {
      // User model templates synced from the client (assignment stored as JSON).
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          assignment TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        )
      `);
    }
  },
  {
    id: 'add_custom_template_updated_at_v7',
    up: (db) => {
      // custom_templates predates template sync and never had an updated_at column,
      // but listTemplateSummaries (used by the sync-status endpoint) selects
      // COALESCE(updated_at, imported_at). Without the column that query throws
      // "no such column: updated_at" on every existing database. Add it; the guard
      // keeps the migration safe if a database already has the column.
      const cols = db.prepare(`PRAGMA table_info(custom_templates)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'updated_at')) {
        db.exec(`ALTER TABLE custom_templates ADD COLUMN updated_at TEXT`);
      }
    }
  },
  {
    id: 'add_connections_v8',
    up: (db) => {
      // User-defined custom provider definitions synced from the client.
      // Never stores API keys — those remain client-side only.
      db.exec(`
        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'openai',
          api_key_required INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        )
      `);
    }
  },
  {
    id: 'add_interview_templates_v9',
    up: (db) => {
      // User interview templates synced from the client. items/artifacts/handoff
      // stored together as a JSON spec blob (server never queries inside a template).
      db.exec(`
        CREATE TABLE IF NOT EXISTS interview_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          spec TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        )
      `);
    }
  },
  {
    id: 'add_file_encoding_v10',
    up: (db) => {
      // Records HOW a file's content was stored, so reading it back does not have to guess from
      // the extension. Writes were already content-driven (an ArrayBuffer became base64) while
      // reads only decoded 'image' and 'video', so audio, fonts, PDFs and anything else came back
      // as a base64 string instead of bytes.
      //
      // The type CHECK constraint is dropped in the same pass: it hardcoded the file-type list
      // into the schema, so adding a category meant a migration. Valid types are the app's concern.
      // SQLite cannot alter a CHECK in place, hence the table rebuild.
      db.exec(`
        CREATE TABLE IF NOT EXISTS files_v10 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT,
          encoding TEXT,
          mime_type TEXT,
          size INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          metadata TEXT DEFAULT '{}',
          UNIQUE(project_id, path),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);

      // Existing image/video rows are base64 — label them so the legacy type test is no longer
      // needed for anything written from here on.
      db.exec(`
        INSERT INTO files_v10 (
          id, project_id, path, name, type, content, encoding,
          mime_type, size, created_at, updated_at, metadata
        )
        SELECT
          id, project_id, path, name, type, content,
          CASE WHEN type IN ('image', 'video') AND content IS NOT NULL AND content != ''
               THEN 'base64' ELSE NULL END,
          mime_type, size, created_at, updated_at, metadata
        FROM files
      `);

      db.exec(`DROP TABLE files`);
      db.exec(`ALTER TABLE files_v10 RENAME TO files`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id)`);
    }
  },
  {
    id: 'add_deployment_review_v11',
    up: (db) => {
      // Review mode is a settings group like analytics/seo/compliance and is stored the same way:
      // one column holding its JSON. It cannot be folded into the initial schema — installs that
      // already ran that migration never re-run it, so the column would exist only on new
      // databases.
      //
      // The PRAGMA check makes the ALTER safe to reach twice, and safe on a database with no
      // deployments table at all: either way the statement would throw inside the migration
      // transaction, which fails init and takes the whole adapter down with it.
      const cols = db.prepare(`PRAGMA table_info(deployments)`).all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === 'review')) {
        db.exec(`ALTER TABLE deployments ADD COLUMN review TEXT DEFAULT '{}'`);
      }
    }
  },
  {
    id: 'add_project_revision_v12',
    up: (db) => {
      const cols = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some((c) => c.name === 'revision')) {
        db.exec(`ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
      }
    }
  },
  {
    id: 'deployments_outlive_projects_v13',
    up: (db) => {
      // A deployment row was declared `ON DELETE CASCADE` against its project, so deleting the
      // project deleted the row while the built site stayed live and routed: a published site with
      // nothing in the Deployments view to republish, repoint or unpublish it. SQLite cannot drop a
      // constraint, so the table is rebuilt from its own current definition (every column added
      // since included) with the foreign key left out. Nothing references `deployments`.
      const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deployments'`)
        .get() as { sql: string } | undefined;
      if (!table) return;
      const withoutCascade = table.sql.replace(
        /,\s*FOREIGN KEY\s*\(\s*project_id\s*\)\s*REFERENCES\s+projects\s*\(\s*id\s*\)[^,)]*/i,
        ''
      );
      if (withoutCascade === table.sql) return;
      const indexes = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deployments' AND sql IS NOT NULL`
      ).all() as Array<{ sql: string }>;
      db.exec(withoutCascade.replace(/^CREATE TABLE\s+("?)deployments\1/i, 'CREATE TABLE deployments_v13'));
      db.exec(`INSERT INTO deployments_v13 SELECT * FROM deployments`);
      db.exec(`DROP TABLE deployments`);
      db.exec(`ALTER TABLE deployments_v13 RENAME TO deployments`);
      for (const index of indexes) db.exec(index.sql);
    }
  },
];

/**
 * Helper to parse JSON safely with a fallback
 */
/**
 * Encode file content for storage, recording how it was encoded.
 *
 * Driven by the content itself, never by the file's extension: the extension is a guess, and it was
 * wrong for every binary type outside the image/video list. The returned encoding is stored
 * alongside the content so reading back needs no guess either.
 */
function encodeFileContent(raw: unknown, baseDir?: string): { content: string; encoding: string | null } {
  // Tag check rather than instanceof: content can arrive as a structured clone from another realm.
  if (Object.prototype.toString.call(raw) === '[object ArrayBuffer]') {
    const bytes = Buffer.from(raw as ArrayBuffer);
    // Bytes go to the blob store, and the row keeps the hash. Without a base directory there is
    // nowhere to put them, so base64 stays the fallback: that is the in-memory database the tests
    // and the default core connection use.
    if (baseDir) {
      return { content: putBlob(baseDir, bytes), encoding: BLOB_ENCODING };
    }
    return { content: bytes.toString('base64'), encoding: 'base64' };
  }
  if (typeof raw === 'string') {
    return { content: raw, encoding: null };
  }
  return { content: '', encoding: null };
}

/**
 * The bytes a file's content occupies, taken from the content itself.
 *
 * Not the length of what `encodeFileContent` returns: binary content goes to the blob store and the
 * row keeps a hash, so the encoded string is about sixty characters whatever the file's size. The
 * quota read that string and charged a 10MB image as sixty bytes.
 */
function contentByteLength(raw: unknown): number {
  if (Object.prototype.toString.call(raw) === '[object ArrayBuffer]') return (raw as ArrayBuffer).byteLength;
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  return 0;
}

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
 * Helper to ensure a value is a Date and convert to ISO string
 * Handles both Date objects and ISO strings (from JSON deserialization)
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
 * SQLite Storage Adapter Implementation
 */
export class SQLiteAdapter implements StorageAdapter {
  private db: Database | null = null;
  private initialized = false;
  private deploymentDatabases = new Map<string, DeploymentDatabase>();
  private analyticsDatabases = new Map<string, AnalyticsDatabase>();
  private projectDatabases = new Map<string, ProjectDatabase>();
  private dbPath: string | undefined;
  private baseDir: string | undefined;
  /**
   * Set only for a per-workspace database, which is what carries a storage limit. The shared
   * database behind the legacy `admin`, `desktop` and `instance-api` ids has no workspace row, so
   * it is left unset and the quota gate stands aside.
   */
  private workspaceId: string | undefined;

  constructor(dbPath?: string, workspaceId?: string) {
    this.dbPath = dbPath;
    this.workspaceId = workspaceId;
    if (dbPath) {
      this.baseDir = path.dirname(dbPath);
    }
  }

  /**
   * Initialize the adapter - sets up database and runs migrations.
   * Also recovers if the underlying connection was externally closed.
   */
  async init(): Promise<void> {
    if (this.initialized && this.db?.open) return;

    this.db = getCoreDatabase(this.dbPath);
    await this.runMigrations();
    this.initialized = true;
  }

  /**
   * Close this adapter's connections only (does not affect other workspaces)
   */
  async close(): Promise<void> {
    // Close all deployment databases
    for (const [, deploymentDb] of this.deploymentDatabases) {
      deploymentDb.close();
    }
    this.deploymentDatabases.clear();

    // Close all analytics databases
    for (const [, analyticsDb] of this.analyticsDatabases) {
      analyticsDb.close();
    }
    this.analyticsDatabases.clear();

    // Close all project databases
    for (const [, projectDb] of this.projectDatabases) {
      projectDb.close();
    }
    this.projectDatabases.clear();

    // Close only this adapter's core database (scoped by path)
    if (this.dbPath) {
      closeCoreDatabaseByPath(this.dbPath);
    } else {
      closeAllConnections();
    }
    this.db = null;
    this.initialized = false;
  }

  /**
   * Get or create a ProjectDatabase instance for a project
   */
  /** Where this adapter keeps project databases: its workspace's directory, or the shared data directory. */
  getProjectDatabaseBaseDir(): string | undefined {
    return this.baseDir;
  }

  getProjectDatabase(projectId: string): ProjectDatabase {
    let projectDb = this.projectDatabases.get(projectId);
    if (!projectDb) {
      projectDb = new ProjectDatabase(projectId, this.baseDir);
      projectDb.init();
      this.projectDatabases.set(projectId, projectDb);
    }
    return projectDb;
  }

  /**
   * Get the core database, ensuring it's initialized
   */
  getBaseDir(): string | undefined {
    return this.baseDir;
  }

  /**
   * Every blob hash a file row still refers to, across all projects in this workspace.
   *
   * The blob sweep deletes what this does not name, so it has to be the complete set. Only file
   * rows can hold a hash: templates keep their files as JSON in their own column, and nothing else
   * goes through `encodeFileContent`.
   */
  async listReferencedBlobHashes(): Promise<string[]> {
    const rows = this.getDB()
      .prepare(`SELECT DISTINCT content FROM files WHERE encoding = ? AND content IS NOT NULL`)
      .all(BLOB_ENCODING) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  }

  private getDB(): Database {
    if (!this.db || !this.db.open) {
      if (this.initialized) {
        this.db = getCoreDatabase(this.dbPath);
      } else {
        throw new Error('SQLiteAdapter not initialized. Call init() first.');
      }
    }
    return this.db;
  }

  /**
   * Get the underlying better-sqlite3 database for advanced operations
   * (e.g., wrapping multiple operations in a transaction).
   * Prefer using adapter methods when possible.
   */
  getCoreDB(): Database {
    return this.getDB();
  }

  /**
   * Get or create a DeploymentDatabase instance for a deployment with database enabled
   * This only creates the database when explicitly requested for analytics
   */
  private getOrCreateDeploymentDB(deploymentId: string): DeploymentDatabase {
    let deploymentDb = this.deploymentDatabases.get(deploymentId);
    if (!deploymentDb) {
      deploymentDb = new DeploymentDatabase(deploymentId);
      deploymentDb.init();
      this.deploymentDatabases.set(deploymentId, deploymentDb);
    }
    return deploymentDb;
  }

  // ============================================
  // Edge Functions (Project-scoped)
  // ============================================

  async createEdgeFunction(fn: EdgeFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO project_edge_functions (id, project_id, name, description, code, method, enabled, timeout_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fn.id, fn.projectId, fn.name, fn.description || null, fn.code, fn.method, fn.enabled ? 1 : 0, fn.timeoutMs, toISOStringRequired(fn.createdAt), toISOStringRequired(fn.updatedAt));
  }

  async getEdgeFunction(id: string): Promise<EdgeFunction | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM project_edge_functions WHERE id = ?').get(id) as any;
    return row ? this.rowToEdgeFunction(row) : null;
  }

  async listEdgeFunctions(projectId: string): Promise<EdgeFunction[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM project_edge_functions WHERE project_id = ? ORDER BY name').all(projectId) as any[];
    return rows.map((row) => this.rowToEdgeFunction(row));
  }

  async updateEdgeFunction(fn: EdgeFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE project_edge_functions SET name = ?, description = ?, code = ?, method = ?, enabled = ?, timeout_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(fn.name, fn.description || null, fn.code, fn.method, fn.enabled ? 1 : 0, fn.timeoutMs, toISOStringRequired(fn.updatedAt), fn.id);
  }

  async deleteEdgeFunction(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM project_edge_functions WHERE id = ?').run(id);
  }

  private rowToEdgeFunction(row: any): EdgeFunction {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description || undefined,
      code: row.code,
      method: row.method as EdgeFunction['method'],
      enabled: row.enabled === 1,
      timeoutMs: row.timeout_ms,
      createdAt: parseDate(row.created_at),
      updatedAt: parseDate(row.updated_at),
    };
  }

  // ============================================
  // Server Functions (Project-scoped)
  // ============================================

  async createServerFunction(fn: ServerFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO project_server_functions (id, project_id, name, description, code, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fn.id, fn.projectId, fn.name, fn.description || null, fn.code, fn.enabled ? 1 : 0, toISOStringRequired(fn.createdAt), toISOStringRequired(fn.updatedAt));
  }

  async getServerFunction(id: string): Promise<ServerFunction | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM project_server_functions WHERE id = ?').get(id) as any;
    return row ? this.rowToServerFunction(row) : null;
  }

  async listServerFunctions(projectId: string): Promise<ServerFunction[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM project_server_functions WHERE project_id = ? ORDER BY name').all(projectId) as any[];
    return rows.map((row) => this.rowToServerFunction(row));
  }

  async updateServerFunction(fn: ServerFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE project_server_functions SET name = ?, description = ?, code = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(fn.name, fn.description || null, fn.code, fn.enabled ? 1 : 0, toISOStringRequired(fn.updatedAt), fn.id);
  }

  async deleteServerFunction(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM project_server_functions WHERE id = ?').run(id);
  }

  private rowToServerFunction(row: any): ServerFunction {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description || undefined,
      code: row.code,
      enabled: row.enabled === 1,
      createdAt: parseDate(row.created_at),
      updatedAt: parseDate(row.updated_at),
    };
  }

  // ============================================
  // Secrets (Project-scoped)
  // ============================================

  async createSecret(secret: Secret): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO project_secrets (id, project_id, name, description, has_value, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(secret.id, secret.projectId, secret.name, secret.description || null, secret.hasValue ? 1 : 0, secret.value || null, toISOStringRequired(secret.createdAt), toISOStringRequired(secret.updatedAt));
  }

  async getSecret(id: string): Promise<Secret | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM project_secrets WHERE id = ?').get(id) as any;
    return row ? this.rowToSecret(row) : null;
  }

  async listSecrets(projectId: string): Promise<Secret[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM project_secrets WHERE project_id = ? ORDER BY name').all(projectId) as any[];
    return rows.map((row) => this.rowToSecret(row));
  }

  async updateSecret(secret: Secret): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE project_secrets SET name = ?, description = ?, has_value = ?, value = ?, updated_at = ?
      WHERE id = ?
    `).run(secret.name, secret.description || null, secret.hasValue ? 1 : 0, secret.value || null, toISOStringRequired(secret.updatedAt), secret.id);
  }

  async deleteSecret(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM project_secrets WHERE id = ?').run(id);
  }

  private rowToSecret(row: any): Secret {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description || undefined,
      hasValue: row.has_value === 1,
      value: row.value || undefined,
      createdAt: parseDate(row.created_at),
      updatedAt: parseDate(row.updated_at),
    };
  }

  // ============================================
  // Scheduled Functions (Project-scoped)
  // ============================================

  async createScheduledFunction(fn: ScheduledFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO project_scheduled_functions (id, project_id, name, description, function_id, cron_expression, timezone, config, enabled, last_run_at, next_run_at, last_status, last_error, last_duration_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fn.id, fn.projectId, fn.name, fn.description || null, fn.functionId, fn.cronExpression, fn.timezone, JSON.stringify(fn.config), fn.enabled ? 1 : 0, toISOString(fn.lastRunAt ?? null), toISOString(fn.nextRunAt ?? null), fn.lastStatus || null, fn.lastError || null, fn.lastDurationMs ?? null, toISOStringRequired(fn.createdAt), toISOStringRequired(fn.updatedAt));
  }

  async getScheduledFunction(id: string): Promise<ScheduledFunction | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM project_scheduled_functions WHERE id = ?').get(id) as any;
    return row ? this.rowToScheduledFunction(row) : null;
  }

  async listScheduledFunctions(projectId: string): Promise<ScheduledFunction[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM project_scheduled_functions WHERE project_id = ? ORDER BY name').all(projectId) as any[];
    return rows.map((row) => this.rowToScheduledFunction(row));
  }

  async updateScheduledFunction(fn: ScheduledFunction): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE project_scheduled_functions SET name = ?, description = ?, function_id = ?, cron_expression = ?, timezone = ?, config = ?, enabled = ?, last_run_at = ?, next_run_at = ?, last_status = ?, last_error = ?, last_duration_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(fn.name, fn.description || null, fn.functionId, fn.cronExpression, fn.timezone, JSON.stringify(fn.config), fn.enabled ? 1 : 0, toISOString(fn.lastRunAt ?? null), toISOString(fn.nextRunAt ?? null), fn.lastStatus || null, fn.lastError || null, fn.lastDurationMs ?? null, toISOStringRequired(fn.updatedAt), fn.id);
  }

  async deleteScheduledFunction(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM project_scheduled_functions WHERE id = ?').run(id);
  }

  private rowToScheduledFunction(row: any): ScheduledFunction {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      description: row.description || undefined,
      functionId: row.function_id,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
      config: parseJSON(row.config, {}),
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ? parseDate(row.last_run_at) : undefined,
      nextRunAt: row.next_run_at ? parseDate(row.next_run_at) : undefined,
      lastStatus: row.last_status || undefined,
      lastError: row.last_error || undefined,
      lastDurationMs: row.last_duration_ms ?? undefined,
      createdAt: parseDate(row.created_at),
      updatedAt: parseDate(row.updated_at),
    };
  }

  /**
   * Enable database for a deployment (creates the deployment.sqlite file)
   * Called when user enables "Database" feature in deployment settings
   */
  async enableDeploymentDatabase(deploymentId: string): Promise<void> {
    const db = this.getDB();

    // Update the deployment record
    db.prepare('UPDATE deployments SET database_enabled = 1 WHERE id = ?').run(deploymentId);

    // Create the deployment database
    this.getOrCreateDeploymentDB(deploymentId);
  }

  /**
   * Disable database for a deployment (deletes the deployment.sqlite file)
   */
  async disableDeploymentDatabase(deploymentId: string): Promise<void> {
    const db = this.getDB();

    // Update the deployment record
    db.prepare('UPDATE deployments SET database_enabled = 0 WHERE id = ?').run(deploymentId);

    // Close and delete the deployment database
    const deploymentDb = this.deploymentDatabases.get(deploymentId);
    if (deploymentDb) {
      deploymentDb.close();
      this.deploymentDatabases.delete(deploymentId);
    }

    deleteDeploymentDatabase(deploymentId);
  }

  /**
   * Run pending migrations
   */
  private async runMigrations(): Promise<void> {
    const db = this.getDB();

    // Create migrations table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Get applied migrations
    const rows = db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>;
    const applied = new Set(rows.map((row) => row.id));

    // Run pending migrations in a transaction
    const runMigration = db.transaction((migration: Migration) => {
      if (!applied.has(migration.id)) {
        migration.up(db);
        db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(migration.id);
      }
    });

    for (const migration of MIGRATIONS) {
      runMigration(migration);
    }
  }

  // ============================================
  // Projects
  // ============================================

  async createProject(project: Project): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      INSERT INTO projects (
        id, name, description, created_at, updated_at,
        last_saved_at, last_saved_checkpoint_id, settings,
        cost_tracking, preview_image, last_synced_at, server_updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      project.id,
      project.name,
      project.description ?? null,
      toISOStringRequired(project.createdAt),
      toISOStringRequired(project.updatedAt),
      toISOString(project.lastSavedAt),
      project.lastSavedCheckpointId ?? null,
      // Normalized first: a push body can carry settings that are already a JSON string, and
      // stringifying that again is what stacked the encoding layers one round trip at a time.
      JSON.stringify(normalizeProjectSettings(project.settings)),
      JSON.stringify(project.costTracking ?? {}),
      project.previewImage ?? null,
      toISOString(project.lastSyncedAt),
      toISOString(project.serverUpdatedAt),
      project.revision ?? 0
    );
  }

  getProjectSync(id: string): Project | null {
    const row = this.getDB().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : null;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.getProjectSync(id);
  }

  async updateProject(project: Project): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      UPDATE projects SET
        name = ?,
        description = ?,
        updated_at = ?,
        last_saved_at = ?,
        last_saved_checkpoint_id = ?,
        settings = ?,
        cost_tracking = ?,
        preview_image = ?,
        last_synced_at = ?,
        server_updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      project.name,
      project.description ?? null,
      toISOStringRequired(project.updatedAt),
      toISOString(project.lastSavedAt),
      project.lastSavedCheckpointId ?? null,
      // Normalized first: a push body can carry settings that are already a JSON string, and
      // stringifying that again is what stacked the encoding layers one round trip at a time.
      JSON.stringify(normalizeProjectSettings(project.settings)),
      JSON.stringify(project.costTracking ?? {}),
      project.previewImage ?? null,
      toISOString(project.lastSyncedAt),
      toISOString(project.serverUpdatedAt),
      project.id
    );
  }

  async deleteProject(id: string): Promise<void> {
    const db = this.getDB();

    // Delete from core database. Deployments are not touched: a deployment outlives its project,
    // and its databases go when the deployment is deleted.
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);

    // Delete project database if it exists
    this.projectDatabases.delete(id);
    deleteProjectDatabase(id, this.baseDir);
  }

  async listProjects(fields?: string[]): Promise<Project[]> {
    const db = this.getDB();

    // If specific fields requested, build a selective query
    // For now, always return full projects (field filtering can be added later)
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Record<string, unknown>[];

    return rows.map(row => this.rowToProject(row));
  }

  /**
   * Projects without their thumbnails.
   *
   * `preview_image` holds a base64 screenshot per project and dwarfs everything else in the row:
   * on a real workspace, 2.0MB of thumbnails against 8.4KB of metadata across 237 projects. Any
   * caller that only wants to name and order projects should come here rather than to
   * `listProjects`, which selects every column.
   *
   * `runtime` is resolved through the same normalisation `rowToProject` uses, so a settings blob
   * that arrived double-stringified from a client reads the same either way.
   */
  listProjectSummaries(): Array<{ id: string; name: string; updatedAt: string; runtime?: string }> {
    const db = this.getDB();
    const rows = db.prepare(
      'SELECT id, name, updated_at as updatedAt, settings FROM projects ORDER BY updated_at DESC'
    ).all() as Array<{ id: string; name: string; updatedAt: string; settings: unknown }>;
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updatedAt,
      runtime: normalizeProjectSettings(row.settings)?.runtime,
    }));
  }

  listSkillSummaries(): Array<{ id: string; name: string; updatedAt: string }> {
    const db = this.getDB();
    return db.prepare("SELECT id, name, updated_at as updatedAt FROM skills WHERE is_built_in = 0").all() as Array<{ id: string; name: string; updatedAt: string }>;
  }

  listTemplateSummaries(): Array<{ id: string; name: string; updatedAt: string }> {
    const db = this.getDB();
    return db.prepare('SELECT id, name, COALESCE(updated_at, imported_at) as updatedAt FROM custom_templates').all() as Array<{ id: string; name: string; updatedAt: string }>;
  }

  countDeployments(): number {
    const db = this.getDB();
    const row = db.prepare('SELECT COUNT(*) as c FROM deployments').get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * Convert a database row to a Project object
   */
  private rowToProject(row: Record<string, unknown>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
      lastSavedAt: row.last_saved_at ? parseDate(row.last_saved_at as string) : undefined,
      lastSavedCheckpointId: row.last_saved_checkpoint_id as string | undefined,
      // normalizeProjectSettings rather than parseJSON: the column is TEXT, so one layer is
      // expected, but a row pushed from a client whose settings had already been stringified
      // carries more than one. See lib/vfs/project-settings.ts.
      settings: normalizeProjectSettings(row.settings),
      costTracking: parseJSON(row.cost_tracking as string, undefined),
      previewImage: row.preview_image as string | undefined,
      lastSyncedAt: row.last_synced_at ? parseDate(row.last_synced_at as string) : undefined,
      serverUpdatedAt: row.server_updated_at ? parseDate(row.server_updated_at as string) : undefined,
      revision: typeof row.revision === 'number' ? row.revision : Number(row.revision ?? 0) || 0,
    };
  }

  /**
   * Advance revision only if the caller still holds `expected`. Returns the new
   * revision, or null if the row is gone or the expected base no longer matches.
   */
  bumpRevision(projectId: string, expected: number): number | null {
    const db = this.getDB();
    const result = db.prepare(
      'UPDATE projects SET revision = revision + 1 WHERE id = ? AND revision = ?'
    ).run(projectId, expected);
    if (result.changes !== 1) return null;
    const row = db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId) as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  /** Same-connection transaction. Callbacks must not await. */
  runTransaction<T>(fn: () => T): T {
    return this.getDB().transaction(fn)();
  }

  // ============================================
  // Files (stored in core database)
  // ============================================

  /**
   * Admits a file write against the workspace's storage limit.
   *
   * Here rather than in the routes because every writer reaches this method: the sync routes,
   * server-mode generation, `bash/execute` and the MCP connector all write through this adapter.
   * Called before the content is encoded, because encoding a binary file writes its bytes to the
   * blob store, and a write that is about to be refused should not put them there.
   */
  private admitWrite(byteLength: number): void {
    if (!this.workspaceId) return;
    const workspaceId = this.workspaceId;
    admitWorkspaceWrite(workspaceId, byteLength, () => this.listDeploymentIdsSync());
  }

  /**
   * This workspace's deployment ids.
   *
   * This adapter's database is the workspace's own, so its `deployments` table is already scoped to
   * it. The instance-wide `listDeploymentIds` would measure every workspace's output instead.
   */
  listDeploymentIdsSync(): string[] {
    try {
      const rows = this.getDB().prepare('SELECT id FROM deployments').all() as Array<{ id: string }>;
      return rows.map(r => r.id);
    } catch {
      return [];
    }
  }

  /**
   * Bytes this project's files occupy, from the stored `size` column.
   *
   * Summed in SQL rather than by loading the files, because the publish path asks for this before
   * a build and a project's content can run to megabytes.
   */
  projectContentBytes(projectId: string): number {
    try {
      const row = this.getDB()
        .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE project_id = ?')
        .get(projectId) as { total: number } | undefined;
      return row?.total ?? 0;
    } catch {
      return 0;
    }
  }

  async createFile(file: VirtualFile): Promise<void> {
    const db = this.getDB();

    // Handle ArrayBuffer content (binary files)
    // Also handle {} from JSON-serialized ArrayBuffer (becomes empty object during sync)
    this.admitWrite(contentByteLength(file.content));
    const { content, encoding } = encodeFileContent(file.content, this.baseDir);

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO files (
        id, project_id, path, name, type, content, encoding,
        mime_type, size, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      file.id,
      file.projectId,
      file.path,
      file.name,
      file.type,
      content,
      encoding,
      file.mimeType ?? null,
      file.size ?? 0,
      toISOStringRequired(file.createdAt),
      toISOStringRequired(file.updatedAt),
      JSON.stringify(file.metadata ?? {})
    );
  }

  getFileSync(projectId: string, path: string): VirtualFile | null {
    const row = this.getDB().prepare(
      'SELECT * FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, path) as Record<string, unknown> | undefined;
    return row ? this.rowToFile(row, projectId) : null;
  }

  async getFile(projectId: string, path: string): Promise<VirtualFile | null> {
    return this.getFileSync(projectId, path);
  }

  async updateFile(file: VirtualFile): Promise<void> {
    const db = this.getDB();

    // Handle ArrayBuffer content
    // Also handle {} from JSON-serialized ArrayBuffer (becomes empty object during sync)
    this.admitWrite(contentByteLength(file.content));
    const { content, encoding } = encodeFileContent(file.content, this.baseDir);

    const stmt = db.prepare(`
      UPDATE files SET
        name = ?, type = ?, content = ?, encoding = ?, mime_type = ?,
        size = ?, updated_at = ?, metadata = ?
      WHERE project_id = ? AND path = ?
    `);

    stmt.run(
      file.name,
      file.type,
      content,
      encoding,
      file.mimeType ?? null,
      file.size ?? 0,
      toISOStringRequired(file.updatedAt),
      JSON.stringify(file.metadata ?? {}),
      file.projectId,
      file.path
    );
  }

  async deleteFile(projectId: string, path: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(projectId, path);
  }

  listFilesSync(projectId: string): VirtualFile[] {
    const rows = this.getDB().prepare(
      'SELECT * FROM files WHERE project_id = ? ORDER BY path'
    ).all(projectId) as Record<string, unknown>[];
    return rows.map(row => this.rowToFile(row, projectId));
  }

  async listFiles(projectId: string): Promise<VirtualFile[]> {
    return this.listFilesSync(projectId);
  }

  async deleteProjectFiles(projectId: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
  }

  private rowToFile(row: Record<string, unknown>, projectId: string): VirtualFile {
    const type = row.type as VirtualFile['type'];
    const rawContent = row.content as string;

    // Decode based on how the content was STORED. The file's type is not consulted: guessing from
    // the extension is what lost audio, fonts and PDFs. Rows predating the encoding column were
    // labelled by the add_file_encoding_v10 migration, so there is nothing left to guess about.
    let content: string | ArrayBuffer = rawContent;
    if (row.encoding === BLOB_ENCODING && rawContent) {
      // Branching on the encoding alone, never on whether a store happens to be configured: a row
      // that says 'blob' holds a hash, and handing that back as the file's content would put a
      // 64-character string where an image belongs. Empty bytes are wrong too, but visibly so.
      const bytes = this.baseDir ? readBlob(this.baseDir, rawContent) : null;
      if (bytes) {
        content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      } else {
        logger.error(
          `[SQLiteAdapter] Missing blob for ${row.path as string} (${rawContent}). The file reads ` +
          (this.baseDir
            ? 'as empty; its content is not in the blob store, which a workspace restored without its blobs/ directory would explain.'
            : 'as empty; this database was opened without the directory its blob store lives in.')
        );
        content = new ArrayBuffer(0);
      }
    } else if (row.encoding === 'base64' && rawContent) {
      try {
        // Strip data URL prefix if present (e.g., "data:image/jpeg;base64,")
        let base64Data = rawContent;
        if (rawContent.startsWith('data:')) {
          const commaIndex = rawContent.indexOf(',');
          if (commaIndex !== -1) {
            base64Data = rawContent.slice(commaIndex + 1);
          }
        }
        const buffer = Buffer.from(base64Data, 'base64');
        content = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // If conversion fails, keep as string
        content = rawContent;
      }
    }

    return {
      id: row.id as string,
      projectId,
      path: row.path as string,
      name: row.name as string,
      type,
      content,
      mimeType: row.mime_type as string,
      size: row.size as number,
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
      metadata: parseJSON(row.metadata as string, {}),
    };
  }

  // ============================================
  // File Tree (stored in core database)
  // ============================================

  async createTreeNode(node: FileTreeNode): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      INSERT INTO file_tree_nodes (
        id, project_id, path, name, type, parent_path, is_expanded, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      node.id,
      node.projectId,
      node.path,
      node.name,
      node.type,
      node.parentPath ?? null,
      node.isExpanded ? 1 : 0,
      JSON.stringify(node.metadata ?? {})
    );
  }

  async getTreeNode(projectId: string, path: string): Promise<FileTreeNode | null> {
    const db = this.getDB();
    const row = db.prepare(
      'SELECT * FROM file_tree_nodes WHERE project_id = ? AND path = ?'
    ).get(projectId, path) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToTreeNode(row, projectId);
  }

  async updateTreeNode(node: FileTreeNode): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      UPDATE file_tree_nodes SET
        name = ?, type = ?, parent_path = ?, is_expanded = ?, metadata = ?
      WHERE project_id = ? AND path = ?
    `);

    stmt.run(
      node.name,
      node.type,
      node.parentPath ?? null,
      node.isExpanded ? 1 : 0,
      JSON.stringify(node.metadata ?? {}),
      node.projectId,
      node.path
    );
  }

  async deleteTreeNode(projectId: string, path: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM file_tree_nodes WHERE project_id = ? AND path = ?').run(projectId, path);
  }

  async getChildNodes(projectId: string, parentPath: string | null): Promise<FileTreeNode[]> {
    const db = this.getDB();
    let rows: Record<string, unknown>[];

    if (parentPath === null) {
      rows = db.prepare(
        'SELECT * FROM file_tree_nodes WHERE project_id = ? AND parent_path IS NULL ORDER BY type DESC, name'
      ).all(projectId) as Record<string, unknown>[];
    } else {
      rows = db.prepare(
        'SELECT * FROM file_tree_nodes WHERE project_id = ? AND parent_path = ? ORDER BY type DESC, name'
      ).all(projectId, parentPath) as Record<string, unknown>[];
    }

    return rows.map(row => this.rowToTreeNode(row, projectId));
  }

  async getAllTreeNodes(projectId: string): Promise<FileTreeNode[]> {
    const db = this.getDB();
    const rows = db.prepare(
      'SELECT * FROM file_tree_nodes WHERE project_id = ? ORDER BY path'
    ).all(projectId) as Record<string, unknown>[];

    return rows.map(row => this.rowToTreeNode(row, projectId));
  }

  private rowToTreeNode(row: Record<string, unknown>, projectId: string): FileTreeNode {
    return {
      id: row.id as string,
      projectId,
      path: row.path as string,
      name: row.name as string,
      type: row.type as 'file' | 'directory',
      parentPath: row.parent_path as string | null,
      isExpanded: Boolean(row.is_expanded),
      metadata: parseJSON(row.metadata as string, {}),
    };
  }

  // ============================================
  // Custom Templates (core database)
  // ============================================

  async saveCustomTemplate(template: CustomTemplate): Promise<void> {
    const db = this.getDB();

    // Check if exists for upsert
    const existing = db.prepare('SELECT id FROM custom_templates WHERE id = ?').get(template.id);

    if (existing) {
      const stmt = db.prepare(`
        UPDATE custom_templates SET
          name = ?, description = ?, version = ?,
          files = ?, directories = ?, assets = ?,
          metadata = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(
        template.name,
        template.description,
        template.version,
        JSON.stringify(template.files ?? []),
        JSON.stringify(template.directories ?? []),
        JSON.stringify(template.assets ?? []),
        JSON.stringify(template.metadata ?? {}),
        new Date().toISOString(),
        template.id
      );
    } else {
      const importedAt = toISOStringRequired(template.importedAt);
      const stmt = db.prepare(`
        INSERT INTO custom_templates (
          id, name, description, version,
          files, directories, assets, metadata, imported_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        template.id,
        template.name,
        template.description,
        template.version,
        JSON.stringify(template.files ?? []),
        JSON.stringify(template.directories ?? []),
        JSON.stringify(template.assets ?? []),
        JSON.stringify(template.metadata ?? {}),
        importedAt,
        importedAt
      );
    }
  }

  async getCustomTemplate(id: string): Promise<CustomTemplate | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToTemplate(row);
  }

  async getAllCustomTemplates(): Promise<CustomTemplate[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM custom_templates ORDER BY imported_at DESC').all() as Record<string, unknown>[];

    return rows.map(row => this.rowToTemplate(row));
  }

  async deleteCustomTemplate(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM custom_templates WHERE id = ?').run(id);
  }

  private rowToTemplate(row: Record<string, unknown>): CustomTemplate {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      version: row.version as string,
      files: parseJSON(row.files as string, []),
      directories: parseJSON(row.directories as string, []),
      assets: parseJSON(row.assets as string, []),
      metadata: parseJSON(row.metadata as string, { license: 'personal' }),
      importedAt: parseDate(row.imported_at as string),
    };
  }

  // ============================================
  // Skills (core database)
  // ============================================

  async createSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      INSERT INTO skills (
        id, name, description, content, markdown,
        is_built_in, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `);

    stmt.run(
      skill.id,
      skill.name,
      skill.description,
      skill.content,
      skill.markdown,
      toISOStringRequired(skill.createdAt),
      toISOStringRequired(skill.updatedAt)
    );
  }

  async getSkill(id: string): Promise<Skill | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToSkill(row);
  }

  async updateSkill(skill: Omit<Skill, 'isBuiltIn'>): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      UPDATE skills SET
        name = ?, description = ?, content = ?,
        markdown = ?, updated_at = ?
      WHERE id = ? AND is_built_in = 0
    `);

    stmt.run(
      skill.name,
      skill.description,
      skill.content,
      skill.markdown,
      toISOStringRequired(skill.updatedAt),
      skill.id
    );
  }

  async deleteSkill(id: string): Promise<void> {
    const db = this.getDB();
    // Only delete non-built-in skills
    db.prepare('DELETE FROM skills WHERE id = ? AND is_built_in = 0').run(id);
  }

  async getAllSkills(): Promise<Skill[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM skills ORDER BY name').all() as Record<string, unknown>[];

    return rows.map(row => this.rowToSkill(row));
  }

  private rowToSkill(row: Record<string, unknown>): Skill {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      content: row.content as string,
      markdown: row.markdown as string,
      isBuiltIn: Boolean(row.is_built_in),
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
    };
  }

  // ============================================
  // Model templates (user model setups; stored in core database)
  // ============================================

  async createModelTemplate(t: ModelTemplate): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO model_templates (id, name, description, assignment, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      t.id,
      t.name,
      t.description ?? null,
      JSON.stringify(t.assignment ?? {}),
      toISOStringRequired(t.updatedAt ?? new Date()),
    );
  }

  async updateModelTemplate(t: ModelTemplate): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE model_templates SET name = ?, description = ?, assignment = ?, updated_at = ?
      WHERE id = ?
    `).run(
      t.name,
      t.description ?? null,
      JSON.stringify(t.assignment ?? {}),
      toISOStringRequired(t.updatedAt ?? new Date()),
      t.id,
    );
  }

  async getModelTemplate(id: string): Promise<ModelTemplate | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM model_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToModelTemplate(row) : null;
  }

  async getAllModelTemplates(): Promise<ModelTemplate[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM model_templates ORDER BY name').all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToModelTemplate(row));
  }

  async deleteModelTemplate(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM model_templates WHERE id = ?').run(id);
  }

  listModelTemplateSummaries(): Array<{ id: string; name: string; updatedAt: string }> {
    const db = this.getDB();
    return db.prepare('SELECT id, name, updated_at as updatedAt FROM model_templates').all() as Array<{ id: string; name: string; updatedAt: string }>;
  }

  private rowToModelTemplate(row: Record<string, unknown>): ModelTemplate {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? undefined,
      assignment: parseJSON(row.assignment as string, {} as ModelAssignment),
      updatedAt: parseDate(row.updated_at as string),
      builtin: false,
    };
  }

  // ============================================
  // Interview templates (user interview setups; core database)
  // ============================================

  async createInterviewTemplate(t: import('@/lib/interview/types').InterviewTemplate): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO interview_templates (id, name, description, spec, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      t.id, t.title, t.description ?? null,
      JSON.stringify({ items: t.items, artifacts: t.artifacts, handoff: t.handoff ?? null }),
      toISOStringRequired(t.updatedAt ?? new Date()),
    );
  }

  async updateInterviewTemplate(t: import('@/lib/interview/types').InterviewTemplate): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE interview_templates SET name = ?, description = ?, spec = ?, updated_at = ?
      WHERE id = ?
    `).run(
      t.title, t.description ?? null,
      JSON.stringify({ items: t.items, artifacts: t.artifacts, handoff: t.handoff ?? null }),
      toISOStringRequired(t.updatedAt ?? new Date()), t.id,
    );
  }

  async getInterviewTemplate(id: string): Promise<import('@/lib/interview/types').InterviewTemplate | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM interview_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToInterviewTemplate(row) : null;
  }

  async getAllInterviewTemplates(): Promise<import('@/lib/interview/types').InterviewTemplate[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM interview_templates ORDER BY name').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToInterviewTemplate(r));
  }

  async deleteInterviewTemplate(id: string): Promise<void> {
    this.getDB().prepare('DELETE FROM interview_templates WHERE id = ?').run(id);
  }

  listInterviewTemplateSummaries(): Array<{ id: string; name: string; updatedAt: string }> {
    return this.getDB().prepare('SELECT id, name, updated_at as updatedAt FROM interview_templates')
      .all() as Array<{ id: string; name: string; updatedAt: string }>;
  }

  private rowToInterviewTemplate(row: Record<string, unknown>): import('@/lib/interview/types').InterviewTemplate {
    const spec = parseJSON<{
      items: import('@/lib/interview/types').InterviewItem[];
      artifacts: { path: string; description?: string }[];
      handoff: import('@/lib/interview/types').InterviewHandoff | null;
    }>(row.spec as string, { items: [], artifacts: [], handoff: null });
    return {
      id: row.id as string,
      title: row.name as string,
      description: (row.description as string) ?? '',
      items: spec.items ?? [],
      artifacts: spec.artifacts ?? [],
      handoff: spec.handoff ?? undefined,
      updatedAt: row.updated_at ? parseDate(row.updated_at as string) : undefined,
    };
  }

  // ============================================
  // Connections (user-defined custom providers; stored in core database)
  // ============================================

  async createConnection(c: CustomConnection): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      INSERT INTO connections (id, name, base_url, format, api_key_required, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      c.id,
      c.name,
      c.baseUrl,
      c.format,
      c.apiKeyRequired ? 1 : 0,
      toISOStringRequired(c.updatedAt ?? new Date()),
    );
  }

  async updateConnection(c: CustomConnection): Promise<void> {
    const db = this.getDB();
    db.prepare(`
      UPDATE connections SET name = ?, base_url = ?, format = ?, api_key_required = ?, updated_at = ?
      WHERE id = ?
    `).run(
      c.name,
      c.baseUrl,
      c.format,
      c.apiKeyRequired ? 1 : 0,
      toISOStringRequired(c.updatedAt ?? new Date()),
      c.id,
    );
  }

  async getConnection(id: string): Promise<CustomConnection | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToConnection(row) : null;
  }

  async getAllConnections(): Promise<CustomConnection[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM connections ORDER BY name').all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToConnection(row));
  }

  async deleteConnection(id: string): Promise<void> {
    const db = this.getDB();
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  }

  private rowToConnection(row: Record<string, unknown>): CustomConnection {
    return {
      id: row.id as string,
      name: row.name as string,
      baseUrl: row.base_url as string,
      format: (row.format as 'openai') ?? 'openai',
      apiKeyRequired: row.api_key_required === 1,
      updatedAt: row.updated_at as string,
    };
  }

  // ============================================
  // Deployments (stored in core database)
  // ============================================

  async createDeployment(deployment: Deployment): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      INSERT INTO deployments (
        id, project_id, name, slug, under_construction,
        custom_domain, head_scripts, body_scripts, cdn_links,
        analytics, seo, compliance, review, settings_version,
        last_published_version, preview_image, preview_updated_at,
        database_enabled, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      deployment.id,
      deployment.projectId,
      deployment.name,
      deployment.slug ?? null,
      deployment.underConstruction ? 1 : 0,
      deployment.customDomain ?? null,
      JSON.stringify(deployment.headScripts ?? []),
      JSON.stringify(deployment.bodyScripts ?? []),
      JSON.stringify(deployment.cdnLinks ?? []),
      JSON.stringify(deployment.analytics ?? DEFAULT_ANALYTICS),
      JSON.stringify(deployment.seo ?? DEFAULT_SEO),
      JSON.stringify(deployment.compliance ?? DEFAULT_COMPLIANCE),
      JSON.stringify(deployment.review ?? DEFAULT_REVIEW),
      deployment.settingsVersion ?? 1,
      deployment.lastPublishedVersion ?? null,
      deployment.previewImage ?? null,
      toISOString(deployment.previewUpdatedAt),
      deployment.databaseEnabled ? 1 : 0,
      toISOStringRequired(deployment.createdAt),
      toISOStringRequired(deployment.updatedAt),
      toISOString(deployment.publishedAt)
    );
  }

  async getDeployment(deploymentId: string): Promise<Deployment | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToDeployment(row);
  }

  async getDeploymentBySlug(slug: string): Promise<Deployment | null> {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM deployments WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToDeployment(row);
  }

  async listDeployments(): Promise<Deployment[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM deployments ORDER BY updated_at DESC').all() as Record<string, unknown>[];

    return rows.map(row => this.rowToDeployment(row));
  }

  async listDeploymentsByProject(projectId: string): Promise<Deployment[]> {
    const db = this.getDB();
    const rows = db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at').all(projectId) as Record<string, unknown>[];

    return rows.map(row => this.rowToDeployment(row));
  }

  async updateDeployment(deployment: Deployment): Promise<void> {
    const db = this.getDB();
    const stmt = db.prepare(`
      UPDATE deployments SET
        project_id = ?, name = ?, slug = ?, under_construction = ?,
        custom_domain = ?, head_scripts = ?, body_scripts = ?, cdn_links = ?,
        analytics = ?, seo = ?, compliance = ?, review = ?, settings_version = ?,
        last_published_version = ?, preview_image = ?, preview_updated_at = ?,
        database_enabled = ?, updated_at = ?, published_at = ?
      WHERE id = ?
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
      JSON.stringify(deployment.analytics ?? DEFAULT_ANALYTICS),
      JSON.stringify(deployment.seo ?? DEFAULT_SEO),
      JSON.stringify(deployment.compliance ?? DEFAULT_COMPLIANCE),
      JSON.stringify(deployment.review ?? DEFAULT_REVIEW),
      deployment.settingsVersion ?? 1,
      deployment.lastPublishedVersion ?? null,
      deployment.previewImage ?? null,
      toISOString(deployment.previewUpdatedAt),
      deployment.databaseEnabled ? 1 : 0,
      toISOStringRequired(deployment.updatedAt),
      toISOString(deployment.publishedAt),
      deployment.id
    );
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    const db = this.getDB();

    // Delete from core database
    db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId);

    // If deployment had database enabled, also delete the deployment database file
    const deploymentDb = this.deploymentDatabases.get(deploymentId);
    if (deploymentDb) {
      deploymentDb.close();
      this.deploymentDatabases.delete(deploymentId);
    }

    deleteDeploymentDatabase(deploymentId);
  }

  private rowToDeployment(row: Record<string, unknown>): Deployment {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      name: row.name as string,
      slug: row.slug as string | undefined,
      underConstruction: Boolean(row.under_construction),
      customDomain: row.custom_domain as string | undefined,
      headScripts: parseJSON(row.head_scripts as string, []),
      bodyScripts: parseJSON(row.body_scripts as string, []),
      cdnLinks: parseJSON(row.cdn_links as string, []),
      analytics: parseJSON(row.analytics as string, DEFAULT_ANALYTICS),
      seo: parseJSON(row.seo as string, DEFAULT_SEO),
      compliance: parseJSON(row.compliance as string, DEFAULT_COMPLIANCE),
      // Spread over the default rather than relying on parseJSON's fallback alone: rows written
      // before the review column existed carry its `'{}'` default, which would otherwise read back
      // as a ReviewConfig with no `enabled`.
      review: { ...DEFAULT_REVIEW, ...parseJSON(row.review as string, DEFAULT_REVIEW) },
      settingsVersion: row.settings_version as number ?? 1,
      lastPublishedVersion: row.last_published_version as number | undefined,
      previewImage: row.preview_image as string | undefined,
      previewUpdatedAt: row.preview_updated_at ? parseDate(row.preview_updated_at as string) : undefined,
      databaseEnabled: Boolean(row.database_enabled),
      createdAt: parseDate(row.created_at as string),
      updatedAt: parseDate(row.updated_at as string),
      publishedAt: row.published_at ? parseDate(row.published_at as string) : undefined,
    };
  }

  // ============================================
  // Analytics Access (via DeploymentDatabase)
  // ============================================

  /**
   * Get the DeploymentDatabase for analytics operations
   * Only returns a database if the deployment has database enabled
   * This allows API routes to access analytics methods
   */
  getDeploymentDatabaseForAnalytics(deploymentId: string): DeploymentDatabase | null {
    // First check if the deployment exists and has database enabled
    const deployment = this.getDeploymentSync(deploymentId);
    if (!deployment || !deployment.databaseEnabled) return null;

    // Get or create the deployment database (since database is enabled)
    return this.getOrCreateDeploymentDB(deploymentId);
  }

  /**
   * Get the AnalyticsDatabase for analytics operations
   * Only returns a database if the deployment exists and has database enabled
   */
  getAnalyticsDatabaseInstance(deploymentId: string): AnalyticsDatabase | null {
    const deployment = this.getDeploymentSync(deploymentId);
    if (!deployment || !deployment.databaseEnabled) return null;

    let analyticsDb = this.analyticsDatabases.get(deploymentId);
    if (!analyticsDb) {
      analyticsDb = new AnalyticsDatabase(deploymentId);
      analyticsDb.init();
      this.analyticsDatabases.set(deploymentId, analyticsDb);
    }
    return analyticsDb;
  }

  /**
   * Synchronous version of getDeployment for internal use
   */
  private getDeploymentSync(deploymentId: string): Deployment | null {
    const db = this.getDB();
    const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToDeployment(row);
  }
}
