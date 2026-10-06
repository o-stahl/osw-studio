import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Which tables function code may use in the deployment's runtime database.
 *
 * The runtime database holds the deployment's machinery (functions, secrets, files) and the site's
 * own tables. Analytics lives in a separate file, so a site table named like an analytics one
 * (the Blog template's `sessions`) is the site's, and refusing it breaks the template's login.
 */

let dir: string;
let db: InstanceType<typeof import('@/lib/vfs/adapters/runtime-database').RuntimeDatabase>;
let api: ReturnType<typeof import('../database-api').createDatabaseAPI>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-dbapi-'));
  vi.stubEnv('DEPLOYMENTS_DIR', dir);
  vi.resetModules();
  const { RuntimeDatabase } = await import('@/lib/vfs/adapters/runtime-database');
  const { createDatabaseAPI } = await import('../database-api');
  db = new RuntimeDatabase('d1');
  db.init();
  db.executeUserQuery('CREATE TABLE sessions (id INTEGER PRIMARY KEY, token TEXT)');
  db.executeUserQuery('CREATE TABLE pageviews (id INTEGER PRIMARY KEY, path TEXT)');
  api = createDatabaseAPI(db);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('function code and the runtime database', () => {
  it('uses a site table that shares a name with an analytics table', () => {
    api.run('INSERT INTO sessions (token) VALUES (?)', ['t1']);
    expect(api.query('SELECT token FROM sessions')).toEqual([{ token: 't1' }]);
    api.run('INSERT INTO pageviews (path) VALUES (?)', ['/']);
    expect(api.query('SELECT path FROM pageviews')).toEqual([{ path: '/' }]);
  });

  it('reports the row an insert created, so a second insert can reference it', () => {
    db.executeUserQuery('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    api.run('INSERT INTO users (name) VALUES (?)', ['a']);
    const second = api.run('INSERT INTO users (name) VALUES (?)', ['b']);
    expect(second).toEqual({ changes: 1, lastInsertRowid: 2 });
  });

  it.each(['secrets', 'edge_functions', 'server_functions', 'scheduled_functions', 'function_logs', 'site_info', 'files', 'file_tree_nodes'])(
    'is refused the system table %s',
    (table) => {
      expect(() => api.query(`SELECT * FROM ${table}`)).toThrow(/system table/);
    },
  );
});
