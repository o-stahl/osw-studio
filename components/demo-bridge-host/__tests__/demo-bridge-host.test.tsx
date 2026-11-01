// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The demo's end of the bridge answers the listed instance origins, from this browser's demo
 * storage, and nobody else.
 */
const vfs = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  listProjects: vi.fn(async () => [{ id: 'p1', name: 'Site', updatedAt: new Date('2026-10-16T10:00:00Z') }]),
  listFiles: vi.fn(async () => [{ id: 'f1' }, { id: 'f2' }]),
  deleteProject: vi.fn(async () => {}),
}));
const backup = vi.hoisted(() => ({ exportProjects: vi.fn(async () => new Blob(['zip'])) }));
vi.mock('@/lib/vfs', () => ({ vfs }));
vi.mock('@/lib/vfs/backup-service', () => ({ BackupService: backup }));

import { DemoBridgeHost } from '..';
import { BRIDGE_CHANNEL } from '@/lib/demo-bridge/protocol';

const INSTANCE = 'https://inst-1.example.com';
let container: HTMLDivElement;
let root: Root;
/** The instance page the bridge is framed in. */
let parentPage: { postMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Back to the answers above, so a listing one test sets does not carry into the next.
  vi.resetAllMocks();
  parentPage = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { value: parentPage, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<DemoBridgeHost allowedOrigins={[INSTANCE]} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Object.defineProperty(window, 'parent', { value: window, configurable: true });
  document.cookie = 'osws_demo_projects=; path=/; max-age=0';
});

/** Sends a request as `origin` from `asker` (the framing page by default) and returns what came back to it. */
async function ask(data: unknown, origin = INSTANCE, asker: { postMessage: ReturnType<typeof vi.fn> } = parentPage) {
  asker.postMessage.mockClear();
  const event = new MessageEvent('message', { data, origin });
  Object.defineProperty(event, 'source', { value: asker });
  await act(async () => {
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return asker.postMessage.mock.calls;
}

describe('DemoBridgeHost', () => {
  it('tells the page that framed it, once, that it is listening', () => {
    expect(parentPage.postMessage.mock.calls).toEqual([[{ channel: BRIDGE_CHANNEL, ready: true }, '*']]);
  });

  it('lists the demo projects for a listed instance, and replies to it alone', async () => {
    const calls = await ask({ channel: BRIDGE_CHANNEL, id: 'r1', op: 'list' });
    expect(calls).toHaveLength(1);
    const [reply, options] = calls[0];
    expect(options).toEqual({ targetOrigin: INSTANCE });
    expect(reply).toEqual({
      channel: BRIDGE_CHANNEL, id: 'r1', ok: true,
      projects: [{ id: 'p1', name: 'Site', updatedAt: '2026-10-16T10:00:00.000Z', fileCount: 2 }],
    });
  });

  it("says how many projects the demo's own pages counted when this frame finds none (Safari)", async () => {
    vfs.listProjects.mockResolvedValueOnce([]);
    document.cookie = 'osws_demo_projects=2; path=/';
    try {
      const [[unreadable]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r6', op: 'list' });
      expect(unreadable).toMatchObject({ ok: true, projects: [], unreachable: 2 });

      // Projects it can read are the answer, whatever the count says.
      const [[readable]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r7', op: 'list' });
      expect(readable.projects).toHaveLength(1);
      expect(readable).not.toHaveProperty('unreachable');
    } finally {
      document.cookie = 'osws_demo_projects=; path=/; max-age=0';
    }
    vfs.listProjects.mockResolvedValueOnce([]);
    const [[none]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r8', op: 'list' });
    expect(none).not.toHaveProperty('unreachable');
  });

  it('lists the newest first', async () => {
    vfs.listProjects.mockResolvedValueOnce([
      { id: 'old', name: 'Old', updatedAt: new Date('2026-10-01T10:00:00Z') },
      { id: 'new', name: 'New', updatedAt: new Date('2026-10-16T10:00:00Z') },
      { id: 'mid', name: 'Mid', updatedAt: new Date('2026-10-10T10:00:00Z') },
    ]);
    const [[reply]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r5', op: 'list' });
    expect(reply.projects.map((project: { id: string }) => project.id)).toEqual(['new', 'mid', 'old']);
  });

  it('exports and removes the projects it is asked for', async () => {
    vfs.listProjects.mockResolvedValue([
      { id: 'p1', name: 'Site', updatedAt: new Date('2026-10-16T10:00:00Z') },
      { id: 'p2', name: 'Other', updatedAt: new Date('2026-10-15T10:00:00Z') },
    ]);
    const exported = await ask({ channel: BRIDGE_CHANNEL, id: 'r2', op: 'export', projectIds: ['p1'] });
    expect(backup.exportProjects).toHaveBeenCalledWith(['p1']);
    expect(exported[0][0].backup).toBeInstanceOf(Blob);

    const removed = await ask({ channel: BRIDGE_CHANNEL, id: 'r3', op: 'delete', projectIds: ['p1', 'p2'] });
    expect(vfs.deleteProject.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['p1', 'p2']);
    expect(removed[0][0]).toMatchObject({ id: 'r3', ok: true, deleted: 2 });
  });

  it('replies that it failed, and why, when it cannot do what it was asked', async () => {
    backup.exportProjects.mockRejectedValueOnce(new Error('storage locked'));
    const [[reply, options]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r12', op: 'export', projectIds: ['p1'] });
    expect(reply).toEqual({ channel: BRIDGE_CHANNEL, id: 'r12', ok: false, error: 'storage locked' });
    expect(options).toEqual({ targetOrigin: INSTANCE });
  });

  it('says a removal failed, and counts nothing, when one of its projects could not be removed', async () => {
    vfs.deleteProject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('storage locked'));
    const [[reply]] = await ask({ channel: BRIDGE_CHANNEL, id: 'r13', op: 'delete', projectIds: ['p1', 'p2'] });
    expect(reply).toEqual({ channel: BRIDGE_CHANNEL, id: 'r13', ok: false, error: 'storage locked' });
  });

  it("updates the demo's project count when it removes projects it can see, and leaves it where it sees none", async () => {
    document.cookie = 'osws_demo_projects=2; path=/';
    vfs.listProjects
      .mockResolvedValueOnce([{ id: 'p1', name: 'Site', updatedAt: new Date('2026-10-16T10:00:00Z') }])
      .mockResolvedValueOnce([]);
    await ask({ channel: BRIDGE_CHANNEL, id: 'r9', op: 'delete', projectIds: ['p1'] });
    expect(document.cookie).toContain('osws_demo_projects=0');

    // A frame that cannot read the demo's storage (Safari) has nothing to count from.
    document.cookie = 'osws_demo_projects=2; path=/';
    vfs.listProjects.mockResolvedValueOnce([]);
    await ask({ channel: BRIDGE_CHANNEL, id: 'r10', op: 'delete', projectIds: ['p1'] });
    expect(document.cookie).toContain('osws_demo_projects=2');
  });

  it('answers only the page that framed it, from a listed origin', async () => {
    const otherWindow = { postMessage: vi.fn() };
    expect(await ask({ channel: BRIDGE_CHANNEL, id: 'r11', op: 'delete', projectIds: ['p1'] }, INSTANCE, otherWindow)).toEqual([]);
    expect(vfs.deleteProject).not.toHaveBeenCalled();
  });

  it('answers nobody else, not even a published site on an instance', async () => {
    expect(await ask({ channel: BRIDGE_CHANNEL, id: 'r4', op: 'list' }, 'https://my-site.inst-1.example.com')).toEqual([]);
    expect(await ask({ channel: BRIDGE_CHANNEL, id: 'r5', op: 'delete', projectIds: ['p1'] }, 'https://evil.example.com')).toEqual([]);
    expect(vfs.listProjects).not.toHaveBeenCalled();
    expect(vfs.deleteProject).not.toHaveBeenCalled();
  });
});
