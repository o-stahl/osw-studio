/**
 * SQLite Connection Manager
 *
 * Singleton manager for SQLite database connections with WAL mode
 * for better concurrency. Manages:
 * - Core database (data/osws.sqlite) - projects, templates, skills
 * - Runtime databases (deployments/{deploymentId}/runtime.sqlite) - per-deployment runtime data
 * - Analytics databases (deployments/{deploymentId}/analytics.sqlite) - per-deployment analytics
 * - Review databases (deployments/{deploymentId}/review.sqlite) - per-deployment review comments
 *
 * Migration: On first access, splits old unified deployment.sqlite into
 * runtime.sqlite + analytics.sqlite if needed.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { deploymentsRoot } from '@/lib/deployments-root';

// Connection caches
const coreDatabases = new Map<string, Database.Database>();
const runtimeDatabases = new Map<string, Database.Database>();
const analyticsDatabases = new Map<string, Database.Database>();
const reviewDatabases = new Map<string, Database.Database>();
const projectDatabases = new Map<string, Database.Database>();

/**
 * Get the base directory for data storage
 * Supports DATA_DIR environment variable for custom paths
 */
function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

/**
 * Get the base directory for deployment storage
 * Includes backward compatibility: renames old sites/ dir to deployments/ if needed
 */
function getDeploymentsDir(): string {
  const deploymentsDir = deploymentsRoot();
  const oldSitesDir = path.join(process.cwd(), 'sites');

  // Backward compatibility: rename sites/ to deployments/ if old dir exists and new one doesn't
  try {
    if (!fs.existsSync(deploymentsDir) && fs.existsSync(oldSitesDir)) {
      fs.renameSync(oldSitesDir, deploymentsDir);
    }
  } catch {
    // Race condition: another request may have already renamed the directory
    if (!fs.existsSync(deploymentsDir)) {
      throw new Error('Neither deployments/ nor sites/ directory exists');
    }
  }

  return deploymentsDir;
}

/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Validate that an ID is safe for use in file paths (prevents path traversal)
 */
function validateIdFormat(id: string, label: string): void {
  if (!/^[a-f0-9-]+$/i.test(id)) {
    throw new Error(`Invalid ${label} format: ${id}`);
  }
}

/**
 * Configure a database with WAL mode and foreign keys
 */
function configureDatabase(db: Database.Database): void {
  const encryptionKey = process.env.DB_ENCRYPTION_KEY;
  if (encryptionKey) {
    db.pragma(`key='${encryptionKey}'`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');
}

/**
 * Rename helper for SQLite files including WAL and SHM
 */
function renameSqliteFile(oldPath: string, newPath: string): void {
  fs.renameSync(oldPath, newPath);
  for (const ext of ['-wal', '-shm']) {
    const oldExt = oldPath + ext;
    if (fs.existsSync(oldExt)) {
      fs.renameSync(oldExt, newPath + ext);
    }
  }
}

/**
 * Migrate old unified deployment.sqlite to split runtime.sqlite + analytics.sqlite
 * Called on first access to a deployment's database.
 *
 * Migration steps:
 * 1. Rename deployment.sqlite → runtime.sqlite
 * 2. Create analytics.sqlite with analytics tables
 * 3. Copy analytics data from runtime to analytics
 * 4. Drop analytics tables from runtime
 */
function migrateDeploymentDatabase(deploymentDir: string, deploymentId?: string): void {
  // Validate deploymentId format before using in ATTACH DATABASE to prevent path injection
  if (deploymentId && !/^[a-f0-9-]+$/i.test(deploymentId)) {
    throw new Error(`Invalid deployment ID format: ${deploymentId}`);
  }

  const oldDeploymentPath = path.join(deploymentDir, 'deployment.sqlite');
  const oldSitePath = path.join(deploymentDir, 'site.sqlite');
  const runtimePath = path.join(deploymentDir, 'runtime.sqlite');
  const analyticsPath = path.join(deploymentDir, 'analytics.sqlite');

  // Already migrated or no old database exists
  if (fs.existsSync(runtimePath)) return;

  // Determine which old file to migrate from
  let sourcePath: string | null = null;
  if (fs.existsSync(oldDeploymentPath)) {
    sourcePath = oldDeploymentPath;
  } else if (fs.existsSync(oldSitePath)) {
    sourcePath = oldSitePath;
  }

  if (!sourcePath) return; // No database to migrate

  // Step 1: Rename old database to runtime.sqlite
  renameSqliteFile(sourcePath, runtimePath);

  // Step 2: Create analytics.sqlite and migrate analytics data
  try {
    const runtimeDb = new Database(runtimePath);
    configureDatabase(runtimeDb);

    try {
      // Check if analytics tables exist in the old unified database
      const hasPageviews = runtimeDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pageviews'"
      ).get();

      if (hasPageviews) {
        // Attach analytics database (creates file if it doesn't exist)
        runtimeDb.exec(`ATTACH DATABASE '${analyticsPath}' AS analytics_new`);

        // Create analytics tables in new database
        runtimeDb.exec(`
          CREATE TABLE IF NOT EXISTS analytics_new.pageviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_path TEXT NOT NULL,
            referrer TEXT,
            country TEXT,
            user_agent TEXT,
            device_type TEXT,
            session_id TEXT NOT NULL,
            load_time INTEGER,
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_pageviews_timestamp ON pageviews(timestamp)`);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_pageviews_session_id ON pageviews(session_id)`);

        runtimeDb.exec(`
          CREATE TABLE IF NOT EXISTS analytics_new.interactions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            page_path TEXT NOT NULL,
            interaction_type TEXT NOT NULL,
            element_selector TEXT,
            coordinates TEXT,
            scroll_depth INTEGER,
            time_on_page INTEGER,
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_interactions_page_path ON interactions(page_path)`);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_interactions_timestamp ON interactions(timestamp)`);

        runtimeDb.exec(`
          CREATE TABLE IF NOT EXISTS analytics_new.sessions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            entry_page TEXT,
            exit_page TEXT,
            page_count INTEGER DEFAULT 1,
            duration INTEGER,
            is_bounce INTEGER DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            ended_at TEXT
          )
        `);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_sessions_session_id ON sessions(session_id)`);
        runtimeDb.exec(`CREATE INDEX IF NOT EXISTS analytics_new.idx_sessions_created_at ON sessions(created_at)`);

        // Copy analytics data
        runtimeDb.exec(`INSERT INTO analytics_new.pageviews SELECT * FROM main.pageviews`);
        runtimeDb.exec(`INSERT INTO analytics_new.interactions SELECT * FROM main.interactions`);
        runtimeDb.exec(`INSERT INTO analytics_new.sessions SELECT * FROM main.sessions`);

        // Detach
        runtimeDb.exec(`DETACH DATABASE analytics_new`);

        // Drop analytics tables from runtime database
        runtimeDb.exec(`DROP TABLE IF EXISTS pageviews`);
        runtimeDb.exec(`DROP TABLE IF EXISTS interactions`);
        runtimeDb.exec(`DROP TABLE IF EXISTS sessions`);
      }
    } finally {
      runtimeDb.close();
    }
  } catch (err) {
    console.error('[SQLite Migration] Failed to split deployment database:', err);
    // Migration failure is non-fatal — runtime.sqlite still has all data
  }
}

/**
 * Get the core database connection (cached per path)
 * Creates data/osws.sqlite if it doesn't exist
 */
export function getCoreDatabase(customPath?: string): Database.Database {
  const dataDir = getDataDir();
  const dbPath = customPath || path.join(dataDir, 'osws.sqlite');

  const cached = coreDatabases.get(dbPath);
  if (cached) return cached;

  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  configureDatabase(db);
  coreDatabases.set(dbPath, db);
  return db;
}

/**
 * Get a deployment's runtime database connection (cached)
 * Creates deployments/{deploymentId}/runtime.sqlite if it doesn't exist
 * Runs migration from old deployment.sqlite if needed
 */
export function getRuntimeDatabaseConnection(deploymentId: string): Database.Database {
  validateIdFormat(deploymentId, 'deployment ID');
  const cached = runtimeDatabases.get(deploymentId);
  if (cached) {
    return cached;
  }

  const deploymentsDir = getDeploymentsDir();
  const deploymentDir = path.join(deploymentsDir, deploymentId);
  ensureDir(deploymentDir);

  // Run migration if old unified database exists
  migrateDeploymentDatabase(deploymentDir, deploymentId);

  const dbPath = path.join(deploymentDir, 'runtime.sqlite');
  const db = new Database(dbPath);
  configureDatabase(db);

  runtimeDatabases.set(deploymentId, db);
  return db;
}

/**
 * Get a deployment's analytics database connection (cached)
 * Creates deployments/{deploymentId}/analytics.sqlite if it doesn't exist
 */
export function getAnalyticsDatabaseConnection(deploymentId: string): Database.Database {
  validateIdFormat(deploymentId, 'deployment ID');
  const cached = analyticsDatabases.get(deploymentId);
  if (cached) {
    return cached;
  }

  const deploymentsDir = getDeploymentsDir();
  const deploymentDir = path.join(deploymentsDir, deploymentId);
  ensureDir(deploymentDir);

  // Ensure migration has run (in case analytics DB is requested first)
  migrateDeploymentDatabase(deploymentDir, deploymentId);

  const dbPath = path.join(deploymentDir, 'analytics.sqlite');
  const db = new Database(dbPath);
  configureDatabase(db);

  analyticsDatabases.set(deploymentId, db);
  return db;
}

/**
 * Get a deployment's review database connection (cached)
 * Creates deployments/{deploymentId}/review.sqlite if it doesn't exist
 */
export function getReviewDatabaseConnection(deploymentId: string): Database.Database {
  validateIdFormat(deploymentId, 'deployment ID');
  const cached = reviewDatabases.get(deploymentId);
  if (cached) {
    return cached;
  }

  const deploymentsDir = getDeploymentsDir();
  const deploymentDir = path.join(deploymentsDir, deploymentId);
  ensureDir(deploymentDir);

  // No migrateDeploymentDatabase call here, unlike the runtime and analytics connections: review
  // data postdates the unified deployment.sqlite, so there is nothing in it to split out.
  const dbPath = path.join(deploymentDir, 'review.sqlite');
  const db = new Database(dbPath);
  configureDatabase(db);

  reviewDatabases.set(deploymentId, db);
  return db;
}

/**
 * @deprecated Use getRuntimeDatabaseConnection instead
 * Backward compatibility: returns runtime database connection
 */
export function getDeploymentDatabase(deploymentId: string): Database.Database {
  return getRuntimeDatabaseConnection(deploymentId);
}

/**
 * Delete a deployment's databases and directory
 */
export function deleteDeploymentDatabase(deploymentId: string): void {
  validateIdFormat(deploymentId, 'deployment ID');
  // Close all connections. An open handle keeps the file locked on Windows, which would fail the
  // recursive removal below.
  closeRuntimeDatabase(deploymentId);
  closeAnalyticsDatabase(deploymentId);
  closeReviewDatabase(deploymentId);

  const deploymentsDir = getDeploymentsDir();
  const deploymentDir = path.join(deploymentsDir, deploymentId);

  // A deployment directory may contain subdirectories, not only files, so a flat unlink pass is
  // not enough. force: true also makes this a no-op when the directory is already gone.
  fs.rmSync(deploymentDir, { recursive: true, force: true });
}

/**
 * Close a specific deployment's runtime database connection
 */
export function closeRuntimeDatabase(deploymentId: string): void {
  const db = runtimeDatabases.get(deploymentId);
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore errors on close
    }
    runtimeDatabases.delete(deploymentId);
  }
}

/**
 * Close a specific deployment's analytics database connection
 */
export function closeAnalyticsDatabase(deploymentId: string): void {
  const db = analyticsDatabases.get(deploymentId);
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore errors on close
    }
    analyticsDatabases.delete(deploymentId);
  }
}

/**
 * Close a specific deployment's review database connection
 */
export function closeReviewDatabase(deploymentId: string): void {
  const db = reviewDatabases.get(deploymentId);
  if (db) {
    try {
      db.close();
    } catch {
      // Ignore errors on close
    }
    reviewDatabases.delete(deploymentId);
  }
}

/**
 * @deprecated Use closeRuntimeDatabase instead
 */
export function closeDeploymentDatabase(deploymentId: string): void {
  closeRuntimeDatabase(deploymentId);
  closeAnalyticsDatabase(deploymentId);
  closeReviewDatabase(deploymentId);
}

/**
 * Close a specific core database connection by path.
 * Use this when closing a single workspace adapter to avoid
 * destroying connections belonging to other workspaces.
 */
export function closeCoreDatabaseByPath(dbPath: string): void {
  const db = coreDatabases.get(dbPath);
  if (db) {
    try { db.close(); } catch {}
    coreDatabases.delete(dbPath);
  }
}

/**
 * Close all core database connections
 */
export function closeCoreDatabase(): void {
  for (const [, db] of coreDatabases) {
    try { db.close(); } catch {}
  }
  coreDatabases.clear();
}

// ============================================
// Project Database Connections
// ============================================

/**
 * Get the file path for a project's database
 */
export function getProjectDatabasePath(projectId: string, baseDir?: string): string {
  validateIdFormat(projectId, 'project ID');
  const dataDir = baseDir || getDataDir();
  return path.join(dataDir, 'projects', projectId, 'database.sqlite');
}

/** Whether a deployment has a runtime database yet (its functions, secrets and schedules). */
export function runtimeDatabaseExists(deploymentId: string): boolean {
  validateIdFormat(deploymentId, 'deployment ID');
  return fs.existsSync(path.join(getDeploymentsDir(), deploymentId, 'runtime.sqlite'));
}

/**
 * Check if a project database exists
 */
export function projectDatabaseExists(projectId: string, baseDir?: string): boolean {
  return fs.existsSync(getProjectDatabasePath(projectId, baseDir));
}

/**
 * Get a project's database connection (cached)
 * Creates data/projects/{projectId}/database.sqlite if it doesn't exist
 */
export function getProjectDatabaseConnection(projectId: string, baseDir?: string): Database.Database {
  validateIdFormat(projectId, 'project ID');
  const cacheKey = baseDir ? `${baseDir}:${projectId}` : projectId;
  const cached = projectDatabases.get(cacheKey);
  if (cached) return cached;

  const dataDir = baseDir || getDataDir();
  const projectDir = path.join(dataDir, 'projects', projectId);
  ensureDir(projectDir);

  const dbPath = path.join(projectDir, 'database.sqlite');
  const db = new Database(dbPath);
  configureDatabase(db);

  projectDatabases.set(cacheKey, db);
  return db;
}

/**
 * Close a specific project's database connection
 */
export function closeProjectDatabase(projectId: string, baseDir?: string): void {
  const cacheKey = baseDir ? `${baseDir}:${projectId}` : projectId;
  const db = projectDatabases.get(cacheKey);
  if (db) {
    try { db.close(); } catch {}
    projectDatabases.delete(cacheKey);
  }
}

/**
 * Delete a project's database and directory
 */
export function deleteProjectDatabase(projectId: string, baseDir?: string): void {
  validateIdFormat(projectId, 'project ID');
  closeProjectDatabase(projectId, baseDir);

  const dataDir = baseDir || getDataDir();
  const projectDir = path.join(dataDir, 'projects', projectId);

  if (fs.existsSync(projectDir)) {
    const files = fs.readdirSync(projectDir);
    for (const file of files) {
      fs.unlinkSync(path.join(projectDir, file));
    }
    fs.rmdirSync(projectDir);
  }
}

/**
 * Close all database connections (for cleanup/shutdown)
 */
export function closeAllConnections(): void {
  // Close all runtime databases
  for (const [deploymentId] of runtimeDatabases) {
    closeRuntimeDatabase(deploymentId);
  }

  // Close all analytics databases
  for (const [deploymentId] of analyticsDatabases) {
    closeAnalyticsDatabase(deploymentId);
  }

  // Close all review databases
  for (const [deploymentId] of reviewDatabases) {
    closeReviewDatabase(deploymentId);
  }

  // Close all project databases (keys may be composite "baseDir:projectId")
  for (const [, db] of projectDatabases) {
    try { db.close(); } catch {}
  }
  projectDatabases.clear();

  // Close core database
  closeCoreDatabase();
}

/**
 * List all deployment IDs that have databases
 */
export function listDeploymentIds(): string[] {
  const deploymentsDir = getDeploymentsDir();

  if (!fs.existsSync(deploymentsDir)) {
    return [];
  }

  const entries = fs.readdirSync(deploymentsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .filter(entry => {
      const dir = path.join(deploymentsDir, entry.name);
      // Check for any database format
      return fs.existsSync(path.join(dir, 'runtime.sqlite')) ||
             fs.existsSync(path.join(dir, 'deployment.sqlite')) ||
             fs.existsSync(path.join(dir, 'site.sqlite'));
    })
    .map(entry => entry.name);
}

/**
 * Get the file path for a deployment's runtime database (for export/backup)
 */
export function getDeploymentDatabasePath(deploymentId: string): string {
  validateIdFormat(deploymentId, 'deployment ID');
  const deploymentsDir = getDeploymentsDir();
  return path.join(deploymentsDir, deploymentId, 'runtime.sqlite');
}

/**
 * Get the file path for the core database (for export/backup)
 */
export function getCoreDatabasePath(): string {
  const dataDir = getDataDir();
  return path.join(dataDir, 'osws.sqlite');
}
