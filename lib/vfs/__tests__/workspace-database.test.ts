// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * Which local database the VFS writes to in Server Mode. It is named after the workspace cookie, and
 * the module loads with the first page that imports it, which can be the login page before that
 * cookie exists. Opened then, every project made later in the same page went to the unscoped
 * database: never synced, and gone from the list on the next load.
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name!).sort();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SERVER_MODE', 'true');
  document.cookie = 'osw_workspace=; Path=/; Max-Age=0';
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.cookie = 'osw_workspace=; Path=/; Max-Age=0';
});

describe('the VFS database in Server Mode', () => {
  it('is the workspace selected when it is first opened, not when the module loaded', async () => {
    const { VirtualFileSystem } = await import('@/lib/vfs');
    const vfs = new VirtualFileSystem();
    document.cookie = 'osw_workspace=ws-after-sign-in; Path=/';

    await vfs.init();
    await vfs.createProject('First site');

    const names = await databaseNames();
    expect(names).toContain('osw-studio-ws-after-sign-in');
    expect(names).not.toContain('osw-studio-db');
  });

  it('keeps an adapter it was given', async () => {
    const { VirtualFileSystem } = await import('@/lib/vfs');
    const { IndexedDBAdapter } = await import('@/lib/vfs/adapters/indexeddb-adapter');
    document.cookie = 'osw_workspace=ws-cookie; Path=/';
    const vfs = new VirtualFileSystem(new IndexedDBAdapter('osw-studio-given'));

    await vfs.init();
    await vfs.createProject('Given');

    const names = await databaseNames();
    expect(names).toContain('osw-studio-given');
    expect(names).not.toContain('osw-studio-ws-cookie');
  });
});

describe('the history sweep', () => {
  it('runs once per database and browser', async () => {
    const { VirtualFileSystem } = await import('@/lib/vfs');
    const { IndexedDBAdapter } = await import('@/lib/vfs/adapters/indexeddb-adapter');
    const name = `osw-studio-sweep-${Math.random().toString(36).slice(2)}`;
    const vfs = new VirtualFileSystem(new IndexedDBAdapter(name));
    await vfs.init();
    const db = vfs.getDatabase();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('checkpoints', 'readwrite');
      tx.objectStore('checkpoints').put({ id: 'cp_orphan', projectId: 'deleted-long-ago', timestamp: '' });
      tx.oncomplete = () => resolve();
    });

    expect(await vfs.sweepHistoryOnce()).toBe(1);
    expect(localStorage.getItem(`osw-history-swept:${name}`)).not.toBeNull();
    expect(await vfs.sweepHistoryOnce()).toBeNull();
  });
});
