// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Background sync while the session is expired: nothing is reported as done, and nothing that
 * runs once per tab is marked done, so the load after signing in finishes the work.
 */

const vfsMock = vi.hoisted(() => ({
  init: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  listFiles: vi.fn(),
  updateProject: vi.fn(),
}));
vi.mock('@/lib/vfs', () => ({ vfs: vfsMock }));
const track = vi.hoisted(() => vi.fn());
vi.mock('@/lib/telemetry', () => ({ track }));
const pushes = vi.hoisted(() => ({
  pushSkill: vi.fn(),
  pushTemplate: vi.fn(),
  pushModelTemplate: vi.fn(),
  pushConnection: vi.fn(),
  pushInterviewTemplate: vi.fn(),
}));
const { pushSkill } = pushes;
vi.mock('@/lib/vfs/sync-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vfs/sync-manager')>()),
  getSyncManager: () => pushes,
}));
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  logger,
}));

import * as autoSync from '@/lib/vfs/auto-sync';
import { clearAuthExpired, getBackendStatus } from '@/lib/api/backend-status';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  vi.stubGlobal('fetch', fetchMock);
  autoSync.setAutoSyncWorkspaceId('ws1');
  autoSync.invalidateSyncStatusCache();
  clearAuthExpired();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  autoSync.setAutoSyncWorkspaceId(undefined);
});

describe('autoPullAllProjects', () => {
  it('leaves the once-per-tab flag unset when the session expires mid-pull', async () => {
    vfsMock.listProjects.mockResolvedValue([]);
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/sync/status')
        ? json({ projects: [{ id: 'p1', updatedAt: new Date().toISOString() }] })
        : json({ error: 'Unauthorized' }, 401));

    const result = await autoSync.autoPullAllProjects();

    expect(result.pulled).toBe(0);
    expect(getBackendStatus().authExpired).toBe(true);
    expect(sessionStorage.getItem('osw_auto_pull_done')).toBeNull();
  });

  it('sets the flag after a pull with a live session', async () => {
    vfsMock.listProjects.mockResolvedValue([]);
    fetchMock.mockResolvedValue(json({ projects: [] }));
    await autoSync.autoPullAllProjects();
    expect(sessionStorage.getItem('osw_auto_pull_done')).toBe('1');
  });
});

describe('autoSyncProject with an expired session', () => {
  it('stops at the manifest 401: no upload, no retry, no "sync failed" mark', async () => {
    vi.useFakeTimers();
    vfsMock.getProject.mockResolvedValue({ id: 'p1', name: 'P', updatedAt: new Date() });
    vfsMock.listFiles.mockResolvedValue([]);
    fetchMock.mockResolvedValue(json({ error: 'Unauthorized' }, 401));

    await autoSync.autoSyncProject('p1');
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/w/ws1/sync/projects/p1?manifest=1');
    expect(vfsMock.updateProject).not.toHaveBeenCalled();
    expect(getBackendStatus().authExpired).toBe(true);
  });
});

describe('autoSyncSkill', () => {
  it('counts a refused push as a failure', async () => {
    pushSkill.mockResolvedValue({ success: false, error: 'Unauthorized' });
    await autoSync.autoSyncSkill({ id: 's1', isBuiltIn: false } as never);
    expect(track).toHaveBeenCalledWith('sync_fail', { item_type: 'skill', direction: 'push' });
  });

  it('does not count an accepted push', async () => {
    pushSkill.mockResolvedValue({ success: true });
    await autoSync.autoSyncSkill({ id: 's1', isBuiltIn: false } as never);
    expect(track).not.toHaveBeenCalled();
  });
});

describe('auto-sync of the other item kinds', () => {
  // A connection is not counted in telemetry; its failure shows only in the log.
  const kinds: [string, () => Promise<void>, keyof typeof pushes, string | null][] = [
    ['autoSyncTemplate', () => autoSync.autoSyncTemplate({ id: 't1' } as never), 'pushTemplate', 'template'],
    ['autoSyncModelTemplate', () => autoSync.autoSyncModelTemplate({ id: 'mt1', builtin: false } as never), 'pushModelTemplate', 'modelTemplate'],
    ['autoSyncInterviewTemplate', () => autoSync.autoSyncInterviewTemplate({ id: 'i1', isBuiltIn: false } as never), 'pushInterviewTemplate', 'interviewTemplate'],
    ['autoSyncConnection', () => autoSync.autoSyncConnection({ id: 'c1', name: 'C', apiKeyRequired: false } as never), 'pushConnection', null],
  ];

  it.each(kinds)('%s counts a refused push as a failure', async (_name, sync, push, itemType) => {
    pushes[push].mockResolvedValue({ success: false, error: 'Unauthorized' });
    await sync();
    expect(pushes[push]).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
    if (itemType) expect(track).toHaveBeenCalledWith('sync_fail', { item_type: itemType, direction: 'push' });
  });

  it.each(kinds)('%s does not count an accepted push', async (_name, sync, push) => {
    pushes[push].mockResolvedValue({ success: true });
    await sync();
    expect(pushes[push]).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});
