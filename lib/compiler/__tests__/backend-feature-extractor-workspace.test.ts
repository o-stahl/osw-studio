import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Publishing copies a project's own tables (the Blog template's users, sessions and comments) into
 * the deployment's runtime database. A workspace keeps its project databases under its own
 * directory, so the copy has to look there, not in the shared data directory.
 */

vi.mock('server-only', () => ({}));

const WS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROJECT = '11111111-1111-1111-1111-111111111111';
const DEPLOYMENT = '22222222-2222-2222-2222-222222222222';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-extract-'));
  vi.resetModules();
  vi.stubEnv('DATA_DIR', path.join(dir, 'data'));
  vi.stubEnv('DEPLOYMENTS_DIR', path.join(dir, 'deployments'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractBackendFeatures in a workspace', () => {
  it("copies the project's tables and rows into the deployment", async () => {
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const { extractBackendFeatures } = await import('../backend-feature-extractor');
    const { RuntimeDatabase } = await import('@/lib/vfs/adapters/runtime-database');

    const adapter = getWorkspaceAdapter(WS);
    await adapter.init();
    await adapter.createProject({ id: PROJECT, name: 'Blog', createdAt: new Date(), updatedAt: new Date(), settings: {} } as never);
    await adapter.createEdgeFunction!({
      id: 'f1', projectId: PROJECT, name: 'hello', code: 'Response.json({})', method: 'GET',
      enabled: true, timeoutMs: 5000, createdAt: new Date(), updatedAt: new Date(),
    } as never);
    const projectDb = adapter.getProjectDatabase(PROJECT);
    projectDb.executeDDL('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    projectDb.executeRawSQL("INSERT INTO users (name) VALUES ('ada')");

    const summary = await extractBackendFeatures(PROJECT, DEPLOYMENT, WS);

    expect(summary.errors).toEqual([]);
    expect(summary.databaseSchemaApplied).toBe(true);
    const runtime = new RuntimeDatabase(DEPLOYMENT);
    runtime.init();
    expect(runtime.executeRawSQL('SELECT name FROM users').rows).toEqual([['ada']]);
    runtime.close();
    await adapter.close?.();
  });

  it('clears what an earlier publish provisioned when the project has no backend features left', async () => {
    const { getWorkspaceAdapter } = await import('@/lib/vfs/adapters/server');
    const { extractBackendFeatures } = await import('../backend-feature-extractor');
    const { RuntimeDatabase } = await import('@/lib/vfs/adapters/runtime-database');

    const adapter = getWorkspaceAdapter(WS);
    await adapter.init();
    await adapter.createProject({ id: PROJECT, name: 'Blog', createdAt: new Date(), updatedAt: new Date(), settings: {} } as never);
    await adapter.createEdgeFunction!({
      id: 'f1', projectId: PROJECT, name: 'hello', code: 'Response.json({})', method: 'GET',
      enabled: true, timeoutMs: 5000, createdAt: new Date(), updatedAt: new Date(),
    } as never);
    await extractBackendFeatures(PROJECT, DEPLOYMENT, WS);

    await adapter.deleteEdgeFunction!('f1');
    await extractBackendFeatures(PROJECT, DEPLOYMENT, WS);

    const runtime = new RuntimeDatabase(DEPLOYMENT);
    runtime.init();
    expect(runtime.listFunctions()).toEqual([]);
    runtime.close();
    await adapter.close?.();
  });
});

