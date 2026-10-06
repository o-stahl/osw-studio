// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';

/**
 * Who owns a project's sync bookkeeping.
 *
 * `lastSyncedAt`, `serverUpdatedAt` and `syncStatus` describe the relationship between this client
 * and the server. They are not project content, and nothing outside the sync layer knows their
 * current values — but `updateProject` took a whole `Project` and wrote every field of it, so any
 * caller holding an older copy rewound them by saving it.
 *
 * The listings do exactly that: `handleProjectUpdate` writes `{...projectFromReactState, ...}`, and
 * that state is loaded once and not refreshed when a background sync lands. Removing a thumbnail
 * therefore replayed a `lastSyncedAt` from before the last push, after which the server's row
 * looked newer than anything this client had seen and the next push came back 409 — reported to the
 * user as "edited on another device", with no other device involved.
 *
 * Same shape as sync-chunked-push.test.ts: the real route, a real database, and assertions on what
 * the user ends up seeing rather than on the wire format.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));

vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { toast } from 'sonner';
import { registerEnglishTranslator } from '@/lib/i18n/__tests__/test-helpers';

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
import { GET as statusGET } from '@/app/api/w/[workspaceId]/sync/status/route';

import { vfs } from '../index';
import { autoSyncProject, invalidateSyncStatusCache, setAutoSyncWorkspaceId } from '../auto-sync';

// The warnings below are matched by their English wording, which the runtime only produces once
// a translator is registered.
registerEnglishTranslator();

const WORKSPACE = 'w1';

let dir: string;
let adapter: SQLiteAdapter;

async function dispatch(rawUrl: string, init?: RequestInit): Promise<Response> {
  const url = new URL(rawUrl, 'http://localhost');
  const match = url.pathname.match(/^\/api\/w\/([^/]+)\/sync\/(.+)$/);
  if (!match) throw new Error(`unrouted request: ${rawUrl}`);
  const [, workspaceId, rest] = match;
  const method = (init?.method ?? 'GET').toUpperCase();
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
  const single = rest.match(/^projects\/([^/?]+)$/);
  if (single) {
    const params = Promise.resolve({ workspaceId, id: single[1] });
    return method === 'POST' ? projectPOST(request, { params }) : projectGET(request, { params });
  }
  throw new Error(`unrouted request: ${rawUrl}`);
}

/** The warning the user sees. Its absence is the thing under test. */
function conflictWarnings(): string[] {
  return (toast.warning as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('edited on another device'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-stale-'));
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

/**
 * A project the server already holds, with a project-level edit pushed after the listing loaded.
 *
 * The second edit has to touch the project row rather than a file: the row's `updatedAt` is what
 * the server compares against, and a file write does not move it. That is also why this is not a
 * contrived case — a rename, a thumbnail or a settings change all move it.
 */
async function syncedWithLaterPush() {
  vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
  const project = await vfs.createProject('React Starter', 'fixture');
  await vfs.createFile(project.id, '/index.html', '<h1>one</h1>');

  vi.setSystemTime(new Date('2026-09-12T10:00:05.000Z'));
  await autoSyncProject(project.id);

  // What a listing loaded at this moment holds, and goes on holding.
  const listingSnapshot = (await vfs.getProject(project.id))!;

  vi.setSystemTime(new Date('2026-09-12T10:00:20.000Z'));
  const current = (await vfs.getProject(project.id))!;
  await vfs.updateProject({ ...current, description: 'edited in the workspace' });
  vi.setSystemTime(new Date('2026-09-12T10:00:25.000Z'));
  await autoSyncProject(project.id);

  return { project, listingSnapshot };
}

describe('a listing writing a project it loaded earlier', () => {
  it('does not report another device when the thumbnail is removed', async () => {
    const { project, listingSnapshot } = await syncedWithLaterPush();

    // Exactly what handleProjectUpdate does for onImageChange, snapshot and all.
    vi.setSystemTime(new Date('2026-09-12T10:00:40.000Z'));
    await vfs.updateProject({ ...listingSnapshot, previewImage: undefined, previewUpdatedAt: undefined });

    vi.setSystemTime(new Date('2026-09-12T10:00:45.000Z'));
    await autoSyncProject(project.id);

    expect(conflictWarnings()).toEqual([]);
  });

  it('does not report another device when a thumbnail is captured', async () => {
    const { project, listingSnapshot } = await syncedWithLaterPush();

    vi.setSystemTime(new Date('2026-09-12T10:00:40.000Z'));
    await vfs.updateProject({
      ...listingSnapshot,
      previewImage: 'data:image/png;base64,AAA',
      previewUpdatedAt: new Date(),
    });

    vi.setSystemTime(new Date('2026-09-12T10:00:45.000Z'));
    await autoSyncProject(project.id);

    expect(conflictWarnings()).toEqual([]);
  });

  it('leaves the project synced rather than in error', async () => {
    const { project, listingSnapshot } = await syncedWithLaterPush();

    vi.setSystemTime(new Date('2026-09-12T10:00:40.000Z'));
    await vfs.updateProject({ ...listingSnapshot, name: 'Renamed from the listing' });
    vi.setSystemTime(new Date('2026-09-12T10:00:45.000Z'));
    await autoSyncProject(project.id);

    const after = (await vfs.getProject(project.id))!;
    expect(after.syncStatus).toBe('synced');
    // The rename reached the server, which is the point of the push.
    const server = await adapter.getProject(project.id);
    expect(server?.name).toBe('Renamed from the listing');
  });

  it('cannot rewind the sync bookkeeping it knows nothing about', async () => {
    const { project, listingSnapshot } = await syncedWithLaterPush();
    const synced = (await vfs.getProject(project.id))!;

    vi.setSystemTime(new Date('2026-09-12T10:00:40.000Z'));
    await vfs.updateProject({ ...listingSnapshot, name: 'Renamed' });

    // The stale copy carried the older stamps; saving it must not have replayed them.
    const after = (await vfs.getProject(project.id))!;
    expect(after.lastSyncedAt?.getTime()).toBe(synced.lastSyncedAt?.getTime());
    expect(after.serverUpdatedAt?.getTime()).toBe(synced.serverUpdatedAt?.getTime());
  });
});

describe('a genuine change from another device', () => {
  it('is still reported', async () => {
    const { project } = await syncedWithLaterPush();

    // Another client pushes: the row moves on without this client's knowledge.
    vi.setSystemTime(new Date('2026-09-12T10:01:00.000Z'));
    const remote = (await adapter.getProject(project.id))!;
    await adapter.updateProject({ ...remote, name: 'Edited elsewhere', updatedAt: new Date() });
    adapter.bumpRevision(project.id, remote.revision ?? 0);

    vi.setSystemTime(new Date('2026-09-12T10:01:10.000Z'));
    await vfs.updateFile(project.id, '/index.html', '<h1>local</h1>');
    await autoSyncProject(project.id, false);

    expect(conflictWarnings()).toHaveLength(1);
  });
});

describe('two pushes for one project', () => {
  /**
   * A regression guard on what the user sees, not a proof of serialisation.
   *
   * Removing the in-flight guard in `autoSyncProject` does not fail this test: two pushes started
   * from the same tick in this harness do not interleave the way they can in a browser, where the
   * second reads the project between the first's request and its write-back. The guard is there
   * because the code always meant to have one — `syncStatus === 'syncing'` was checked and never
   * set — and not because this test caught its absence.
   */
  it('leave the project synced without warning', async () => {
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'));
    const project = await vfs.createProject('Overlapping', 'fixture');
    await vfs.createFile(project.id, '/index.html', '<h1>one</h1>');
    vi.setSystemTime(new Date('2026-09-12T10:00:05.000Z'));
    await autoSyncProject(project.id);

    // A project-level edit, then two pushes started before either finishes — what a debounced
    // sync landing next to an explicit one looks like.
    vi.setSystemTime(new Date('2026-09-12T10:00:20.000Z'));
    const current = (await vfs.getProject(project.id))!;
    await vfs.updateProject({ ...current, description: 'edited' });

    vi.setSystemTime(new Date('2026-09-12T10:00:25.000Z'));
    await Promise.all([autoSyncProject(project.id), autoSyncProject(project.id)]);

    expect(conflictWarnings()).toEqual([]);
    expect((await vfs.getProject(project.id))!.syncStatus).toBe('synced');
  });
});
