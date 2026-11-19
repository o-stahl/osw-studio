import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { SQLiteAdapter } from '../sqlite-adapter';
import type { BackendFeatures, CustomTemplate } from '../../types';
import { withLocalTemplateFields } from '../../sync-types';

const FEATURES: BackendFeatures = {
  edgeFunctions: [{ name: 'hello', method: 'GET', code: 'return 1' }],
  secrets: [{ name: 'KEY' }],
  databaseSchema: 'CREATE TABLE t (id INTEGER);',
};

const template = (over: Partial<CustomTemplate> = {}): CustomTemplate => ({
  id: 't1', name: 'Shop', description: 'd', version: '2.0.0', directories: [], assets: [],
  files: [{ path: '/index.html', content: '<p>x</p>' }], metadata: { license: 'mit' },
  importedAt: new Date(0), runtime: 'react', backendFeatures: FEATURES, ...over,
});

let dir: string;
let dbPath: string;
let adapter: SQLiteAdapter;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-tpl-'));
  dbPath = path.join(dir, 'osws.sqlite');
  adapter = new SQLiteAdapter(dbPath);
  await adapter.init();
});

afterEach(async () => {
  await adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a custom template in SQLite', () => {
  it('keeps its runtime and backend features when created', async () => {
    await adapter.saveCustomTemplate(template());
    expect(await adapter.getCustomTemplate('t1')).toMatchObject({ runtime: 'react', backendFeatures: FEATURES });
    expect((await adapter.getAllCustomTemplates())[0]).toMatchObject({ runtime: 'react', backendFeatures: FEATURES });
  });

  it('takes new values on an update, and clears what the update no longer has', async () => {
    await adapter.saveCustomTemplate(template());
    await adapter.saveCustomTemplate(template({ runtime: 'static', backendFeatures: { secrets: [{ name: 'OTHER' }] } }));
    expect(await adapter.getCustomTemplate('t1')).toMatchObject({ runtime: 'static', backendFeatures: { secrets: [{ name: 'OTHER' }] } });

    await adapter.saveCustomTemplate(template({ runtime: undefined, backendFeatures: undefined }));
    const cleared = await adapter.getCustomTemplate('t1');
    expect(cleared!.runtime).toBeUndefined();
    expect(cleared!.backendFeatures).toBeUndefined();
  });

  it('gains the columns on an existing database, keeping its rows', async () => {
    await adapter.close();
    const db = new Database(dbPath);
    db.exec(`ALTER TABLE custom_templates DROP COLUMN runtime`);
    db.exec(`ALTER TABLE custom_templates DROP COLUMN backend_features`);
    db.prepare(`DELETE FROM _migrations WHERE id = 'add_custom_template_runtime_v14'`).run();
    db.prepare(`INSERT INTO custom_templates (id, name, description, version, imported_at) VALUES ('old', 'Old', '', '1.0.0', ?)`).run(new Date(0).toISOString());
    db.close();

    adapter = new SQLiteAdapter(dbPath);
    await adapter.init();
    const old = await adapter.getCustomTemplate('old');
    expect(old).toMatchObject({ id: 'old', name: 'Old' });
    expect(old!.runtime).toBeUndefined();

    await adapter.saveCustomTemplate(template({ id: 'old' }));
    expect(await adapter.getCustomTemplate('old')).toMatchObject({ runtime: 'react', backendFeatures: FEATURES });
  });
});

describe('a pulled template', () => {
  it('keeps the local runtime and backend features a server row saved before these fields lacks', () => {
    const pulled = template({ name: 'Renamed', runtime: undefined, backendFeatures: undefined });
    expect(withLocalTemplateFields(pulled, template())).toMatchObject({ name: 'Renamed', runtime: 'react', backendFeatures: FEATURES });
  });

  it('takes the server\'s values where it has them', () => {
    const pulled = template({ runtime: 'static', backendFeatures: { secrets: [] } });
    expect(withLocalTemplateFields(pulled, template())).toMatchObject({ runtime: 'static', backendFeatures: { secrets: [] } });
    expect(withLocalTemplateFields(pulled, null)).toBe(pulled);
  });

  it('goes through that merge when Server Sync saves it', () => {
    const tab = fs.readFileSync(path.join(process.cwd(), 'components/project-manager/sync-tabs/templates-tab.tsx'), 'utf8');
    expect(tab).toMatch(/saveCustomTemplate\(withLocalTemplateFields\(template, await adapter\.getCustomTemplate\(template\.id\)\)\)/);
  });
});
