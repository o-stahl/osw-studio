import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory file store with monotonic updatedAt so the read-before-edit
// guard's version comparison is exercised realistically.
let clock = 1000;
const store = new Map<string, { content: string; updatedAt: Date }>();

function seed(path: string, content: string) {
  store.set(path, { content, updatedAt: new Date(clock++) });
}
/** Simulate an out-of-band edit (e.g. the user saving in the editor). */
function externalEdit(path: string, content: string) {
  store.set(path, { content, updatedAt: new Date(clock++) });
}

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn(async (_pid: string, path: string) => {
    const f = store.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return { path, content: f.content, updatedAt: f.updatedAt };
  }),
  createFile: vi.fn(async (_pid: string, path: string, content: string) => {
    if (store.has(path)) throw new Error('File already exists');
    store.set(path, { content, updatedAt: new Date(clock++) });
  }),
  updateFile: vi.fn(async (_pid: string, path: string, content: string) => {
    store.set(path, { content, updatedAt: new Date(clock++) });
  }),
  listFiles: vi.fn().mockResolvedValue([]),
  listDirectories: vi.fn().mockResolvedValue([]),
  getFileTree: vi.fn().mockResolvedValue([]),
  getAllFilesAndDirectories: vi.fn().mockResolvedValue([]),
};

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => mockVfs,
  vfs: mockVfs,
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function exec(cmd: string[], stdin?: string, ctx?: { readVersions?: Map<string, number> }) {
  const { vfsShell } = await import('../cli-shell');
  return vfsShell.execute('test', cmd, stdin, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  clock = 1000;
});

describe('read-before-edit guard', () => {
  it('allows overwriting a file the agent read this session', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1>old</h1>');

    const read = await exec(['cat', '/index.html'], undefined, ctx);
    expect(read.success).toBe(true);

    const write = await exec(['cat', '>', '/index.html'], '<h1>new</h1>', ctx);
    expect(write.success).toBe(true);
    expect(store.get('/index.html')?.content).toBe('<h1>new</h1>');
  });

  it('blocks overwriting a file that changed since the agent last read it', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1>old</h1>');

    await exec(['cat', '/index.html'], undefined, ctx);
    externalEdit('/index.html', '<h1>user tweak</h1>'); // user saves between tasks

    const write = await exec(['cat', '>', '/index.html'], '<h1>agent from stale memory</h1>', ctx);
    expect(write.success).toBe(false);
    expect(write.stderr).toContain('refusing to edit');
    expect(write.stderr).toContain('/index.html');
    // The user's edit is preserved — the overwrite did not land.
    expect(store.get('/index.html')?.content).toBe('<h1>user tweak</h1>');
  });

  it('allows overwriting an existing file with no baseline (never observed → not a stale-memory write)', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1>template</h1>');

    // The agent has never read or written this file this conversation, so it has no
    // stale memory of it to clobber — a full write must not be discarded on a chance.
    const write = await exec(['cat', '>', '/index.html'], '<h1>fresh</h1>', ctx);
    expect(write.success).toBe(true);
    expect(store.get('/index.html')?.content).toBe('<h1>fresh</h1>');
  });

  it('allows repeated full writes when the user made no edits between them', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    // The agent iterating on a file it owns (cat > is its dominant write path) must
    // never be blocked as long as nothing changed underneath it.
    expect((await exec(['cat', '>', '/page.html'], 'v1', ctx)).success).toBe(true);
    expect((await exec(['cat', '>', '/page.html'], 'v2', ctx)).success).toBe(true);
    expect((await exec(['cat', '>', '/page.html'], 'v3', ctx)).success).toBe(true);
    expect(store.get('/page.html')?.content).toBe('v3');
  });

  it('allows creating a new file and then overwriting the agent’s own write', async () => {
    const ctx = { readVersions: new Map<string, number>() };

    const create = await exec(['cat', '>', '/new.html'], 'v1', ctx);
    expect(create.success).toBe(true);
    expect(store.get('/new.html')?.content).toBe('v1');

    const overwriteOwn = await exec(['cat', '>', '/new.html'], 'v2', ctx);
    expect(overwriteOwn.success).toBe(true);
    expect(store.get('/new.html')?.content).toBe('v2');
  });

  it('keeps the baseline in sync after the agent’s own edits (no false conflict)', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1>alpha</h1>');

    await exec(['cat', '/index.html'], undefined, ctx); // baseline
    // The agent's own edit updates the baseline, so it isn't mistaken for a user edit.
    const sed = await exec(['sed', '-i', 's/alpha/beta/', '/index.html'], undefined, ctx);
    expect(sed.success).toBe(true);
    expect(store.get('/index.html')?.content).toContain('beta');

    // A following full overwrite by the agent is allowed — nothing changed underneath it.
    const write = await exec(['cat', '>', '/index.html'], '<h1>whole new file</h1>', ctx);
    expect(write.success).toBe(true);
    expect(store.get('/index.html')?.content).toBe('<h1>whole new file</h1>');
  });

  it('guards non-cat redirect overwrites too (e.g. echo >), not just cat', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/page.html', 'original');
    await exec(['cat', '/page.html'], undefined, ctx); // baseline
    externalEdit('/page.html', 'user edit');

    const write = await exec(['echo', 'agentoutput', '>', '/page.html'], undefined, ctx);
    expect(write.success).toBe(false);
    expect(write.stderr).toContain('refusing to edit');
    expect(store.get('/page.html')?.content).toBe('user edit');
  });

  it('gates ss --entity — blocks a whole-entity replace when the user changed the file', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    // Agent-generated title with a typo; the agent reads it (baseline).
    seed('/index.html', '<h1 class="hero">Testing nothign</h1>');
    await exec(['cat', '/index.html'], undefined, ctx);
    // User fixes the typo in the editor.
    externalEdit('/index.html', '<h1 class="hero">Testing 123</h1>');

    // --entity keys on the selector (<h1 class="hero">), not the body — so it would NOT
    // fail-safe on the text change, and its replacement carries the stale "nothign" back.
    // The guard blocks it because the file changed since the agent last read it.
    const r = await exec(
      ['ss', '--entity', '/index.html'],
      '<h1 class="hero">\n=======\n<h1 class="hero text-3xl">Testing nothign</h1>',
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('refusing to edit');
    expect(store.get('/index.html')?.content).toBe('<h1 class="hero">Testing 123</h1>');
  });

  it('does NOT gate literal ss — self-protecting surgical edit runs and preserves user edits', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1 class="text-xl">Title</h1><p>original</p>');
    await exec(['cat', '/index.html'], undefined, ctx);
    externalEdit('/index.html', '<h1 class="text-xl">Title</h1><p>user edit</p>'); // user edits <p>

    // Literal ss changes only the class; it matches current content and splices around
    // the user's <p>, so it is allowed and the user's edit survives.
    const r = await exec(['ss', '/index.html'], 'class="text-xl"\n=======\nclass="text-3xl"', ctx);
    expect(r.success).toBe(true);
    expect(store.get('/index.html')?.content).toContain('text-3xl');
    expect(store.get('/index.html')?.content).toContain('user edit');
  });

  it('does NOT gate sed -i — surgical substitution is allowed even after a user edit', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/style.css', '.title { color: red; }');
    await exec(['cat', '/style.css'], undefined, ctx);
    externalEdit('/style.css', '.title { color: red; } .extra { margin: 0; }'); // user adds a rule

    const r = await exec(['sed', '-i', 's/red/green/', '/style.css'], undefined, ctx);
    expect(r.success).toBe(true);
    expect(store.get('/style.css')?.content).toContain('green');
    expect(store.get('/style.css')?.content).toContain('.extra'); // user addition preserved
  });

  // KNOWN GAP (documented deliberately — see checkWrite in cli-shell.ts): a broad-regex
  // ss (e.g. `<h1>.*</h1>`) is NOT self-protecting — a wide pattern still matches after
  // the user edits the content — but regex ss is not gated (only --entity is). So it can
  // currently revert a user edit. Left ungated to avoid blocking the common specific-pattern
  // case. If we decide to gate regex ss too, this test should flip to the commented block.
  it('KNOWN GAP: broad-regex ss is not gated and can revert a user edit', async () => {
    const ctx = { readVersions: new Map<string, number>() };
    seed('/index.html', '<h1>Old Title</h1>');
    await exec(['cat', '/index.html'], undefined, ctx); // baseline
    externalEdit('/index.html', '<h1>User Edited Title</h1>'); // user changes the title

    // Agent, from stale memory, replaces the whole heading with a broad regex.
    const r = await exec(
      ['ss', '--regex', '/index.html'],
      '<h1>.*</h1>\n=======\n<h1>Old Title</h1>',
      ctx,
    );
    // Current behavior: allowed, and the broad pattern clobbers the user's edit.
    expect(r.success).toBe(true);
    expect(store.get('/index.html')?.content).toBe('<h1>Old Title</h1>');
    // If regex ss becomes gated, flip to:
    //   expect(r.success).toBe(false);
    //   expect(store.get('/index.html')?.content).toBe('<h1>User Edited Title</h1>');
  });

  it('is disabled when no readVersions map is provided (direct/test callers)', async () => {
    seed('/index.html', '<h1>old</h1>');
    // No ctx.readVersions → guard is a no-op, overwrite proceeds.
    const write = await exec(['cat', '>', '/index.html'], '<h1>new</h1>');
    expect(write.success).toBe(true);
    expect(store.get('/index.html')?.content).toBe('<h1>new</h1>');
  });
});

describe('cat into a redirect, with a path that names nothing', () => {
  it('still writes the files that exist, and answers with the failure', async () => {
    seed('/a.txt', 'alpha');
    const r = await exec(['cat', '/a.txt', '/nope.txt', '>', '/out.txt']);
    // As in a shell: the file gets what could be read, and the command still fails.
    expect(store.get('/out.txt')?.content).toBe('=== /a.txt ===\nalpha');
    expect(r).toMatchObject({ success: false, stdout: '' });
    // The read's own error, after the path, and nothing about the write.
    expect(r.stderr).toBe('cat: /nope.txt: File not found: /nope.txt');
  });
});
