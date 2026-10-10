import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';
import { getCoreDatabase } from '@/lib/vfs/adapters/sqlite-connection';

/**
 * The v13 migration rebuilds `deployments` without its `ON DELETE CASCADE` onto projects. It runs on
 * installs that already have deployments, so what matters is that every existing row survives the
 * rebuild with every column, the project_id index comes back, and afterwards deleting a project
 * leaves its deployment. A fresh database (what the other tests open) has no rows to lose.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const V13 = 'deployments_outlive_projects_v13';
const PROJECT = '11111111-1111-1111-1111-111111111111';

let dir: string;
let dbPath: string;

/** A database migrated by the real migrations up to, but not including, v13. */
async function preV13Database(): Promise<void> {
  const db = getCoreDatabase(dbPath);
  db.exec(`CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(V13);

  const adapter = new SQLiteAdapter(dbPath);
  await adapter.init();
  await adapter.createProject({ id: PROJECT, name: 'P', createdAt: new Date(), updatedAt: new Date(), settings: {} } as never);
  await adapter.createDeployment({
    id: 'd1', projectId: PROJECT, name: 'Shop', slug: 'shop', customDomain: 'shop.test',
    underConstruction: true, headScripts: [{ id: 'h', name: 'h', content: '<x>', enabled: true }],
    bodyScripts: [], cdnLinks: [], settingsVersion: 4, lastPublishedVersion: 3,
    analytics: { enabled: true, provider: 'builtin', privacyMode: false },
    review: { enabled: true, expiresAt: '2030-01-01T00:00:00.000Z' },
    databaseEnabled: true,
    createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-02-01'), publishedAt: new Date('2025-03-01'),
  } as never);

  getCoreDatabase(dbPath).prepare('DELETE FROM _migrations WHERE id = ?').run(V13);
  await adapter.close();
}

function deploymentsTableSql(): string {
  return (getCoreDatabase(dbPath)
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deployments'`)
    .get() as { sql: string }).sql;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-v13-'));
  dbPath = path.join(dir, 'osws.sqlite');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deployments_outlive_projects_v13 on a database with deployments', () => {
  it('keeps every row and column, the index, and the row once its project is deleted', async () => {
    await preV13Database();

    // Control: the pre-migration table really cascades, and holds the row.
    expect(deploymentsTableSql()).toMatch(/ON DELETE CASCADE/i);
    const before = getCoreDatabase(dbPath).prepare('SELECT * FROM deployments').all();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: 'd1', slug: 'shop', custom_domain: 'shop.test' });
    expect(Object.keys(before[0] as object)).toContain('review');

    const adapter = new SQLiteAdapter(dbPath);
    await adapter.init();
    try {
      const db = getCoreDatabase(dbPath);
      expect(db.prepare('SELECT id FROM _migrations WHERE id = ?').get(V13)).toBeTruthy();
      expect(deploymentsTableSql()).not.toMatch(/FOREIGN KEY/i);

      expect(db.prepare('SELECT * FROM deployments').all()).toEqual(before);
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'deployments'`).all()
      ).toContainEqual({ name: 'idx_deployments_project_id' });

      const read = await adapter.getDeployment('d1');
      expect(read?.review).toEqual({ enabled: true, expiresAt: '2030-01-01T00:00:00.000Z' });

      await adapter.deleteProject(PROJECT);
      expect(await adapter.getProject(PROJECT)).toBeNull();
      expect((await adapter.listDeployments()).map((d) => d.id)).toEqual(['d1']);
    } finally {
      await adapter.close();
    }
  });
});
