import { describe, it, expect, vi, beforeEach } from 'vitest';

const BUNDLE = {
  path: '/bundle.js', name: 'bundle.js', type: 'js',
  content: 'road road\ntenement\nroad\n', mimeType: 'application/javascript', size: 24,
};
const SRC = {
  path: '/src/store.ts', name: 'store.ts', type: 'ts',
  content: 'const tenement = 1;\n', mimeType: 'text/plain', size: 20,
};
const FILES = [BUNDLE, SRC];

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn().mockImplementation(async (_p: string, path: string) => {
    const f = FILES.find(x => x.path === path);
    if (!f) throw new Error('not found');
    return f;
  }),
  writeFile: vi.fn(), createFile: vi.fn(), updateFile: vi.fn(), deleteFile: vi.fn(), renameFile: vi.fn(),
  listFiles: vi.fn().mockResolvedValue(FILES),
  listDirectories: vi.fn().mockResolvedValue([]),
  listDirectory: vi.fn().mockResolvedValue(FILES),
  getFileTree: vi.fn().mockResolvedValue(FILES),
  getAllFilesAndDirectories: vi.fn().mockResolvedValue(FILES),
};

vi.mock('@/lib/vfs', () => ({ getActiveVFS: () => mockVfs, vfs: mockVfs }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

async function run(cmdStr: string) {
  const { vfsShell } = await import('../cli-shell');
  const { parseBashCommand } = await import('@/lib/llm/tool-registry');
  return vfsShell.execute('p', parseBashCommand(cmdStr));
}

beforeEach(() => vi.clearAllMocks());

describe('pipes inside chain operators', () => {
  it('runs a pipe that stands alone', async () => {
    expect((await run('grep -o road /bundle.js | wc -l')).stdout).toBe('3');
  });

  it('runs a pipe inside a ; chain', async () => {
    const r = await run('grep -o road /bundle.js | wc -l ; echo done');
    expect(r.stdout).toBe('3\ndone');
  });

  it('runs a pipe inside an && chain', async () => {
    const r = await run('echo first && grep -o road /bundle.js | wc -l');
    expect(r.stdout).toBe('first\n3');
  });

  it('runs a pipe inside a || fallback', async () => {
    const r = await run('cat /nope.js || grep -o road /bundle.js | wc -l');
    expect(r.stdout).toBe('3');
  });
});

describe('; glued to a closing quote', () => {
  it('does not swallow the next command', async () => {
    const r = await run("echo '---'; echo after");
    expect(r.stdout).toBe('---\nafter');
  });

  it('keeps a quoted operator literal', async () => {
    expect((await run('echo "a;b"')).stdout).toBe('a;b');
  });

  it('splits an unquoted glued operator as before', async () => {
    expect((await run('echo x; echo y')).stdout).toBe('x\ny');
  });
});

describe('grep -c / -l', () => {
  it('counts matching lines in one file', async () => {
    expect((await run('grep -c road /bundle.js')).stdout).toBe('2');
  });

  it('reports zero rather than nothing when a named file has no match', async () => {
    expect((await run('grep -c nosuchtoken /bundle.js')).stdout).toBe('0');
  });

  it('prefixes counts when sweeping a directory', async () => {
    expect((await run('grep -c tenement /')).stdout).toBe('/bundle.js:1\n/src/store.ts:1');
  });

  it('lists only matching paths with -l', async () => {
    expect((await run('grep -l road /')).stdout).toBe('/bundle.js');
  });

  it('rejects an unsupported flag instead of ignoring it', async () => {
    const r = await run('grep -Z road /bundle.js');
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('unsupported flag');
  });
});

describe('ls on a single file path', () => {
  it('lists the file rather than returning nothing', async () => {
    expect((await run('ls /bundle.js')).stdout).toBe('/bundle.js');
  });

  it('shows size and date with -la', async () => {
    expect((await run('ls -la /bundle.js')).stdout).toContain('/bundle.js');
  });

  it('still lists a directory', async () => {
    expect((await run('ls /')).stdout).toBe('/bundle.js\n/src/store.ts');
  });
});

describe('ls -R with several paths', () => {
  it('recurses into each directory', async () => {
    const DEEP = { ...SRC, path: '/src/lib/deep.ts', name: 'deep.ts' };
    const all = [BUNDLE, SRC, DEEP];
    const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
    mockVfs.listDirectory.mockImplementationOnce(async (_p: string, dir: string) => all.filter(f => parent(f.path) === dir));
    mockVfs.getAllFilesAndDirectories.mockResolvedValueOnce(all);
    expect((await run('ls -R /bundle.js /src')).stdout).toBe('/bundle.js\n\n/src:\n/src/lib/deep.ts\n/src/store.ts');
  });
});
