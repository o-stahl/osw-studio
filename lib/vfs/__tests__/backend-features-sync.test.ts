// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { SQLiteAdapter } from '@/lib/vfs/adapters/sqlite-adapter';
import type { EdgeFunction, ScheduledFunction, Secret, ServerFunction } from '../types';

/**
 * A project's functions, schedules and secrets live in the browser and on the server, and either
 * side can change them. Real route, real SQLite, real IndexedDB: the assertions are on what each
 * side holds afterwards.
 */

const mocks = vi.hoisted(() => ({ getWorkspaceContext: vi.fn() }));
vi.mock('@/lib/api/workspace-context', () => ({ getWorkspaceContext: mocks.getWorkspaceContext }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

import { GET, POST } from '@/app/api/w/[workspaceId]/sync/backend-features/[projectId]/route';
import { vfs } from '../index';
import { getSyncManager } from '../sync-manager';

const WORKSPACE = 'ws-backend';
const T0 = new Date('2026-11-01T10:00:00.000Z');
const T1 = new Date('2026-11-01T11:00:00.000Z');

let dir: string;
let server: SQLiteAdapter;
let projectId: string;
let failing: 'GET' | 'POST' | null;

const edge = (name: string, code = 'return 1', over: Partial<EdgeFunction> = {}): EdgeFunction => ({
  id: `edge-${name}-${Math.random()}`, projectId, name, code, method: 'GET', enabled: true, timeoutMs: 5000,
  createdAt: T0, updatedAt: T0, ...over,
});
const fn = (name: string): ServerFunction => ({
  id: `fn-${name}-${Math.random()}`, projectId, name, code: 'return 2', enabled: true, createdAt: T0, updatedAt: T0,
});
const secret = (name: string, value?: string): Secret => ({
  id: `secret-${name}-${Math.random()}`, projectId, name, hasValue: Boolean(value), value, createdAt: T0, updatedAt: T0,
});
const schedule = (name: string, functionId: string): ScheduledFunction => ({
  id: `sched-${name}-${Math.random()}`, projectId, name, functionId, cronExpression: '0 8 * * *', timezone: 'UTC', config: {}, enabled: true,
  createdAt: T0, updatedAt: T0,
});

const local = () => vfs.getStorageAdapter() as Required<ReturnType<typeof vfs.getStorageAdapter>>;
const names = (list: { name: string }[]) => list.map(item => item.name).sort();
const sync = () => getSyncManager(WORKSPACE).pullBackendFeatures(projectId);
const pushAll = async () => getSyncManager(WORKSPACE).pushBackendFeatures(projectId, {
  edgeFunctions: await local().listEdgeFunctions(projectId),
  serverFunctions: await local().listServerFunctions(projectId),
  secrets: await local().listSecrets(projectId),
  scheduledFunctions: await local().listScheduledFunctions(projectId),
});

beforeEach(async () => {
  failing = null;
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-backend-'));
  server = new SQLiteAdapter(path.join(dir, 'osws.sqlite'));
  await server.init();
  mocks.getWorkspaceContext.mockResolvedValue({ session: { userId: 'u1' }, workspaceId: WORKSPACE, adapter: server });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (failing === method) return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
    const request = new NextRequest(`http://localhost${url.pathname}`, { method, ...(init?.body ? { body: init.body as string } : {}) });
    const params = Promise.resolve({ workspaceId: WORKSPACE, projectId: url.pathname.split('/').pop()! });
    return method === 'POST' ? POST(request, { params }) : GET(request, { params });
  }));
  await vfs.init();
  projectId = (await vfs.createProject('Backend', 'test')).id;
  await server.createProject({ id: projectId, name: 'Backend', createdAt: T0, updatedAt: T0, settings: {} });
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('syncing backend features around a server run', () => {
  it('keeps what was made in the browser and never pushed, and gives it to the server', async () => {
    const hello = edge('hello');
    await local().createEdgeFunction(hello);
    await local().createServerFunction(fn('helper'));
    await local().createSecret(secret('KEY', 'v1'));
    await local().createScheduledFunction(schedule('daily', hello.id));

    expect((await sync()).success).toBe(true);

    expect(names(await local().listEdgeFunctions(projectId))).toEqual(['hello']);
    expect(names(await local().listServerFunctions(projectId))).toEqual(['helper']);
    expect(await local().listSecrets(projectId)).toEqual([expect.objectContaining({ name: 'KEY', value: 'v1' })]);
    expect(names(await local().listScheduledFunctions(projectId))).toEqual(['daily']);
    expect(names(await server.listEdgeFunctions(projectId))).toEqual(['hello']);
    expect((await server.listSecrets(projectId))[0]).toMatchObject({ name: 'KEY', value: 'v1' });
    expect((await server.listScheduledFunctions(projectId))[0].functionId).toBe((await server.listEdgeFunctions(projectId))[0].id);
  });

  it('keeps an edit made in the browser after the last push', async () => {
    const hello = edge('hello', 'return "old"');
    await local().createEdgeFunction(hello);
    await pushAll();
    await local().updateEdgeFunction({ ...hello, code: 'return "edited"' });

    await sync();

    expect((await local().listEdgeFunctions(projectId))[0].code).toBe('return "edited"');
    expect((await server.listEdgeFunctions(projectId))[0].code).toBe('return "edited"');
  });

  it('keeps both a browser-only function and one a connector added on the server', async () => {
    await local().createEdgeFunction(edge('mine'));
    await server.createEdgeFunction(edge('theirs'));

    await sync();

    expect(names(await local().listEdgeFunctions(projectId))).toEqual(['mine', 'theirs']);
    expect(names(await server.listEdgeFunctions(projectId))).toEqual(['mine', 'theirs']);
  });

  it('takes a server edit of something the browser did not change', async () => {
    const hello = edge('hello', 'return "old"');
    await local().createEdgeFunction(hello);
    await pushAll();
    const [onServer] = await server.listEdgeFunctions(projectId);
    await server.updateEdgeFunction({ ...onServer, code: 'return "server"', updatedAt: T1 });

    await sync();

    expect((await local().listEdgeFunctions(projectId))[0].code).toBe('return "server"');
  });

  it('takes a server edit even when the browser\'s untouched copy carries a later time', async () => {
    const hello = edge('hello', 'return "old"', { updatedAt: T1 });
    await local().createEdgeFunction(hello);
    await pushAll();
    const [onServer] = await server.listEdgeFunctions(projectId);
    await server.updateEdgeFunction({ ...onServer, code: 'return "server"', updatedAt: T0 });

    await sync();

    expect((await local().listEdgeFunctions(projectId))[0].code).toBe('return "server"');
  });

  it('keeps a secret\'s value in the browser when the server\'s copy of the secret wins', async () => {
    const key = secret('KEY', 'v1');
    await local().createSecret(key);
    await pushAll();
    const [onServer] = await server.listSecrets(projectId);
    await server.updateSecret({ ...onServer, description: 'set by a connector', updatedAt: T1 });

    await sync();

    expect(await local().listSecrets(projectId)).toEqual([
      expect.objectContaining({ name: 'KEY', description: 'set by a connector', value: 'v1' }),
    ]);
  });

  it('gives the server the browser\'s value for a secret it holds without one', async () => {
    await server.createSecret(secret('KEY'));
    await local().createSecret(secret('KEY', 'v1'));

    await sync();

    expect((await server.listSecrets(projectId))[0]).toMatchObject({ name: 'KEY', value: 'v1' });
  });

  it('remembers what a pull brought, so deleting it in the browser afterwards stands', async () => {
    await server.createEdgeFunction(edge('theirs'));
    await sync();
    const [pulled] = await local().listEdgeFunctions(projectId);
    await local().deleteEdgeFunction(pulled.id);

    await sync();

    expect(await local().listEdgeFunctions(projectId)).toEqual([]);
    expect(await server.listEdgeFunctions(projectId)).toEqual([]);
  });

  it('drops a schedule whose function neither side has', async () => {
    await local().createScheduledFunction(schedule('daily', 'edge-gone'));

    expect((await sync()).success).toBe(true);

    expect(await local().listScheduledFunctions(projectId)).toEqual([]);
    expect(await server.listScheduledFunctions(projectId)).toEqual([]);
  });

  it('honours a deletion on either side once both have held the item', async () => {
    const gone = edge('deleted-on-server');
    const dropped = edge('deleted-in-browser');
    await local().createEdgeFunction(gone);
    await local().createEdgeFunction(dropped);
    await pushAll();
    await server.deleteEdgeFunction(gone.id);
    await local().deleteEdgeFunction(dropped.id);

    await sync();

    expect(await local().listEdgeFunctions(projectId)).toEqual([]);
    expect(await server.listEdgeFunctions(projectId)).toEqual([]);
  });

  it('treats one name on both sides as one function, repointing a schedule at the survivor', async () => {
    const mine = edge('hello', 'return 1', { updatedAt: T0 });
    await local().createEdgeFunction(mine);
    await local().createScheduledFunction(schedule('daily', mine.id));
    await server.createEdgeFunction(edge('hello', 'return 2', { updatedAt: T1 }));

    expect((await sync()).success).toBe(true);

    const [kept] = await local().listEdgeFunctions(projectId);
    expect(kept.code).toBe('return 2');
    expect((await local().listScheduledFunctions(projectId))[0].functionId).toBe(kept.id);
    expect((await server.listScheduledFunctions(projectId))[0].functionId).toBe(kept.id);
  });

  it('loses nothing when the server cannot be read or written, and sends it on the next sync', async () => {
    await local().createEdgeFunction(edge('mine'));

    failing = 'GET';
    expect((await sync()).success).toBe(false);
    expect(names(await local().listEdgeFunctions(projectId))).toEqual(['mine']);

    failing = 'POST';
    expect((await sync()).success).toBe(false);
    expect(names(await local().listEdgeFunctions(projectId))).toEqual(['mine']);

    failing = null;
    expect((await sync()).success).toBe(true);
    expect(names(await server.listEdgeFunctions(projectId))).toEqual(['mine']);
  });
});
