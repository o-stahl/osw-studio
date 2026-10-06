import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { installLocalStorageStub } from './local-storage-stub';

const { vfs } = await import('../index');
const { getProjectSchema, setProjectSchema, clearLegacyProjectSchema, applyProjectDatabaseSchema } =
  await import('../project-schema');
const { setAutoSyncWorkspaceId } = await import('../auto-sync');

const DDL = 'CREATE TABLE messages (id INTEGER PRIMARY KEY);';
const legacyKey = (projectId: string) => `osw-db-schema-${projectId}`;

describe('project database schema', () => {
  let restore = () => {};

  beforeAll(async () => { await vfs.init(); });
  beforeEach(() => { restore(); restore = installLocalStorageStub(); });
  afterAll(() => { restore(); });

  it('stores the schema on the project record, not in localStorage', async () => {
    const project = await vfs.createProject('Schema', 'test');
    await setProjectSchema(project.id, DDL);

    const stored = await vfs.getProject(project.id);
    expect(stored.settings.databaseSchema).toBe(DDL);
    expect(localStorage.getItem(legacyKey(project.id))).toBeNull();
  });

  it('reads back what was written', async () => {
    const project = await vfs.createProject('Schema', 'test');
    await setProjectSchema(project.id, DDL);
    expect(await getProjectSchema(project.id)).toBe(DDL);
  });

  it('clears the field rather than storing an empty string', async () => {
    const project = await vfs.createProject('Schema', 'test');
    await setProjectSchema(project.id, DDL);
    await setProjectSchema(project.id, '');

    const stored = await vfs.getProject(project.id);
    expect(stored.settings.databaseSchema).toBeUndefined();
    expect(await getProjectSchema(project.id)).toBe('');
  });

  it('migrates a schema still sitting in localStorage onto the record', async () => {
    const project = await vfs.createProject('Legacy', 'test');
    localStorage.setItem(legacyKey(project.id), DDL);

    expect(await getProjectSchema(project.id)).toBe(DDL);

    const stored = await vfs.getProject(project.id);
    expect(stored.settings.databaseSchema).toBe(DDL);
    // Migrated, so the old copy goes — otherwise it would shadow later edits.
    expect(localStorage.getItem(legacyKey(project.id))).toBeNull();
  });

  it('does not mark the project as edited when migrating', async () => {
    const project = await vfs.createProject('Legacy', 'test');
    const before = (await vfs.getProject(project.id)).updatedAt.getTime();
    localStorage.setItem(legacyKey(project.id), DDL);

    await getProjectSchema(project.id);

    const after = (await vfs.getProject(project.id)).updatedAt.getTime();
    expect(after).toBe(before);
  });

  it('marks the project as edited when the schema is actually changed', async () => {
    const project = await vfs.createProject('Schema', 'test');
    const before = (await vfs.getProject(project.id)).updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 2));

    await setProjectSchema(project.id, DDL);

    const after = (await vfs.getProject(project.id)).updatedAt.getTime();
    expect(after).toBeGreaterThan(before);
  });

  it('prefers the record over a stale legacy copy', async () => {
    const project = await vfs.createProject('Schema', 'test');
    await setProjectSchema(project.id, DDL);
    localStorage.setItem(legacyKey(project.id), 'CREATE TABLE stale (id INTEGER);');

    expect(await getProjectSchema(project.id)).toBe(DDL);
  });

  it('returns the legacy copy for a project that no longer exists', async () => {
    localStorage.setItem(legacyKey('gone'), DDL);
    expect(await getProjectSchema('gone')).toBe(DDL);
  });

  it('clearLegacyProjectSchema removes the old key', async () => {
    localStorage.setItem(legacyKey('p1'), DDL);
    clearLegacyProjectSchema('p1');
    expect(localStorage.getItem(legacyKey('p1'))).toBeNull();
  });
});

/**
 * A template's schema (the Blog's users, sessions and comments) is created in the project's server
 * database when the project is created, so a published site has its tables. The server only has
 * workspace-scoped routes; posting to an unscoped one failed and left the tables uncreated.
 */
describe('applying a schema in Server Mode', () => {
  let restore = () => {};
  beforeAll(async () => { await vfs.init(); });
  beforeEach(() => { restore(); restore = installLocalStorageStub(); });
  afterAll(() => {
    restore();
    setAutoSyncWorkspaceId(undefined);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("creates the tables through the current workspace's project database route", async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    setAutoSyncWorkspaceId('ws1');
    const posted: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });
    const project = await vfs.createProject('Blog', 'test');

    await applyProjectDatabaseSchema(project.id, DDL);

    expect(posted).toEqual([{ url: `/api/w/ws1/projects/${project.id}/database/query`, body: { sql: DDL } }]);
    expect((await vfs.getProject(project.id)).settings.databaseSchema).toBe(DDL);
  });

  it('only stores the schema outside Server Mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'false');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const project = await vfs.createProject('Blog', 'test');

    await applyProjectDatabaseSchema(project.id, DDL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await vfs.getProject(project.id)).settings.databaseSchema).toBe(DDL);
  });

  it('keeps the schema when the server cannot be reached', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
    setAutoSyncWorkspaceId('ws1');
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const project = await vfs.createProject('Blog', 'test');

    await expect(applyProjectDatabaseSchema(project.id, DDL)).resolves.toBeUndefined();
    expect((await vfs.getProject(project.id)).settings.databaseSchema).toBe(DDL);
  });
});
