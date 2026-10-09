import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncManager } from '../sync-manager';

const project = {
  id: 'project-1',
  name: 'Project',
  updatedAt: new Date('2026-07-18T10:00:00.000Z'),
  lastSyncedAt: new Date('2026-07-18T10:00:00.000Z'),
};

const unchangedFile = {
  id: 'file-1', projectId: project.id, path: '/index.html', name: 'index.html', type: 'html' as const,
  content: '<h1>Hi</h1>', mimeType: 'text/html', size: 11, createdAt: new Date('2026-07-18T09:00:00.000Z'),
  updatedAt: new Date('2026-07-18T10:00:00.000Z'), metadata: {},
};

afterEach(() => vi.unstubAllGlobals());

describe('SyncManager.pushProjectDelta', () => {
  it('does not upload a project whose manifest is unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project,
        files: [{ path: '/index.html', updatedAt: unchangedFile.updatedAt, size: unchangedFile.size }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SyncManager().pushProjectDelta(project.id, project as any, [unchangedFile]);

    expect(result).toEqual({ success: true, project });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('?manifest=1');
  });

  it('uploads only changed files and explicit deletions', async () => {
    const changedFile = { ...unchangedFile, path: '/app.js', name: 'app.js', type: 'js' as const, content: 'console.log(1)', size: 14 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          project,
          files: [
            { path: '/index.html', updatedAt: unchangedFile.updatedAt, size: unchangedFile.size },
            { path: '/removed.css', updatedAt: unchangedFile.updatedAt, size: 1 },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ project }) });
    vi.stubGlobal('fetch', fetchMock);

    await new SyncManager().pushProjectDelta(project.id, project as any, [unchangedFile, changedFile]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.partial).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe('/app.js');
    expect(body.deletedPaths).toEqual(['/removed.css']);
  });

  it('sends every file, and deletes nothing, when the project is not on the server yet', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 404, ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ project }) });
    vi.stubGlobal('fetch', fetchMock);

    await new SyncManager().pushProjectDelta(project.id, project as any, [unchangedFile]);

    // Two calls, not three: the 404 manifest is handed to the full push rather than re-fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(['/index.html']);
    expect(body.deletedPaths).toEqual([]);
  });
});

/**
 * The publish flow pushes the whole file set through here (deployments-view -> pushProjectWithFiles
 * -> pushFiles), and the route clears the project's files before writing them. A project too large
 * for one request body was truncated by Next and came back as a JSON parse error, so this batches
 * — and only the first batch may carry the clear, or each batch would delete the one before it.
 */
describe('SyncManager.pushFiles', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const fileAt = (path: string, content: string) => ({
    ...unchangedFile, path, name: path.slice(1), content, size: content.length,
  });

  it('clears the project once, on the first batch only', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 1 }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SyncManager().pushFiles(project.id, [
      fileAt('/a.txt', big), fileAt('/b.txt', big), fileAt('/c.txt', big),
    ] as any);

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map((b) => b.replace)).toEqual([true, ...bodies.slice(1).map(() => false)]);
    // Every file went, exactly once, and the reported count adds up across the batches.
    expect(bodies.flatMap((b) => b.files.map((f: { path: string }) => f.path)).sort())
      .toEqual(['/a.txt', '/b.txt', '/c.txt']);
    expect(result.success).toBe(true);
    expect(result.count).toBe(bodies.length);
  });

  it('stops at the first batch the server rejects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'Storage limit reached' }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SyncManager().pushFiles(project.id, [
      fileAt('/a.txt', big), fileAt('/b.txt', big), fileAt('/c.txt', big),
    ] as any);

    expect(result).toEqual({ success: false, error: 'Storage limit reached' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('SyncManager with an expired session', () => {
  it('raises the session-expired banner on a 401 from the workspace API', async () => {
    const { clearAuthExpired, getBackendStatus } = await import('@/lib/api/backend-status');
    clearAuthExpired();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    ));
    const manager = new SyncManager();
    manager.workspaceId = 'ws1';

    const result = await manager.pushSkill({ id: 's1', name: 's1', content: '' } as any);

    expect(result.success).toBe(false);
    expect(getBackendStatus().authExpired).toBe(true);
  });
});
