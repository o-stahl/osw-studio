// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * A push larger than one request, against the real route and a real database.
 *
 * Next truncates a request body past `proxyClientMaxBodySize` instead of rejecting it, so a
 * project that outgrew the limit failed with a JSON parse error that read like data corruption.
 * The fix splits the push into batches — which introduces its own failure modes, and those are
 * what these tests are about: a push must not conflict with itself, and one that dies half way
 * must leave the project recoverable rather than looking finished.
 *
 * Same shape as sync-end-state.test.ts: nothing about sync is mocked, and the assertions are on
 * the state a user can observe (does Server Sync say synced, does the server hold every file)
 * rather than on the wire format, which is free to change.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));

vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { GET as statusGET } from '@/app/api/w/[workspaceId]/sync/status/route';
import {
  GET as projectGET,
  POST as projectPOST,
} from '@/app/api/w/[workspaceId]/sync/projects/[id]/route';
import {
  GET as projectsGET,
  POST as projectsPOST,
} from '@/app/api/w/[workspaceId]/sync/projects/route';
import {
  GET as filesGET,
  POST as filesPOST,
} from '@/app/api/w/[workspaceId]/sync/files/route';
import { POST as templatePOST } from '@/app/api/w/[workspaceId]/sync/templates/[id]/route';

import { vfs } from '../index';
import { batchFilesBySize, getSyncManager } from '../sync-manager';
import { saveManager } from '../save-manager';
import { calculateItemSyncStatus } from '../sync-types';
import {
  fetchSyncStatus,
  invalidateSyncStatusCache,
  setAutoSyncWorkspaceId,
} from '../auto-sync';

const WORKSPACE = 'w1';

// Over the 5MB batch target, so a project of these needs more than one request. Real sizes rather
// than an injected cap: a test that sets its own limit cannot catch the limit being wrong.
const BIG = 'x'.repeat(3 * 1024 * 1024);

let dir: string;
let adapter: SQLiteAdapter;
let postCount = 0;
let failPostNumber: number | null = null;

async function dispatch(rawUrl: string, init?: RequestInit): Promise<Response> {
  const url = new URL(rawUrl, 'http://localhost');
  const match = url.pathname.match(/^\/api\/w\/([^/]+)\/sync\/(.+)$/);
  if (!match) throw new Error(`unrouted request: ${rawUrl}`);
  const [, workspaceId, rest] = match;
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method === 'POST') {
    postCount += 1;
    if (failPostNumber === postCount) {
      // What a dropped connection looks like to the client mid-push.
      return new Response(JSON.stringify({ error: 'server exploded' }), { status: 500 });
    }
  }

  const request = new NextRequest(`http://localhost${url.pathname}${url.search}`, {
    method,
    ...(init?.body ? { body: init.body as string } : {}),
  });

  if (rest === 'status') return statusGET(request, { params: Promise.resolve({ workspaceId }) });
  if (rest === 'projects') {
    const params = Promise.resolve({ workspaceId });
    return method === 'POST' ? projectsPOST(request, { params }) : projectsGET(request, { params });
  }
  if (rest.startsWith('files')) {
    const params = Promise.resolve({ workspaceId });
    return method === 'POST' ? filesPOST(request, { params }) : filesGET(request, { params });
  }

  const template = rest.match(/^templates\/([^/?]+)$/);
  if (template && method === 'POST') {
    return templatePOST(request, { params: Promise.resolve({ workspaceId, id: template[1] }) });
  }

  const single = rest.match(/^projects\/([^/?]+)$/);
  if (single) {
    const params = Promise.resolve({ workspaceId, id: single[1] });
    return method === 'POST' ? projectPOST(request, { params }) : projectGET(request, { params });
  }
  throw new Error(`unrouted request: ${rawUrl}`);
}

async function serverSyncSays(projectId: string) {
  invalidateSyncStatusCache();
  const status = await fetchSyncStatus();
  const server = (status?.projects ?? []).find((p: { id: string }) => p.id === projectId);
  const local = await vfs.getProject(projectId);
  return calculateItemSyncStatus(
    local!.updatedAt,
    server?.updatedAt ?? null,
    local!.lastSyncedAt ?? null
  );
}

/** What the server actually holds, read back through the pull route. */
async function serverFiles(projectId: string): Promise<Map<string, string>> {
  const result = await getSyncManager(WORKSPACE).pullSingleProject(projectId);
  return new Map((result.files ?? []).map((file) => [file.path, String(file.content ?? '')]));
}

const CREATED_AT = new Date('2026-08-13T10:00:00.000Z');
const PUSHED_AT = new Date('2026-08-13T10:00:05.000Z');
const EDITED_AT = new Date('2026-08-13T10:00:10.000Z');

beforeEach(async () => {
  vi.clearAllMocks();
  postCount = 0;
  failPostNumber = null;
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CREATED_AT);

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-chunked-'));
  adapter = new SQLiteAdapter(path.join(dir, 'osws.sqlite'));
  await adapter.init();
  mocks.getWorkspaceContext.mockResolvedValue({
    session: { userId: 'u1' },
    workspaceId: WORKSPACE,
    adapter,
  });

  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return dispatch(url, init);
  }));

  setAutoSyncWorkspaceId(WORKSPACE);
  invalidateSyncStatusCache();
  await vfs.init();
});

afterEach(async () => {
  await adapter.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A project whose files do not fit in a single request. */
async function createBigProject(name: string) {
  vi.setSystemTime(CREATED_AT);
  const project = await vfs.createProject(name, 'chunked push fixture');
  await vfs.createFile(project.id, '/one.txt', BIG);
  await vfs.createFile(project.id, '/two.txt', BIG);
  await vfs.createFile(project.id, '/three.txt', BIG);
  await vfs.createFile(project.id, '/note.txt', 'small');
  saveManager.markClean(project.id);
  return project.id;
}

async function push(projectId: string, options?: { delta?: boolean }) {
  const { pushProjectToServer } = await import('../push-project-to-server');
  await pushProjectToServer(projectId, WORKSPACE, options);
}

describe('a project too large for one request', () => {
  it('reaches the server whole, in more than one request', async () => {
    const id = await createBigProject('Big');

    vi.setSystemTime(PUSHED_AT);
    await push(id);

    // More than one POST is the whole point: a single request would be truncated at 10MB and the
    // route would fail parsing it.
    expect(postCount).toBeGreaterThan(1);
    const files = await serverFiles(id);
    expect(files.get('/one.txt')).toBe(BIG);
    expect(files.get('/two.txt')).toBe(BIG);
    expect(files.get('/three.txt')).toBe(BIG);
    expect(files.get('/note.txt')).toBe('small');
    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('does not conflict with itself when pushed a second time', async () => {
    // The trap this fix exists for. The route stores the client's updatedAt, so a batch that wrote
    // the project row would put the server ahead of the client's lastSyncedAt and the next batch
    // would 409 against its own predecessor. Invisible on a first push, because lastSyncedAt is
    // unset then — which is exactly why it needs a test that pushes twice.
    const id = await createBigProject('Twice');
    vi.setSystemTime(PUSHED_AT);
    await push(id);

    vi.setSystemTime(EDITED_AT);
    await vfs.updateFile(id, '/note.txt', 'edited');
    await push(id, { delta: true });

    expect(await serverSyncSays(id)).toBe('synced');
    expect((await serverFiles(id)).get('/note.txt')).toBe('edited');
  });
});

describe('a push that dies part way', () => {
  it('leaves the project un-synced so the retry finishes it', async () => {
    const id = await createBigProject('Interrupted');

    vi.setSystemTime(PUSHED_AT);
    failPostNumber = 2;
    await push(id);

    // Not synced: the client must not record lastSyncedAt for a push that did not finish, or the
    // retry reads as a no-op and the server keeps the half-written project forever.
    expect(await serverSyncSays(id)).not.toBe('synced');

    failPostNumber = null;
    await push(id, { delta: true });

    const files = await serverFiles(id);
    expect(files.get('/one.txt')).toBe(BIG);
    expect(files.get('/two.txt')).toBe(BIG);
    expect(files.get('/three.txt')).toBe(BIG);
    expect(files.get('/note.txt')).toBe('small');
    expect(await serverSyncSays(id)).toBe('synced');
  });

  it('has removed nothing from the server yet', async () => {
    // Deletions ride with the final batch, so an interrupted push is strictly additive: whatever
    // the server had is still there to fall back on. Edits every large file so the retry spans
    // several batches and the failure lands before the one carrying the deletion.
    const id = await createBigProject('Additive');
    vi.setSystemTime(PUSHED_AT);
    await push(id);
    const batchesInAFullPush = postCount;
    expect(batchesInAFullPush).toBeGreaterThan(2);

    vi.setSystemTime(EDITED_AT);
    await vfs.updateFile(id, '/one.txt', BIG + 'edit');
    await vfs.updateFile(id, '/two.txt', BIG + 'edit');
    await vfs.updateFile(id, '/three.txt', BIG + 'edit');
    await vfs.deleteFile(id, '/note.txt');

    postCount = 0;
    failPostNumber = batchesInAFullPush;
    await push(id, { delta: true });

    // Which file lands in which batch depends on the order the VFS returns them, so count rather
    // than name one: some edits landed (earlier batches ran) and not all did (the last did not),
    // and the deletion went with the batch that never ran.
    const after = await serverFiles(id);
    const landed = ['/one.txt', '/two.txt', '/three.txt']
      .filter((filePath) => after.get(filePath) === BIG + 'edit').length;

    expect(after.has('/note.txt')).toBe(true);
    expect(landed).toBeGreaterThan(0);
    expect(landed).toBeLessThan(3);
  });
});

describe('a push whose last response was lost', () => {
  it('is retried rather than reported as a conflict against itself', async () => {
    // The server committed the final batch and the reply never arrived, so the client did not
    // record `lastSyncedAt` and still holds one from an earlier sync. The server's `updatedAt` is
    // now this client's own, which reads as "the server moved on" to a plain timestamp comparison
    // — a conflict with nobody. A long push over a slow link is exactly where a reply gets lost.
    const id = await createBigProject('LostReply');
    vi.setSystemTime(PUSHED_AT);
    await push(id);

    const project = await vfs.getProject(id);
    const beforeThePush = new Date(PUSHED_AT.getTime() - 60_000);
    project.lastSyncedAt = beforeThePush;
    await vfs.updateProject(project, { preserveUpdatedAt: true });

    const result = await getSyncManager(WORKSPACE).pushSingleProject(
      id,
      await vfs.getProject(id),
      await vfs.listFiles(id)
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
});

describe('batchFilesBySize', () => {
  const file = (path: string, content: string) => ({
    id: path, projectId: 'p', path, name: path, type: 'text' as const, mimeType: 'text/plain',
    content, size: content.length, createdAt: new Date(0), updatedAt: new Date(0), metadata: {},
  });

  it('splits on accumulated bytes rather than file count', () => {
    const { batches } = batchFilesBySize(
      [file('/a', 'x'.repeat(600)), file('/b', 'x'.repeat(600)), file('/c', 'x'.repeat(600))],
      1000
    );

    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['/a'], ['/b'], ['/c']]);
  });

  it('fills a batch before starting the next', () => {
    const { batches } = batchFilesBySize(
      [file('/a', 'x'.repeat(100)), file('/b', 'x'.repeat(100)), file('/c', 'x'.repeat(5000))],
      1000
    );

    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['/a', '/b'], ['/c']]);
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // '€' is 1 code unit and 3 bytes. Measuring length would fit three of these in a batch that
    // can only carry one, and the request would be truncated on the wire.
    const wide = file('/a', '€'.repeat(300));
    const { batches } = batchFilesBySize([wide, file('/b', '€'.repeat(300))], 1000);

    expect(batches).toHaveLength(2);
  });

  it('always produces a batch, so metadata and deletions still have one to ride on', () => {
    expect(batchFilesBySize([], 1000).batches).toEqual([[]]);
  });

  it('names a file too large to batch instead of looping on it', () => {
    const { batches, oversized } = batchFilesBySize(
      [file('/huge.bin', 'x'.repeat(5000)), file('/ok.txt', 'x')],
      1000,
      2000
    );

    expect(oversized).toEqual(['/huge.bin']);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['/ok.txt']]);
  });
});

/**
 * The publish path, which reaches the server through /sync/files rather than /sync/projects/{id}.
 * That route clears the project's files before writing them, so only the batch carrying `replace`
 * may do it — a route that cleared on every batch would leave the server holding the last batch
 * alone, and say it succeeded.
 */
describe('publishing a project too large for one request', () => {
  /** What publish does: the project row first, then its files, which is how the FK is satisfied. */
  async function publishPush(projectId: string, options?: { onProgress?: (p: { batch: number; batches: number }) => void }) {
    const project = await vfs.getProject(projectId);
    const result = await getSyncManager(WORKSPACE).pushProjectWithFiles(project, await vfs.listFiles(projectId), options);
    if (typeof result.project?.revision === 'number') {
      project.revision = result.project.revision;
      await vfs.updateProject(project, { preserveUpdatedAt: true });
    }
    return result;
  }

  it('leaves every file on the server, not just the last batch', async () => {
    const id = await createBigProject('Publish');

    const result = await publishPush(id);

    expect(result.success).toBe(true);
    expect(postCount).toBeGreaterThan(2);
    const onServer = await serverFiles(id);
    expect([...onServer.keys()].sort()).toEqual(['/note.txt', '/one.txt', '/three.txt', '/two.txt']);
    expect(onServer.get('/note.txt')).toBe('small');
  });

  it('replaces what the server held rather than adding to it', async () => {
    const id = await createBigProject('Replace');
    expect((await publishPush(id)).success).toBe(true);

    await vfs.deleteFile(id, '/note.txt');
    expect((await publishPush(id)).success).toBe(true);

    // The first batch clears, so a file the project no longer has does not survive the push.
    expect((await serverFiles(id)).has('/note.txt')).toBe(false);
  });

  it('refuses a file too large for any one request before sending anything', async () => {
    const id = await createBigProject('Oversized');
    // Past the VFS's own text limit, so handed to the push directly, as a file synced from
    // elsewhere would be.
    const files = await vfs.listFiles(id);
    const huge = { ...files[0], path: '/huge.txt', name: 'huge.txt', content: 'x'.repeat(25 * 1024 * 1024) };
    const before = postCount;

    const result = await getSyncManager(WORKSPACE).pushProjectWithFiles(await vfs.getProject(id), [...files, huge]);

    expect(result.success).toBe(false);
    expect(postCount).toBe(before);
  });

  it('forwards progress from the files it pushes', async () => {
    const id = await createBigProject('Progress');
    const seen: number[] = [];

    const result = await publishPush(id, { onProgress: ({ batch }) => seen.push(batch) });

    expect(result.success).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('a template too large for one request', () => {
  /**
   * "Create a Template" copies the project's whole file set into the template
   * (`lib/vfs/template-service.ts`), so a template made from a large project runs into the same
   * request body limit. Read back from the database rather than from the response, because what
   * matters is that the server ends up holding every file rather than the last batch alone.
   */
  it('is stored whole, not just its last batch', async () => {
    const files = [
      { path: '/a.txt', content: BIG },
      { path: '/b.txt', content: BIG },
      { path: '/c.txt', content: BIG },
      { path: '/small.txt', content: 'tiny' },
    ];

    const result = await getSyncManager(WORKSPACE).pushTemplate({
      id: 'tmpl-big',
      name: 'Big',
      description: 'made from a large project',
      version: '1.0.0',
      files,
      directories: [],
      metadata: { license: 'personal', tags: [] },
      importedAt: CREATED_AT,
    } as never);

    expect(result.success).toBe(true);
    const stored = await adapter.getCustomTemplate('tmpl-big');
    expect(stored?.files.map((f) => f.path).sort())
      .toEqual(['/a.txt', '/b.txt', '/c.txt', '/small.txt']);
    expect(stored?.files.find((f) => f.path === '/small.txt')?.content).toBe('tiny');
  });
});
