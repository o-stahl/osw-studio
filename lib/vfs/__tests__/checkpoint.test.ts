import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { compareFiles, indexFiles } from '../checkpoint-changes';

// ── Mocks ──────────────────────────────────────────────────────────────

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const DB_NAME = 'osw-studio-test';
const DB_VERSION = 1;
let testDb: IDBDatabase;

async function openTestDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('checkpoints')) {
        const store = db.createObjectStore('checkpoints', { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // As the app's own database has it since v9: each checkpoint's metadata, without its files.
      if (!db.objectStoreNames.contains('checkpointMeta')) {
        db.createObjectStore('checkpointMeta', { keyPath: 'id' }).createIndex('projectId', 'projectId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// In-memory file system for tests
let projectFiles: { path: string; content: string | ArrayBuffer }[] = [];
let deletedFiles: string[] = [];
let deletedDirs: string[] = [];
let createdDirs: string[] = [];
let createdFiles: { path: string; content: string | ArrayBuffer }[] = [];
let updatedFiles: { path: string; content: string | ArrayBuffer }[] = [];

// Backend features live on the storage adapter, not the VFS. These tests are about files, so the
// adapter here holds nothing: captureBackend still runs, and an empty snapshot is what it records.
// checkpoint-backend.test.ts is where a populated one is exercised.
const emptyBackendAdapter = {
  listEdgeFunctions: async () => [],
  listServerFunctions: async () => [],
  listSecrets: async () => [],
  listScheduledFunctions: async () => [],
};

const mockVfs = {
  init: vi.fn().mockResolvedValue(undefined),
  getDatabase: () => testDb,
  getStorageAdapter: () => emptyBackendAdapter,
  getProject: vi.fn().mockImplementation(async (id: string) => ({ id, name: id, settings: {} })),
  updateProject: vi.fn().mockResolvedValue(undefined),
  listDirectory: vi.fn().mockImplementation(async () => projectFiles),
  readFile: vi.fn().mockImplementation(async (_pid: string, path: string) => {
    const f = projectFiles.find(f => f.path === path);
    if (!f) throw new Error(`File not found: ${path}`);
    return { path: f.path, content: f.content };
  }),
  deleteFile: vi.fn().mockImplementation(async (_pid: string, path: string) => {
    deletedFiles.push(path);
  }),
  deleteDirectory: vi.fn().mockImplementation(async (_pid: string, path: string) => {
    deletedDirs.push(path);
  }),
  createDirectory: vi.fn().mockImplementation(async (_pid: string, path: string) => {
    createdDirs.push(path);
  }),
  createFile: vi.fn().mockImplementation(async (_pid: string, path: string, content: string | ArrayBuffer) => {
    createdFiles.push({ path, content });
  }),
  updateFile: vi.fn().mockImplementation(async (_pid: string, path: string, content: string | ArrayBuffer) => {
    updatedFiles.push({ path, content });
  }),
  scheduleAutoSync: vi.fn(),
};

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => mockVfs,
  vfs: mockVfs,
}));

vi.mock('@/lib/vfs/adapters/indexeddb-adapter', () => ({
  IndexedDBAdapter: class {},
}));

// The browser's settings, which hold how many unpinned checkpoints a project keeps.
const settings = vi.hoisted(() => ({ value: {} as { checkpointsKept?: number; savesKept?: number } }));
vi.mock('@/lib/config/storage', () => ({ configManager: { getSettings: () => settings.value } }));

// ── Helpers ────────────────────────────────────────────────────────────

function setProjectFiles(files: { path: string; content: string }[]) {
  projectFiles = files.map(f => ({ path: f.path, content: f.content }));
}

function resetTrackingArrays() {
  deletedFiles = [];
  deletedDirs = [];
  createdDirs = [];
  createdFiles = [];
  updatedFiles = [];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('CheckpointManager', () => {
  let checkpointManager: Awaited<typeof import('../checkpoint')>['checkpointManager'];

  beforeEach(async () => {
    // Fresh IndexedDB per test
    globalThis.indexedDB = new IDBFactory();
    testDb = await openTestDB();

    // Reset file tracking
    setProjectFiles([]);
    resetTrackingArrays();
    vi.clearAllMocks();

    // Fresh module instance per test (new CheckpointManager singleton)
    vi.resetModules();
    const mod = await import('../checkpoint');
    checkpointManager = mod.checkpointManager;
  });

  afterEach(() => {
    if (testDb) testDb.close();
    settings.value = {};
  });

  // ── createCheckpoint ───────────────────────────────────────────────

  describe('createCheckpoint', () => {
    it('captures files and directories from VFS', async () => {
      setProjectFiles([
        { path: '/index.html', content: '<h1>Hello</h1>' },
        { path: '/css/style.css', content: 'body {}' },
      ]);

      const cp = await checkpointManager.createCheckpoint('proj1', 'Initial');

      expect(cp.id).toMatch(/^cp_/);
      expect(cp.projectId).toBe('proj1');
      expect(cp.description).toBe('Initial');
      expect(cp.kind).toBe('auto');
      expect(cp.files.size).toBe(2);
      expect(cp.files.get('/index.html')).toBe('<h1>Hello</h1>');
      expect(cp.files.get('/css/style.css')).toBe('body {}');
      expect(cp.directories.has('/css')).toBe(true);
    });

    it('uses manual kind when specified', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      const cp = await checkpointManager.createCheckpoint('proj1', 'Save', { kind: 'manual' });

      expect(cp.kind).toBe('manual');
    });

    it('stores baseRevisionId when provided', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      const cp = await checkpointManager.createCheckpoint('proj1', 'After task', {
        baseRevisionId: 'cp_previous',
      });

      expect(cp.baseRevisionId).toBe('cp_previous');
    });

    // The panel translates `label` and falls back to `description`, so a label that did not survive
    // the store would show the English silently.
    it('keeps a label across a reload from storage', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'Before import: Site', {
        kind: 'manual',
        label: { key: 'beforeImport', values: { name: 'Site' } },
      });

      vi.resetModules();
      const reloaded = (await import('../checkpoint')).checkpointManager;
      const [listed] = await reloaded.getCheckpoints('proj1');

      expect(listed.label).toEqual({ key: 'beforeImport', values: { name: 'Site' } });
      expect(listed.description).toBe('Before import: Site');
    });

    it('lists a label straight after create, before any reload', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'Pre-generation snapshot', {
        kind: 'auto',
        label: { key: 'preGeneration' },
      });

      const [listed] = await checkpointManager.getCheckpoints('proj1');
      expect(listed.label).toEqual({ key: 'preGeneration' });
    });

    // Pinning reads the whole stored checkpoint and writes it back; the label has to ride along.
    it('keeps a label through a pin and a reload', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Before import: Site', {
        kind: 'manual',
        label: { key: 'beforeImport', values: { name: 'Site' } },
      });
      expect(await checkpointManager.pinCheckpoint(cp.id)).toBe(true);

      vi.resetModules();
      const reloaded = (await import('../checkpoint')).checkpointManager;
      const [listed] = await reloaded.getCheckpoints('proj1');

      expect(listed.pinned).toBe(true);
      expect(listed.label).toEqual({ key: 'beforeImport', values: { name: 'Site' } });
    });

    it('captures nested directory structure', async () => {
      setProjectFiles([
        { path: '/src/components/ui/Button.tsx', content: 'export default ...' },
      ]);

      const cp = await checkpointManager.createCheckpoint('proj1', 'Nested');

      expect(cp.directories.has('/src')).toBe(true);
      expect(cp.directories.has('/src/components')).toBe(true);
      expect(cp.directories.has('/src/components/ui')).toBe(true);
    });

    it('produces distinct IDs for checkpoints created in the same millisecond', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      const now = 1700000000000;
      const origDateNow = Date.now;
      Date.now = () => now;

      try {
        const cp1 = await checkpointManager.createCheckpoint('proj1', 'First');
        const cp2 = await checkpointManager.createCheckpoint('proj1', 'Second');

        expect(cp1.id).not.toBe(cp2.id);
        // Both should start with cp_ prefix and contain the same timestamp
        expect(cp1.id).toMatch(/^cp_1700000000000_/);
        expect(cp2.id).toMatch(/^cp_1700000000000_/);
      } finally {
        Date.now = origDateNow;
      }
    });
  });

  // ── getCheckpoints ─────────────────────────────────────────────────

  describe('getCheckpoints', () => {
    it('returns checkpoints for the specified project only', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'CP1');
      await checkpointManager.createCheckpoint('proj2', 'CP2');

      const proj1Checkpoints = await checkpointManager.getCheckpoints('proj1');
      const proj2Checkpoints = await checkpointManager.getCheckpoints('proj2');

      expect(proj1Checkpoints).toHaveLength(1);
      expect(proj1Checkpoints[0].description).toBe('CP1');
      expect(proj2Checkpoints).toHaveLength(1);
      expect(proj2Checkpoints[0].description).toBe('CP2');
    });

    it('returns checkpoints sorted newest-first', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'v1' }]);
      await checkpointManager.createCheckpoint('proj1', 'First');
      // Small delay so timestamps differ
      await new Promise(r => setTimeout(r, 10));
      setProjectFiles([{ path: '/a.txt', content: 'v2' }]);
      await checkpointManager.createCheckpoint('proj1', 'Second');

      const cps = await checkpointManager.getCheckpoints('proj1');

      expect(cps).toHaveLength(2);
      expect(cps[0].description).toBe('Second');
      expect(cps[1].description).toBe('First');
    });

    it('returns empty array for project with no checkpoints', async () => {
      const cps = await checkpointManager.getCheckpoints('nonexistent');

      expect(cps).toEqual([]);
    });
  });

  // ── checkpointExists ───────────────────────────────────────────────

  describe('checkpointExists', () => {
    it('returns true for existing checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Test');

      expect(await checkpointManager.checkpointExists(cp.id)).toBe(true);
    });

    it('returns false for non-existent checkpoint', async () => {
      expect(await checkpointManager.checkpointExists('cp_99999')).toBe(false);
    });

    it('returns false for invalid inputs', async () => {
      expect(await checkpointManager.checkpointExists('')).toBe(false);
      expect(await checkpointManager.checkpointExists(null as unknown as string)).toBe(false);
      expect(await checkpointManager.checkpointExists(undefined as unknown as string)).toBe(false);
    });
  });

  // ── restoreCheckpoint ──────────────────────────────────────────────

  describe('restoreCheckpoint', () => {
    it('restores files from checkpoint to VFS', async () => {
      setProjectFiles([
        { path: '/index.html', content: '<h1>Original</h1>' },
        { path: '/style.css', content: 'body {}' },
      ]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Snapshot');

      // Simulate files changing after checkpoint
      setProjectFiles([
        { path: '/index.html', content: '<h1>Modified</h1>' },
        { path: '/style.css', content: 'body { color: red; }' },
      ]);
      resetTrackingArrays();

      const result = await checkpointManager.restoreCheckpoint(cp.id);

      expect(result).toBe(true);
      // Files that exist in both current and checkpoint get updated
      expect(updatedFiles).toHaveLength(2);
      expect(updatedFiles.find(f => f.path === '/index.html')?.content).toBe('<h1>Original</h1>');
    });

    it('deletes files not in checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Snapshot');

      // New file appeared after checkpoint
      setProjectFiles([
        { path: '/a.txt', content: 'a' },
        { path: '/new-file.txt', content: 'new' },
      ]);
      resetTrackingArrays();

      await checkpointManager.restoreCheckpoint(cp.id);

      expect(deletedFiles).toContain('/new-file.txt');
    });

    it('creates files missing from current state', async () => {
      setProjectFiles([
        { path: '/a.txt', content: 'a' },
        { path: '/b.txt', content: 'b' },
      ]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Snapshot');

      // File was deleted after checkpoint
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      resetTrackingArrays();

      await checkpointManager.restoreCheckpoint(cp.id);

      expect(createdFiles.find(f => f.path === '/b.txt')?.content).toBe('b');
    });

    it('returns false for non-existent checkpoint', async () => {
      const result = await checkpointManager.restoreCheckpoint('cp_nonexistent');

      expect(result).toBe(false);
    });

    it('rejects invalid checkpoint ID formats', async () => {
      expect(await checkpointManager.restoreCheckpoint('')).toBe(false);
      expect(await checkpointManager.restoreCheckpoint('bad_id')).toBe(false);
      expect(await checkpointManager.restoreCheckpoint('cp_')).toBe(false);
      expect(await checkpointManager.restoreCheckpoint(123 as unknown as string)).toBe(false);
    });

    it('uses silent mode for file writes during restore', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Snapshot');

      setProjectFiles([{ path: '/a.txt', content: 'changed' }]);
      resetTrackingArrays();

      await checkpointManager.restoreCheckpoint(cp.id);

      // updateFile should be called with silent: true
      expect(mockVfs.updateFile).toHaveBeenCalledWith(
        'proj1', '/a.txt', 'a', { silent: true }
      );
    });

    it('dispatches filesChanged event after restore', async () => {
      // Provide a minimal window mock for this test
      const dispatched: Event[] = [];
      globalThis.window = { dispatchEvent: (e: Event) => { dispatched.push(e); return true; } } as unknown as Window & typeof globalThis;

      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Snapshot');
      resetTrackingArrays();

      await checkpointManager.restoreCheckpoint(cp.id);

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].type).toBe('filesChanged');

      // @ts-expect-error — cleanup global
      delete globalThis.window;
    });
  });

  // ── Pruning ────────────────────────────────────────────────────────

  describe('pruning', () => {
    it('keeps 10 unpinned checkpoints per project by default, the newest', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      for (let i = 0; i < 13; i++) {
        await new Promise(r => setTimeout(r, 2));
        await checkpointManager.createCheckpoint('proj1', `CP${i}`);
      }

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(10);
      expect(cps[0].description).toBe('CP12');
      expect(cps[9].description).toBe('CP3');
    });

    it('keeps the number chosen in settings', async () => {
      settings.value = { checkpointsKept: 5 };
      try {
        setProjectFiles([{ path: '/a.txt', content: 'a' }]);
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 2));
          await checkpointManager.createCheckpoint('proj1', `CP${i}`);
        }
        const cps = await checkpointManager.getCheckpoints('proj1');
        expect(cps).toHaveLength(5);
        expect(cps[4].description).toBe('CP3');
      } finally {
        settings.value = {};
      }
    });

    it('falls back to the default for a number it does not offer', async () => {
      const { unpinnedLimit } = await import('../checkpoint');
      settings.value = { checkpointsKept: 3 };
      expect(unpinnedLimit()).toBe(10);
      settings.value = { checkpointsKept: 50 };
      expect(unpinnedLimit()).toBe(50);
      settings.value = {};
    });

    it('does not prune a checkpoint pinned at create', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      const saved = await checkpointManager.createCheckpoint('proj1', 'Manual save', { kind: 'manual', pinned: true });

      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5));
        await checkpointManager.createCheckpoint('proj1', `CP${i}`);
      }

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps.find(c => c.id === saved.id)?.pinned).toBe(true);
      expect(cps.find(c => c.description === 'Manual save')).toBeDefined();
    });

    // Discard Changes goes back to the project's last save. Before the first Save that is the
    // unpinned "Project opened" checkpoint, and two runs used to prune it, leaving Discard nothing.
    it('does not prune the checkpoint the project records as its last save', async () => {
      settings.value = { checkpointsKept: 5 };
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const opened = await checkpointManager.createCheckpoint('proj1', 'Project opened');
      mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {}, lastSavedCheckpointId: opened.id }));
      try {
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 5));
          await checkpointManager.createCheckpoint('proj1', `CP${i}`);
        }
        const cps = await checkpointManager.getCheckpoints('proj1');
        expect(cps.map(c => c.id)).toContain(opened.id);
        // The cap still holds for the rest.
        expect(cps.filter(c => c.id !== opened.id)).toHaveLength(5);
      } finally {
        mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {} }));
      }
    });

    it('does not prune pinned checkpoints', async () => {
      settings.value = { checkpointsKept: 5 };
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      const pinned = await checkpointManager.createCheckpoint('proj1', 'Pinned');
      await checkpointManager.pinCheckpoint(pinned.id);

      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5));
        await checkpointManager.createCheckpoint('proj1', `CP${i}`);
      }

      const cps = await checkpointManager.getCheckpoints('proj1');
      // 1 pinned + 5 unpinned
      expect(cps).toHaveLength(6);
      expect(cps.find(c => c.description === 'Pinned')).toBeDefined();
    });

    /**
     * Saves (Save, and the checkpoint before an import) are counted apart from automatic ones, so a
     * run of agent turns never pushes out a save, and the project's latest save is kept on top.
     */
    describe('saves', () => {
      const wait = () => new Promise(r => setTimeout(r, 3));
      const make = async (description: string, kind: 'manual' | 'auto' = 'auto') => {
        await wait();
        return checkpointManager.createCheckpoint('proj1', description, { kind });
      };
      afterEach(() => {
        settings.value = {};
        mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {} }));
      });

      it('are never pushed out by automatic checkpoints', async () => {
        settings.value = { checkpointsKept: 5, savesKept: 3 };
        setProjectFiles([{ path: '/a.txt', content: 'a' }]);
        await make('Save 1', 'manual');
        await make('Save 2', 'manual');
        for (let i = 0; i < 12; i++) await make(`Run ${i}`);

        const cps = await checkpointManager.getCheckpoints('proj1');
        expect(cps.filter(c => c.kind === 'manual').map(c => c.description)).toEqual(['Save 2', 'Save 1']);
        expect(cps.filter(c => c.kind !== 'manual')).toHaveLength(5);
      });

      it('keep the number chosen for saves, besides the latest save', async () => {
        settings.value = { checkpointsKept: 5, savesKept: 3 };
        setProjectFiles([{ path: '/a.txt', content: 'a' }]);
        const saves: { id: string }[] = [];
        for (let i = 1; i <= 5; i++) saves.push(await make(`Save ${i}`, 'manual'));
        mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {}, lastSavedCheckpointId: saves[4].id }));
        await make('Before import: site.zip', 'manual');

        const kept = (await checkpointManager.getCheckpoints('proj1')).map(c => c.description);
        // The latest save, plus the three newest other saves; the import counts as one of them.
        expect(kept).toEqual(['Before import: site.zip', 'Save 5', 'Save 4', 'Save 3']);
      });

      it('do not take room from automatic checkpoints', async () => {
        settings.value = { checkpointsKept: 5, savesKept: 20 };
        setProjectFiles([{ path: '/a.txt', content: 'a' }]);
        for (let i = 0; i < 6; i++) await make(`Save ${i}`, 'manual');
        for (let i = 0; i < 6; i++) await make(`Run ${i}`);

        const cps = await checkpointManager.getCheckpoints('proj1');
        expect(cps.filter(c => c.kind === 'manual')).toHaveLength(6);
        expect(cps.filter(c => c.kind !== 'manual').map(c => c.description)).toEqual(['Run 5', 'Run 4', 'Run 3', 'Run 2', 'Run 1']);
      });

      it('fall back to 5 for a number not offered', async () => {
        const { savesLimit } = await import('../checkpoint');
        settings.value = { savesKept: 7 };
        expect(savesLimit()).toBe(5);
        settings.value = { savesKept: 3 };
        expect(savesLimit()).toBe(3);
      });
    });

    it('does not prune across projects', async () => {
      settings.value = { checkpointsKept: 5 };
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5));
        await checkpointManager.createCheckpoint('proj1', `P1-${i}`);
      }
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 5));
        await checkpointManager.createCheckpoint('proj2', `P2-${i}`);
      }

      expect(await checkpointManager.getCheckpoints('proj1')).toHaveLength(5);
      expect(await checkpointManager.getCheckpoints('proj2')).toHaveLength(3);
    });
  });

  // ── Pin / Unpin ────────────────────────────────────────────────────

  /**
   * An earlier Save pinned each save until the next one, with no record of who pinned it. The next
   * Save takes that pin off; a pin the person made stays, or keeping a version is impossible.
   */
  describe('a save an earlier Save pinned', () => {
    async function aSave() {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      return checkpointManager.createCheckpoint('proj1', 'Manual save', { kind: 'manual', pinned: true });
    }

    it('is unpinned when the next Save comes', async () => {
      const save = await aSave();
      await checkpointManager.releaseSavePin(save.id);
      expect((await checkpointManager.getCheckpoints('proj1'))[0].pinned).toBe(false);
    });

    it('stays pinned through the next Save once the person pins it', async () => {
      const save = await aSave();
      await checkpointManager.pinCheckpoint(save.id);
      await checkpointManager.releaseSavePin(save.id);
      const [cp] = await checkpointManager.getCheckpoints('proj1');
      expect(cp.pinned).toBe(true);
      expect(cp.pinnedBy).toBe('user');
    });

    it('remembers who pinned it in a new page', async () => {
      const save = await aSave();
      await checkpointManager.pinCheckpoint(save.id);
      vi.resetModules();
      const page = (await import('../checkpoint')).checkpointManager;
      expect((await page.getCheckpoints('proj1'))[0].pinnedBy).toBe('user');
    });

    it('forgets who pinned it once unpinned', async () => {
      const save = await aSave();
      await checkpointManager.pinCheckpoint(save.id);
      await checkpointManager.unpinCheckpoint(save.id);
      const [cp] = await checkpointManager.getCheckpoints('proj1');
      expect(cp.pinned).toBe(false);
      expect(cp.pinnedBy).toBeUndefined();
    });
  });

  /**
   * IndexedDB returns a record whole, so listing checkpoints from their own store read every
   * project file copy they hold: tens of megabytes at the higher limits. The list comes from a
   * store of metadata instead, and the snapshot is read only to restore.
   */
  describe('the metadata store', () => {
    const putRaw = (store: string, record: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const tx = testDb.transaction(store, 'readwrite');
      tx.objectStore(store).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const keysOf = (store: string) => new Promise<IDBValidKey[]>((resolve) => {
      const request = testDb.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result);
    });

    it('lists a project\'s checkpoints without reading their snapshots', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'One');
      vi.resetModules();
      const page = (await import('../checkpoint')).checkpointManager;
      const { IDBIndex, IDBObjectStore } = await import('fake-indexeddb');
      const indexReads = vi.spyOn(IDBIndex.prototype, 'getAll');
      const storeGets = vi.spyOn(IDBObjectStore.prototype, 'get');

      expect((await page.getCheckpoints('proj1')).map(c => c.description)).toEqual(['One']);

      const snapshotReads = [...indexReads.mock.contexts, ...storeGets.mock.contexts]
        .filter((ctx) => ((ctx as IDBIndex).objectStore ?? ctx as IDBObjectStore).name === 'checkpoints');
      expect(snapshotReads).toHaveLength(0);
      indexReads.mockRestore();
      storeGets.mockRestore();
    });

    it('lists a checkpoint written before the store existed, and gives it metadata', async () => {
      await putRaw('checkpoints', {
        id: 'cp_1_0', projectId: 'proj1', timestamp: '2026-11-01T00:00:00.000Z', description: 'From an older version',
        kind: 'auto', pinned: true, files: [], directories: [],
      });

      const [cp] = await checkpointManager.getCheckpoints('proj1');
      expect(cp).toMatchObject({ id: 'cp_1_0', description: 'From an older version', pinned: true });
      expect(await keysOf('checkpointMeta')).toEqual(['cp_1_0']);
    });

    it('does not list metadata whose checkpoint is gone', async () => {
      await putRaw('checkpointMeta', { id: 'cp_2_0', projectId: 'proj1', timestamp: '2026-11-01T00:00:00.000Z', description: 'Stale', kind: 'auto' });

      expect(await checkpointManager.getCheckpoints('proj1')).toEqual([]);
      expect(await keysOf('checkpointMeta')).toEqual([]);
    });

    it('keeps the metadata in step with a pin, a name and a delete', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const a = await checkpointManager.createCheckpoint('proj1', 'A');
      await new Promise(r => setTimeout(r, 2));
      const b = await checkpointManager.createCheckpoint('proj1', 'B');
      await checkpointManager.pinCheckpoint(a.id);
      await checkpointManager.renameCheckpoint(a.id, 'Named');
      await checkpointManager.deleteCheckpoint(b.id);
      expect(await keysOf('checkpointMeta')).toEqual([a.id]);

      vi.resetModules();
      const page = (await import('../checkpoint')).checkpointManager;
      expect(await page.getCheckpoints('proj1')).toMatchObject([{ id: a.id, description: 'Named', pinned: true, pinnedBy: 'user' }]);
      expect(await keysOf('checkpointMeta')).toEqual([a.id]);
    });
  });

  describe('naming a checkpoint', () => {
    it('shows the name as typed, in place of the app\'s own label, and keeps it', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Pre-generation snapshot', { label: { key: 'preGeneration' } });

      expect(await checkpointManager.renameCheckpoint(cp.id, '  v1.0 Stable Release  ')).toBe(true);

      const [named] = await checkpointManager.getCheckpoints('proj1');
      expect(named.description).toBe('v1.0 Stable Release');
      expect(named.label).toBeUndefined();
      expect(named.pinned).toBe(true);
      expect(named.pinnedBy).toBe('user');
    });

    it('keeps the name in a new page', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Project opened', { label: { key: 'projectOpened' } });
      await checkpointManager.renameCheckpoint(cp.id, 'Before the redesign');
      vi.resetModules();
      const page = (await import('../checkpoint')).checkpointManager;
      const [named] = await page.getCheckpoints('proj1');
      expect(named.description).toBe('Before the redesign');
      expect(named.label).toBeUndefined();
    });

    it('refuses a blank name and leaves the checkpoint as it was', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Project opened', { label: { key: 'projectOpened' } });
      expect(await checkpointManager.renameCheckpoint(cp.id, '   ')).toBe(false);
      const [same] = await checkpointManager.getCheckpoints('proj1');
      expect(same.label).toEqual({ key: 'projectOpened' });
      expect(same.pinned).toBe(false);
    });

    it('keeps a named save through the next Save', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const save = await checkpointManager.createCheckpoint('proj1', 'Manual save', { kind: 'manual', pinned: true });
      await checkpointManager.renameCheckpoint(save.id, 'v1.1 search');
      await checkpointManager.releaseSavePin(save.id);
      expect((await checkpointManager.getCheckpoints('proj1'))[0].pinned).toBe(true);
    });
  });

  describe('deleting a checkpoint', () => {
    it('removes it from the list and from storage', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const a = await checkpointManager.createCheckpoint('proj1', 'A');
      await new Promise(r => setTimeout(r, 2));
      const b = await checkpointManager.createCheckpoint('proj1', 'B');

      expect(await checkpointManager.deleteCheckpoint(a.id)).toBe(true);

      expect((await checkpointManager.getCheckpoints('proj1')).map(c => c.id)).toEqual([b.id]);
      expect(await checkpointManager.checkpointExists(a.id)).toBe(false);
      vi.resetModules();
      const page = (await import('../checkpoint')).checkpointManager;
      expect((await page.getCheckpoints('proj1')).map(c => c.id)).toEqual([b.id]);
    });

    it('deletes a pinned one too', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const kept = await checkpointManager.createCheckpoint('proj1', 'Kept');
      await checkpointManager.pinCheckpoint(kept.id);
      expect(await checkpointManager.deleteCheckpoint(kept.id)).toBe(true);
      expect(await checkpointManager.getCheckpoints('proj1')).toEqual([]);
    });

    // Discard Changes goes back to the project's last save.
    it('refuses the project\'s current save', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const save = await checkpointManager.createCheckpoint('proj1', 'Manual save', { kind: 'manual' });
      mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {}, lastSavedCheckpointId: save.id }));
      try {
        expect(await checkpointManager.deleteCheckpoint(save.id)).toBe(false);
        expect(await checkpointManager.checkpointExists(save.id)).toBe(true);
      } finally {
        mockVfs.getProject.mockImplementation(async (id: string) => ({ id, name: id, settings: {} }));
      }
    });

    it('forgets it as the current checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Latest');
      expect(checkpointManager.getCurrentCheckpoint()?.id).toBe(cp.id);
      await checkpointManager.deleteCheckpoint(cp.id);
      expect(checkpointManager.getCurrentCheckpoint()).toBeNull();
    });
  });

  describe('pin / unpin', () => {
    it('pins a checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Test');

      const result = await checkpointManager.pinCheckpoint(cp.id);

      expect(result).toBe(true);
      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps[0].pinned).toBe(true);
    });

    it('unpins a checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Test');

      await checkpointManager.pinCheckpoint(cp.id);
      const result = await checkpointManager.unpinCheckpoint(cp.id);

      expect(result).toBe(true);
      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps[0].pinned).toBe(false);
    });

    it('returns false when pinning non-existent checkpoint', async () => {
      const result = await checkpointManager.pinCheckpoint('cp_nonexistent');

      expect(result).toBe(false);
    });
  });

  // ── clearCheckpoints ───────────────────────────────────────────────

  describe('clearCheckpoints', () => {
    it('clears unpinned checkpoints for a project', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'CP1');
      await checkpointManager.createCheckpoint('proj1', 'CP2');

      await checkpointManager.clearCheckpoints('proj1');

      expect(await checkpointManager.getCheckpoints('proj1')).toHaveLength(0);
    });

    it('preserves pinned checkpoints during clear', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'Keep');
      await checkpointManager.pinCheckpoint(cp.id);
      await checkpointManager.createCheckpoint('proj1', 'Discard');

      await checkpointManager.clearCheckpoints('proj1');

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(1);
      expect(cps[0].description).toBe('Keep');
    });
  });

  // ── clearAutoCheckpoints ───────────────────────────────────────────

  describe('clearAutoCheckpoints', () => {
    it('clears only auto checkpoints', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'Auto1');
      await checkpointManager.createCheckpoint('proj1', 'Manual1', { kind: 'manual' });
      await checkpointManager.createCheckpoint('proj1', 'Auto2');

      await checkpointManager.clearAutoCheckpoints('proj1');

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(1);
      expect(cps[0].description).toBe('Manual1');
    });

    it('preserves pinned auto checkpoints', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'PinnedAuto');
      await checkpointManager.pinCheckpoint(cp.id);
      await checkpointManager.createCheckpoint('proj1', 'UnpinnedAuto');

      await checkpointManager.clearAutoCheckpoints('proj1');

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(1);
      expect(cps[0].description).toBe('PinnedAuto');
    });
  });

  // ── getCurrentCheckpoint ───────────────────────────────────────────

  describe('getCurrentCheckpoint', () => {
    it('returns null when no checkpoint has been created', () => {
      expect(checkpointManager.getCurrentCheckpoint()).toBeNull();
    });

    it('returns the most recently created checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'First');
      await checkpointManager.createCheckpoint('proj1', 'Second');

      const current = checkpointManager.getCurrentCheckpoint();
      expect(current?.description).toBe('Second');
    });

    it('returns the restored checkpoint after restore', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const first = await checkpointManager.createCheckpoint('proj1', 'First');
      await checkpointManager.createCheckpoint('proj1', 'Second');

      await checkpointManager.restoreCheckpoint(first.id);

      const current = checkpointManager.getCurrentCheckpoint();
      expect(current?.description).toBe('First');
    });
  });

  // ── unloadProject ──────────────────────────────────────────────────

  describe('unloadProject', () => {
    it('removes checkpoint metadata from memory', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'CP1');
      await checkpointManager.createCheckpoint('proj2', 'CP2');

      checkpointManager.unloadProject('proj1');

      const p2 = await checkpointManager.getCheckpoints('proj2');
      expect(p2).toHaveLength(1);
    });

    it('resets currentCheckpoint if it belonged to unloaded project', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'CP1');

      checkpointManager.unloadProject('proj1');

      expect(checkpointManager.getCurrentCheckpoint()).toBeNull();
    });
  });

  // ── Loading ────────────────────────────────────────────────────────

  /**
   * IndexedDB returns a record whole, snapshot included, and the store holds every project's
   * history. Opening a project reads its own checkpoints and nothing else.
   */
  describe('loading a project in a new page', () => {
    async function freshPage() {
      vi.resetModules();
      return (await import('../checkpoint')).checkpointManager;
    }

    async function seed(projectId: string, count: number) {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const ids: string[] = [];
      for (let i = 0; i < count; i++) ids.push((await checkpointManager.createCheckpoint(projectId, `${projectId} ${i}`)).id);
      return ids;
    }

    it('reads only that project\'s records', async () => {
      await seed('proj1', 2);
      await seed('proj2', 3);
      const page = await freshPage();
      const { IDBObjectStore, IDBIndex } = await import('fake-indexeddb');
      const storeReads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
      const indexReads = vi.spyOn(IDBIndex.prototype, 'getAll');

      expect(await page.getCheckpoints('proj1')).toHaveLength(2);

      expect(storeReads).not.toHaveBeenCalled();
      expect(indexReads.mock.calls.map((call) => call[0])).toEqual(['proj1']);
      storeReads.mockRestore();
      indexReads.mockRestore();
    });

    it('reads a project with no checkpoints once, not on every list', async () => {
      await seed('proj2', 1);
      const page = await freshPage();
      const { IDBIndex } = await import('fake-indexeddb');
      const indexReads = vi.spyOn(IDBIndex.prototype, 'getAll');

      expect(await page.getCheckpoints('empty')).toEqual([]);
      expect(await page.getCheckpoints('empty')).toEqual([]);

      expect(indexReads).toHaveBeenCalledTimes(1);
      indexReads.mockRestore();
    });

    it('finds a saved checkpoint before its project is listed', async () => {
      const [id] = await seed('proj1', 1);
      const page = await freshPage();

      expect(await page.checkpointExists(id)).toBe(true);
      expect(await page.checkpointExists('cp_0_missing')).toBe(false);
    });

    it('finds a saved checkpoint while another call is still reading', async () => {
      // On open, the workspace asks whether the saved checkpoint exists while the checkpoints
      // panel lists another project. A "no" there writes a new "Project opened" checkpoint.
      const [id] = await seed('proj1', 1);
      await seed('proj2', 2);
      const page = await freshPage();

      const listing = page.getCheckpoints('proj2');
      // Arrive once the first call is under way, as the workspace's check does.
      for (let i = 0; i < 3; i++) await Promise.resolve();
      const exists = await page.checkpointExists(id);
      await listing;

      expect(exists).toBe(true);
    });

    it('keeps a checkpoint made while another call is still reading', async () => {
      await seed('proj1', 1);
      const page = await freshPage();

      const [, made] = await Promise.all([page.getCheckpoints('proj2'), page.createCheckpoint('proj1', 'during the read')]);

      expect((await page.getCheckpoints('proj1')).map((c) => c.id)).toContain(made.id);
    });

    it('prunes against the checkpoints already stored, not only this page\'s', async () => {
      const MAX_UNPINNED = (await import('../checkpoint')).unpinnedLimit();
      await seed('proj1', MAX_UNPINNED);
      const page = await freshPage();

      await page.createCheckpoint('proj1', 'one more');

      expect(await page.getCheckpoints('proj1')).toHaveLength(MAX_UNPINNED);
    });

    it('pins a checkpoint whose project was not listed yet', async () => {
      const [id] = await seed('proj1', 1);
      const page = await freshPage();

      expect(await page.pinCheckpoint(id)).toBe(true);
      expect((await page.getCheckpoints('proj1'))[0].pinned).toBe(true);
    });

    it('reads the project again after it is unloaded, so checkpoints written meanwhile show', async () => {
      await seed('proj1', 1);
      expect(await checkpointManager.getCheckpoints('proj1')).toHaveLength(1);

      // Written by another tab: straight into the store, past this manager. A millisecond apart,
      // because each page numbers its checkpoints from 0 and the id is the time plus that number.
      const other = await freshPage();
      await new Promise(r => setTimeout(r, 2));
      await other.createCheckpoint('proj1', 'from another tab');
      checkpointManager.unloadProject('proj1');

      expect(await checkpointManager.getCheckpoints('proj1')).toHaveLength(2);
    });
  });

  // ── Size and changes ───────────────────────────────────────────────

  /**
   * Each row in the panel says how much the checkpoint takes in this browser and how much changed
   * since the checkpoint before it. Both are worked out when it is written and kept in its metadata,
   * so listing still reads no snapshot.
   */
  describe('size and changes', () => {
    const tick = () => new Promise(r => setTimeout(r, 2));
    const storedRecord = (id: string) => new Promise<{ compressedData: string; size?: number; changes?: unknown }>((resolve) => {
      const req = testDb.transaction(['checkpoints'], 'readonly').objectStore('checkpoints').get(id);
      req.onsuccess = () => resolve(req.result);
    });
    async function freshPage() {
      vi.resetModules();
      return (await import('../checkpoint')).checkpointManager;
    }

    it('records the space a checkpoint takes in storage', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'hello\nworld' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'A');

      const [listed] = await checkpointManager.getCheckpoints('proj1');
      // UTF-16: two bytes for each character stored.
      expect(listed.size).toBe((await storedRecord(cp.id)).compressedData.length * 2);
      const [inNewPage] = await (await freshPage()).getCheckpoints('proj1');
      expect(inNewPage.size).toBe(listed.size);
    });

    it('says nothing about changes on a project\'s first checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      expect((await checkpointManager.getCheckpoints('proj1'))[0].changes).toBeUndefined();
    });

    it('counts the files and lines changed since the checkpoint before it', async () => {
      setProjectFiles([
        { path: '/index.html', content: 'one\ntwo\nthree' },
        { path: '/gone.txt', content: 'x\ny' },
        { path: '/same.txt', content: 'untouched' },
      ]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      setProjectFiles([
        { path: '/index.html', content: 'one\nTWO\nthree\nfour' },
        { path: '/new.css', content: 'a{}' },
        { path: '/same.txt', content: 'untouched' },
      ]);
      await checkpointManager.createCheckpoint('proj1', 'B');

      const [b] = await checkpointManager.getCheckpoints('proj1');
      // index.html: TWO and four in, two out. new.css: one line in. gone.txt: two lines out.
      expect(b.changes).toEqual({ files: 3, added: 3, removed: 3 });
    });

    it('does not count a file\'s final newline as a line', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      setProjectFiles([{ path: '/b.txt', content: 'one\ntwo\n' }]);
      await checkpointManager.createCheckpoint('proj1', 'B');
      // b.txt in with its two lines, a.txt out with its one.
      expect((await checkpointManager.getCheckpoints('proj1'))[0].changes).toEqual({ files: 2, added: 2, removed: 1 });
    });

    it('records no change when nothing changed', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      await checkpointManager.createCheckpoint('proj1', 'B');
      expect((await checkpointManager.getCheckpoints('proj1'))[0].changes).toEqual({ files: 0, added: 0, removed: 0 });
    });

    it('counts a changed image as a file, with no lines', async () => {
      const image = (bytes: number[]) => new Uint8Array(bytes).buffer;
      projectFiles = [{ path: '/logo.png', content: image([1, 2, 3]) }, { path: '/a.txt', content: 'a' }];
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      projectFiles = [{ path: '/logo.png', content: image([1, 2, 4]) }, { path: '/a.txt', content: 'a' }];
      await checkpointManager.createCheckpoint('proj1', 'B');
      expect((await checkpointManager.getCheckpoints('proj1'))[0].changes).toEqual({ files: 1, added: 0, removed: 0 });
    });

    it('notices an edit at the very end of a large binary file of the same length', () => {
      // Past a million characters the fingerprint samples with a stride, which steps over this one.
      const data = 'A'.repeat(3_000_000);
      const edited = data.slice(0, -1) + 'B';
      const before = indexFiles(new Map([['/photo.jpg', { data, encoding: 'base64' as const }]]));
      const after = indexFiles(new Map([['/photo.jpg', { data: edited, encoding: 'base64' as const }]]));
      expect(compareFiles(before, after)).toEqual({ files: 1, added: 0, removed: 0 });
    });

    it('compares with the checkpoint before it in a new page too', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      const page = await freshPage();
      await tick();
      setProjectFiles([{ path: '/a.txt', content: 'b' }]);
      await page.createCheckpoint('proj1', 'B');
      expect((await page.getCheckpoints('proj1'))[0].changes).toEqual({ files: 1, added: 1, removed: 1 });
    });

    it('keeps its changes through a pin and a rename', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      setProjectFiles([{ path: '/a.txt', content: 'b' }]);
      const b = await checkpointManager.createCheckpoint('proj1', 'B');
      await checkpointManager.pinCheckpoint(b.id);
      await checkpointManager.renameCheckpoint(b.id, 'Named');

      const [listed] = await (await freshPage()).getCheckpoints('proj1');
      expect(listed.changes).toEqual({ files: 1, added: 1, removed: 1 });
      expect(listed.size).toBeGreaterThan(0);
    });

    it('gives a checkpoint written before sizes were recorded its size when its project loads', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'A');
      // As a metadata entry from before: no size.
      await new Promise<void>((resolve) => {
        const tx = testDb.transaction(['checkpointMeta'], 'readwrite');
        const store = tx.objectStore('checkpointMeta');
        store.get(cp.id).onsuccess = (e) => {
          const meta = (e.target as IDBRequest).result;
          delete meta.size;
          store.put(meta);
        };
        tx.oncomplete = () => resolve();
      });

      const [listed] = await (await freshPage()).getCheckpoints('proj1');
      expect(listed.size).toBe((await storedRecord(cp.id)).compressedData.length * 2);
    });
  });

  // ── Replacing ──────────────────────────────────────────────────────

  /** A burst of changes from one connector is one checkpoint, written over as the burst goes on. */
  describe('comparing with the files', () => {
    const tick = () => new Promise(r => setTimeout(r, 2));
    async function freshPage() {
      vi.resetModules();
      return (await import('../checkpoint')).checkpointManager;
    }

    it('finds the files the same as the checkpoint just made', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'A');
      expect(await checkpointManager.compareWithFiles('proj1')).toEqual({ id: cp.id, changes: { files: 0, added: 0, removed: 0 } });
    });

    it('says what was edited since', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const cp = await checkpointManager.createCheckpoint('proj1', 'A');
      setProjectFiles([{ path: '/a.txt', content: 'b' }, { path: '/new.txt', content: 'one\ntwo\n' }]);
      expect(await checkpointManager.compareWithFiles('proj1')).toEqual({ id: cp.id, changes: { files: 2, added: 3, removed: 1 } });
    });

    it('goes by the checkpoint restored last, not the newest', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const older = await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      setProjectFiles([{ path: '/a.txt', content: 'b' }]);
      await checkpointManager.createCheckpoint('proj1', 'B');
      await checkpointManager.restoreCheckpoint(older.id);
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      expect(await checkpointManager.compareWithFiles('proj1')).toEqual({ id: older.id, changes: { files: 0, added: 0, removed: 0 } });
    });

    it('goes by the newest in a new page, reading it back', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      await checkpointManager.createCheckpoint('proj1', 'A');
      await tick();
      const newest = await checkpointManager.createCheckpoint('proj1', 'B');
      const page = await freshPage();
      expect(await page.compareWithFiles('proj1')).toEqual({ id: newest.id, changes: { files: 0, added: 0, removed: 0 } });
    });

    it('stays within the project when another one made the last checkpoint', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const mine = await checkpointManager.createCheckpoint('proj1', 'A');
      await checkpointManager.createCheckpoint('proj2', 'Elsewhere');
      expect((await checkpointManager.compareWithFiles('proj1'))?.id).toBe(mine.id);
    });

    it('has nothing to compare with in a project without checkpoints', async () => {
      expect(await checkpointManager.compareWithFiles('proj1')).toBeNull();
    });
  });

  describe('replacing a checkpoint', () => {
    const tick = () => new Promise(r => setTimeout(r, 2));

    it('writes over it, keeping its id and place, with the new files and time', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'start' }]);
      await checkpointManager.createCheckpoint('proj1', 'Base');
      await tick();
      setProjectFiles([{ path: '/a.txt', content: 'start' }, { path: '/c.txt', content: 'c' }]);
      const burst = await checkpointManager.createCheckpoint('proj1', 'Connector');
      await tick();
      setProjectFiles([{ path: '/a.txt', content: 'start' }, { path: '/c.txt', content: 'c' }, { path: '/b.txt', content: 'b' }]);

      const again = await checkpointManager.createCheckpoint('proj1', 'Connector', { replaces: burst.id });

      expect(again.id).toBe(burst.id);
      expect(again.timestamp > burst.timestamp).toBe(true);
      const list = await checkpointManager.getCheckpoints('proj1');
      expect(list.map(c => c.description)).toEqual(['Connector', 'Base']);
      // Changes cover the whole burst, c.txt and b.txt: against Base, not against the first write.
      expect(list[0].changes).toEqual({ files: 2, added: 2, removed: 0 });
      resetTrackingArrays();
      setProjectFiles([]);
      await checkpointManager.restoreCheckpoint(burst.id);
      expect(createdFiles.map(f => f.content).sort()).toEqual(['b', 'c', 'start']);
    });

    it('makes a new checkpoint when the one named belongs to another project', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);
      const other = await checkpointManager.createCheckpoint('proj2', 'Other');
      const made = await checkpointManager.createCheckpoint('proj1', 'Mine', { replaces: other.id });
      expect(made.id).not.toBe(other.id);
      expect(await checkpointManager.getCheckpoints('proj2')).toHaveLength(1);
    });
  });

  // ── Compression round-trip ─────────────────────────────────────────

  describe('compression', () => {
    it('survives a create→restore round-trip with compression', async () => {
      const largeContent = 'x'.repeat(10000);
      setProjectFiles([
        { path: '/big.txt', content: largeContent },
        { path: '/sub/nested.txt', content: 'nested content' },
      ]);

      const cp = await checkpointManager.createCheckpoint('proj1', 'Compressed');

      // Wipe current files to simulate project changes
      setProjectFiles([]);
      resetTrackingArrays();

      const result = await checkpointManager.restoreCheckpoint(cp.id);

      expect(result).toBe(true);
      expect(createdFiles).toHaveLength(2);
      expect(createdFiles.find(f => f.path === '/big.txt')?.content).toBe(largeContent);
      expect(createdFiles.find(f => f.path === '/sub/nested.txt')?.content).toBe('nested content');
    });
  });

  // ── Server generation checkpoint scenario ──────────────────────────

  describe('server generation rollback scenario', () => {
    it('pre-generation checkpoint allows rollback after server changes files', async () => {
      // 1. Project has original files
      setProjectFiles([
        { path: '/index.html', content: '<h1>Original</h1>' },
        { path: '/style.css', content: 'body { color: black; }' },
      ]);

      // 2. Pre-generation checkpoint created before sending to server
      const preGenCp = await checkpointManager.createCheckpoint(
        'proj1', 'Pre-generation snapshot', { kind: 'auto' }
      );

      // 3. Server modifies files — simulate by changing projectFiles
      //    (in production, the sync-pull updates IndexedDB)
      setProjectFiles([
        { path: '/index.html', content: '<h1>AI Rewrote This</h1>' },
        { path: '/style.css', content: 'body { color: red; }' },
        { path: '/new-file.js', content: 'console.log("added by AI")' },
      ]);

      // 4. Post-generation checkpoint
      await checkpointManager.createCheckpoint(
        'proj1', 'After server generation', { kind: 'auto' }
      );

      // 5. User doesn't like the result — restore pre-generation checkpoint
      resetTrackingArrays();
      const result = await checkpointManager.restoreCheckpoint(preGenCp.id);

      expect(result).toBe(true);
      // new-file.js should be deleted (wasn't in pre-gen snapshot)
      expect(deletedFiles).toContain('/new-file.js');
      // Existing files restored to original content
      expect(updatedFiles.find(f => f.path === '/index.html')?.content).toBe('<h1>Original</h1>');
      expect(updatedFiles.find(f => f.path === '/style.css')?.content).toBe('body { color: black; }');
    });

    it('pre-generation checkpoint survives unload/reload cycle', async () => {
      setProjectFiles([
        { path: '/app.js', content: 'const x = 1;' },
      ]);

      const preGenCp = await checkpointManager.createCheckpoint(
        'proj1', 'Pre-generation snapshot', { kind: 'auto' }
      );

      // User closes project (unload clears in-memory metadata)
      checkpointManager.unloadProject('proj1');

      // User comes back — getCheckpoints reloads from IndexedDB
      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(1);
      expect(cps[0].id).toBe(preGenCp.id);
      expect(cps[0].description).toBe('Pre-generation snapshot');

      // Restore still works after reload
      resetTrackingArrays();
      const result = await checkpointManager.restoreCheckpoint(preGenCp.id);
      expect(result).toBe(true);
      expect(updatedFiles.find(f => f.path === '/app.js')?.content).toBe('const x = 1;');
    });

    it('both pre and post checkpoints are available for the user', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'before' }]);
      await checkpointManager.createCheckpoint('proj1', 'Pre-generation snapshot');
      await new Promise(r => setTimeout(r, 5));

      setProjectFiles([{ path: '/a.txt', content: 'after' }]);
      await checkpointManager.createCheckpoint('proj1', 'After server generation');

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(2);
      expect(cps[0].description).toBe('After server generation');
      expect(cps[1].description).toBe('Pre-generation snapshot');
    });
  });
});
