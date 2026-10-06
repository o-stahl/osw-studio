import 'server-only';

import { getSQLiteAdapter } from '@/lib/vfs/adapters/server';
import type { PersistedServerTask, ServerTask } from './types';

const RESTART_FAILURE = 'Server restarted before generation could finish';
const TASK_TTL_MS = 30 * 60 * 1000;

function toPersistedTask(task: ServerTask): PersistedServerTask {
  const {
    orchestrator: _orchestrator,
    pendingBuildResolve: _pendingBuildResolve,
    pendingSearchResolve: _pendingSearchResolve,
    pendingImages: _pendingImages,
    ...persisted
  } = task;
  return persisted;
}

function rowToTask(row: Record<string, unknown>): PersistedServerTask {
  let pendingApproval: PersistedServerTask['pendingApproval'] = null;
  const rawApproval = row.pending_approval as string | null | undefined;
  if (rawApproval) {
    try { pendingApproval = JSON.parse(rawApproval); } catch { pendingApproval = null; }
  }
  return {
    taskId: row.task_id as string,
    projectId: row.project_id as string,
    sessionId: row.session_id as string,
    workspaceId: (row.workspace_id as string | null) ?? undefined,
    status: row.status as PersistedServerTask['status'],
    startedAt: row.started_at as number,
    updatedAt: row.updated_at as number,
    buildDeferred: Boolean(row.build_deferred),
    prompt: (row.prompt as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    projectName: (row.project_name as string | null) ?? undefined,
    failureReason: (row.failure_reason as string | null) ?? undefined,
    pendingApproval,
  };
}

/**
 * Persists recoverable task state in the instance database. Generations cannot
 * safely resume after a process restart, so startup turns in-flight rows into
 * explicit failures without ever storing BYOK keys or orchestrator objects.
 */
export class ServerTaskStore {
  private initialized = false;

  async initialize(): Promise<PersistedServerTask[]> {
    const adapter = getSQLiteAdapter();
    await adapter.init();
    const db = adapter.getCoreDB();

    if (!this.initialized) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_generation_tasks (
          task_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          workspace_id TEXT,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          build_deferred INTEGER NOT NULL DEFAULT 0,
          prompt TEXT,
          model TEXT,
          project_name TEXT,
          failure_reason TEXT,
          pending_approval TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_server_generation_tasks_session
          ON server_generation_tasks(session_id, updated_at);
      `);

      // Additive migration for databases created before pending_approval existed. ALTER errors
      // with "duplicate column" when it already exists (fresh DBs from the CREATE above) — ignore.
      try {
        db.exec('ALTER TABLE server_generation_tasks ADD COLUMN pending_approval TEXT');
      } catch { /* column already present */ }

      const now = Date.now();
      db.prepare(`
        UPDATE server_generation_tasks
        SET status = 'failed', failure_reason = ?, updated_at = ?
        WHERE status IN ('running', 'paused', 'stopping')
      `).run(RESTART_FAILURE, now);
      this.pruneTerminal(now - TASK_TTL_MS);
      this.initialized = true;
    }

    return db.prepare('SELECT * FROM server_generation_tasks').all()
      .map((row) => rowToTask(row as Record<string, unknown>));
  }

  async save(task: ServerTask): Promise<void> {
    const adapter = getSQLiteAdapter();
    await adapter.init();
    const db = adapter.getCoreDB();
    const persisted = toPersistedTask(task);
    db.prepare(`
      INSERT INTO server_generation_tasks (
        task_id, project_id, session_id, workspace_id, status, started_at, updated_at,
        build_deferred, prompt, model, project_name, failure_reason, pending_approval
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        build_deferred = excluded.build_deferred,
        prompt = excluded.prompt,
        model = excluded.model,
        project_name = excluded.project_name,
        failure_reason = excluded.failure_reason,
        pending_approval = excluded.pending_approval
    `).run(
      persisted.taskId,
      persisted.projectId,
      persisted.sessionId,
      persisted.workspaceId ?? null,
      persisted.status,
      persisted.startedAt,
      // Persist the task's own updatedAt so the durable clock matches the in-memory one; the
      // two stores prune on the same terminal timestamp.
      persisted.updatedAt,
      persisted.buildDeferred ? 1 : 0,
      persisted.prompt ?? null,
      persisted.model ?? null,
      persisted.projectName ?? null,
      persisted.failureReason ?? null,
      persisted.pendingApproval ? JSON.stringify(persisted.pendingApproval) : null,
    );
  }

  /** Terminal tasks a client can still reattach to (by session), newest first. */
  async getBySession(sessionId: string): Promise<PersistedServerTask[]> {
    if (!this.initialized) return []; // table is created in initialize(); callers await it first
    const adapter = getSQLiteAdapter();
    await adapter.init();
    const db = adapter.getCoreDB();
    return db.prepare(
      'SELECT * FROM server_generation_tasks WHERE session_id = ? ORDER BY updated_at DESC',
    ).all(sessionId).map((row) => rowToTask(row as Record<string, unknown>));
  }

  async getById(taskId: string): Promise<PersistedServerTask | null> {
    if (!this.initialized) return null;
    const adapter = getSQLiteAdapter();
    await adapter.init();
    const db = adapter.getCoreDB();
    const row = db.prepare('SELECT * FROM server_generation_tasks WHERE task_id = ?').get(taskId);
    return row ? rowToTask(row as Record<string, unknown>) : null;
  }

  /** Drop terminal rows past the reattach window. Retention is keyed on terminal updated_at. */
  async prune(olderThan: number): Promise<void> {
    // The periodic sweep can call this before any route has run initialize(); skip until the
    // table exists rather than error on a missing table.
    if (!this.initialized) return;
    const adapter = getSQLiteAdapter();
    await adapter.init();
    this.pruneTerminal(olderThan);
  }

  private pruneTerminal(olderThan: number): void {
    getSQLiteAdapter().getCoreDB().prepare(`
      DELETE FROM server_generation_tasks
      WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
    `).run(olderThan);
  }
}

export const serverTaskStore = new ServerTaskStore();
