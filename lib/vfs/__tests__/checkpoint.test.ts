import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

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
};

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => mockVfs,
  vfs: mockVfs,
}));

vi.mock('@/lib/vfs/adapters/indexeddb-adapter', () => ({
  IndexedDBAdapter: class {},
}));

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
    it('keeps at most 5 unpinned checkpoints per project', async () => {
      setProjectFiles([{ path: '/a.txt', content: 'a' }]);

      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 5));
        await checkpointManager.createCheckpoint('proj1', `CP${i}`);
      }

      const cps = await checkpointManager.getCheckpoints('proj1');
      expect(cps).toHaveLength(5);
      // Should keep the 5 newest
      expect(cps[0].description).toBe('CP7');
      expect(cps[4].description).toBe('CP3');
    });

    it('does not prune a checkpoint pinned at create, so a user save survives later autos', async () => {
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

    it('does not prune pinned checkpoints', async () => {
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

    it('does not prune across projects', async () => {
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
