import { describe, it, expect, vi } from 'vitest';

/**
 * Where `rg` and `grep` say a text's lines end. A newline ends the line before it: a file that ends
 * in one has no empty line after it, which is how both real tools count, so `-v`, `-c` and the
 * context flags agree with them on the ordinary file an editor saves.
 */

const BIG_LINES = 130_000;

const FILES: Record<string, string> = {
  '/f.txt': 'a\nMATCH\n',
  '/crlf.txt': 'a\r\nMATCH\r\n',
  '/open.txt': 'a\nMATCH',
  '/empty.txt': '',
  '/blank.txt': '\n',
  '/two-blank.txt': '\n\n',
  '/big.txt': 'x\n'.repeat(BIG_LINES),
};

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  updateFile: vi.fn(),
  listFiles: vi.fn().mockResolvedValue([]),
  listDirectories: vi.fn().mockResolvedValue([]),
  getFileTree: vi.fn().mockResolvedValue([]),
  getAllFilesAndDirectories: vi.fn().mockResolvedValue(
    Object.entries(FILES).map(([path, content]) => ({ type: 'file' as const, path, content })),
  ),
};

vi.mock('@/lib/vfs', () => ({ getActiveVFS: () => mockVfs, vfs: mockVfs }));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function exec(cmd: string[], stdin?: string) {
  const { vfsShell } = await import('../cli-shell');
  return vfsShell.execute('test', cmd, stdin);
}

const stdout = async (cmd: string[], stdin?: string) => (await exec(cmd, stdin)).stdout;

describe('a text that ends in a newline', () => {
  it('has no empty line after it to select with -v', async () => {
    expect(await stdout(['grep', '-vc', 'MATCH', '/f.txt'])).toBe('1');
    expect(await stdout(['rg', '-v', 'MATCH', '/f.txt'])).toBe('/f.txt:1:a');
    expect(await stdout(['grep', '-vc', 'MATCH', '/crlf.txt'])).toBe('1');
    expect(await stdout(['grep', '-vc', 'MATCH', '/open.txt'])).toBe('1');
  });

  it('counts its lines as wc -l and grep -c \'^\' do', async () => {
    expect(await stdout(['grep', '-c', '^', '/f.txt'])).toBe('2');
    expect(await stdout(['grep', '-c', '^', '/open.txt'])).toBe('2');
    expect(await stdout(['grep', '-c', '^', '/empty.txt'])).toBe('0');
    expect(await stdout(['grep', '-c', '^', '/blank.txt'])).toBe('1');
    expect(await stdout(['grep', '-c', '^', '/two-blank.txt'])).toBe('2');
  });

  it('gives no context line past its end', async () => {
    expect(await stdout(['rg', '-A', '2', 'MATCH', '/f.txt'])).toBe('/f.txt:2:MATCH');
    expect(await stdout(['rg', '-C', '1', 'a', '/f.txt'])).toBe('/f.txt:1:a\n/f.txt:2:MATCH');
  });

  it('is read the same way from a pipe', async () => {
    expect(await stdout(['grep', '-vc', 'MATCH'], 'a\nMATCH\n')).toBe('1');
    expect(await stdout(['rg', '-v', 'MATCH'], 'a\nMATCH\n')).toBe('1:a');
    expect(await stdout(['grep', '-c', 'x'], '')).toBe('0');
    expect(await stdout(['grep', '-vc', 'x'], '')).toBe('0');
  });
});

describe('a file with more lines than a call can take as arguments', () => {
  /** Where the shell cuts an output too long to hand back whole. */
  const CUT = /\n\n… \[\d+ chars truncated\] …$/;

  it('is searched without overflowing, and its output cut at the shell\'s limit', async () => {
    for (const command of ['rg', 'grep']) {
      const result = await exec([command, '-c', 'x', '/big.txt']);
      expect(result.stdout, command).toBe(String(BIG_LINES));
      const lines = await exec([command, 'x', '/big.txt']);
      expect(lines.stderr, command).toBe('');
      expect(lines.success, command).toBe(true);
      expect(lines.stdout, command).toMatch(CUT);
    }
    const piped = await exec(['grep', 'x'], FILES['/big.txt']);
    expect(piped.stderr).toBe('');
    expect(piped.success).toBe(true);
    expect(piped.stdout).toMatch(CUT);
  });
});
