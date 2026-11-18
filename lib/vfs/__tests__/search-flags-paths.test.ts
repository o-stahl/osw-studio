import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `rg` and `grep` as someone who knows the real commands would write them: several paths, a glob
 * for a path, flags clustered or with their value attached, long flags, file filters, and the
 * pattern dialects.
 *
 * Every expectation that has a counterpart in the real tools was compared with ripgrep 14 and with
 * the system grep on the same tree. Where this shell answers differently on purpose, the test says
 * so.
 */

const TREE: Record<string, string[]> = {
  '/a.txt': ['alpha', 'beta MATCH one', 'gamma cat', 'delta', 'epsilon MATCH two', 'zeta concat'],
  '/sub/b.txt': ['one', 'MATCH in sub', 'three a.b('],
  '/sub/deep/c.css': ['.MATCH { color: red }', '.other { width: 100px }'],
  '/styles.css': [':root { --accent: #f00 }', '.btn { color: var(--accent) } /* MATCH */'],
  '/index.html': ['<h1 class="MATCH">Title</h1>', '<p>match lower</p>'],
  '/scripts/app.js': ['const x = 1; // MATCH', 'call foo(bar)', 'Match mixed'],
  '/README.md': ['# Title', 'a literal a|b pipe', 'xx'],
};

const ENTRIES = [
  ...Object.entries(TREE).map(([path, lines]) => ({ type: 'file' as const, path, content: lines.join('\n') })),
  ...['/sub', '/sub/deep', '/scripts', '/empty'].map(path => ({ type: 'directory' as const, path, content: undefined })),
  { type: 'file' as const, path: '/logo.png', content: new ArrayBuffer(4) },
];

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  updateFile: vi.fn(),
  listFiles: vi.fn().mockResolvedValue([]),
  listDirectories: vi.fn().mockResolvedValue([]),
  getFileTree: vi.fn().mockResolvedValue([]),
  getAllFilesAndDirectories: vi.fn().mockResolvedValue(ENTRIES),
};

vi.mock('@/lib/vfs', () => ({ getActiveVFS: () => mockVfs, vfs: mockVfs }));
vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function exec(cmd: string[], stdin?: string) {
  const { vfsShell } = await import('../cli-shell');
  return vfsShell.execute('test', cmd, stdin);
}

/** The command's output lines, blank separators dropped. */
const out = async (cmd: string[], stdin?: string) =>
  ((await exec(cmd, stdin)).stdout ?? '').split('\n').filter(line => line !== '');

/** The files a command's output names, in order and once each. */
const filesOf = async (cmd: string[]) => [...new Set((await out(cmd)).map(line => line.split(':')[0]))];

const EVERY_MATCH = ['/a.txt', '/sub/b.txt', '/sub/deep/c.css', '/styles.css', '/index.html', '/scripts/app.js'];

beforeEach(() => vi.clearAllMocks());

describe('rg: paths', () => {
  it('searches every path given, in the order given, and a file under two of them once', async () => {
    expect(await out(['rg', 'MATCH', '/sub', '/a.txt', '/sub/b.txt'])).toEqual([
      '/sub/b.txt:2:MATCH in sub',
      '/sub/deep/c.css:1:.MATCH { color: red }',
      '/a.txt:2:beta MATCH one',
      '/a.txt:5:epsilon MATCH two',
    ]);
  });

  it('says so when a path names nothing, and still prints what the others hold', async () => {
    const alone = await exec(['rg', 'MATCH', '/nope']);
    expect(alone.success).toBe(false);
    expect(alone.stderr).toBe('rg: /nope: No such file or directory');

    const mixed = await exec(['rg', 'MATCH', 'missing.txt', '/sub/b.txt']);
    expect(mixed.success).toBe(false);
    expect(mixed.stderr).toBe('rg: missing.txt: No such file or directory');
    expect(mixed.stdout).toBe('/sub/b.txt:2:MATCH in sub');
  });

  it('takes a folder with nothing in it, and a binary file, as there and without matches', async () => {
    for (const path of ['/empty', '/empty/', '/logo.png']) {
      const r = await exec(['rg', 'MATCH', path]);
      expect(r, path).toMatchObject({ success: true, stdout: '', stderr: '' });
    }
  });

  it('expands a glob given as a path, which the shell leaves alone for this command', async () => {
    expect(await filesOf(['rg', 'MATCH', '/sub/*.txt'])).toEqual(['/sub/b.txt']);
    expect(await filesOf(['rg', 'MATCH', '/s*'])).toEqual(['/scripts/app.js', '/styles.css', '/sub/b.txt', '/sub/deep/c.css']);
    expect(await filesOf(['rg', 'MATCH', '/**/*.css'])).toEqual(['/styles.css', '/sub/deep/c.css']);
    expect((await exec(['rg', 'MATCH', '/*.zzz'])).stderr).toBe('rg: /*.zzz: No such file or directory');
  });

  it('reads piped input when no path is given, or the path is -', async () => {
    const piped = 'l1\nl2 MATCH\nl3';
    expect((await exec(['rg', 'MATCH', '-'], piped)).stdout).toBe('2:l2 MATCH');
    expect((await exec(['rg', '-c', 'MATCH'], piped)).stdout).toBe('1');
    expect((await exec(['rg', '-l', 'MATCH'], piped)).stdout).toBe('<stdin>');
  });
});

describe('rg: flags', () => {
  const CONTEXT = ['/a.txt:4:delta', '/a.txt:5:epsilon MATCH two', '/a.txt:6:zeta concat'];

  it.each([
    [['-C1', 'epsilon', '/a.txt']],
    [['-C', '1', 'epsilon', '/a.txt']],
    [['-nC1', 'epsilon', '/a.txt']],
    [['--context=1', 'epsilon', '/a.txt']],
    [['--context', '1', 'epsilon', '/a.txt']],
    [['-A1', '-B1', 'epsilon', '/a.txt']],
    [['epsilon', '/a.txt', '-C', '1']],
  ])('reads a number written onto the flag or after it: %j', async (args) => {
    expect(await out(['rg', ...args])).toEqual(CONTEXT);
  });

  it('lets -A and -B stand over -C, whichever comes first', async () => {
    const expected = ['/a.txt:3:gamma cat', '/a.txt:4:delta', '/a.txt:5:epsilon MATCH two'];
    expect(await out(['rg', '-C2', '-A0', 'epsilon', '/a.txt'])).toEqual(expected);
    expect(await out(['rg', '-A0', '-C2', 'epsilon', '/a.txt'])).toEqual(expected);
    expect(await out(['rg', '-C1', '-B0', 'epsilon', '/a.txt'])).toEqual(['/a.txt:5:epsilon MATCH two', '/a.txt:6:zeta concat']);
  });

  it('refuses a number flag given something else, instead of taking the pattern for it', async () => {
    const r = await exec(['rg', '-C', 'MATCH', '/sub']);
    expect(r.success).toBe(false);
    expect(r.stderr).toBe('rg: -C needs a number after it, not "MATCH"');
    expect((await exec(['rg', 'MATCH', '/sub', '-A'])).stderr).toBe('rg: -A needs a value after it');
  });

  it.each([
    [['-r', 'x', 'MATCH', '/'], '-r'],
    [['--json', 'MATCH', '/'], '--json'],
    [['-3', 'MATCH', '/'], '-3'],
    [['-nq', 'MATCH', '/'], '-q'],
    // What follows an unknown letter may be its value, so it is not read as more flags.
    [['-qz', 'MATCH', '/'], '-q'],
    [['--no-heading=1', 'MATCH', '/'], '--no-heading=1'],
    // Names every object has: the table is read for its own flags only.
    [['--constructor', 'MATCH', '/'], '--constructor'],
    [['--toString', 'MATCH', '/'], '--toString'],
    [['--__proto__', 'MATCH', '/'], '--__proto__'],
  ])('refuses a flag it does not have, by name: %j', async (args, flag) => {
    const r = await exec(['rg', ...args]);
    expect(r.success).toBe(false);
    expect(r.stdout).toBe('');
    expect(r.stderr!.split('\n')[0]).toBe(`rg: unsupported flag: ${flag}`);
    expect(r.stderr).toContain('Usage: rg [FLAGS] PATTERN [PATH ...]');
  });

  it('takes the flags that change nothing here', async () => {
    const plain = await out(['rg', 'MATCH', '/sub']);
    expect(plain).toHaveLength(2);
    expect(await out(['rg', '--hidden', '--no-ignore', '-uu', '--no-heading', '--color', 'never', '-H', '-j', '4', 'MATCH', '/sub'])).toEqual(plain);
  });

  it('names the files with -l, counts them with -c, lists them with --files', async () => {
    expect(await out(['rg', '-l', 'MATCH', '/sub', '/a.txt'])).toEqual(['/sub/b.txt', '/sub/deep/c.css', '/a.txt']);
    expect(await out(['rg', '--files-with-matches', 'one', '/'])).toEqual(['/a.txt', '/sub/b.txt']);
    expect(await out(['rg', '-c', 'MATCH', '/a.txt', '/sub', '/README.md'])).toEqual(['/a.txt:2', '/sub/b.txt:1', '/sub/deep/c.css:1']);
    expect(await out(['rg', '--files', '/sub', '/a.txt'])).toEqual(['/sub/b.txt', '/sub/deep/c.css', '/a.txt']);
    expect(await out(['rg', '--files', '-g', '*.css'])).toEqual(['/sub/deep/c.css', '/styles.css']);
  });

  it('answers a count for one named file with the number alone, a zero included', async () => {
    // ripgrep prints nothing for the zero and says it with its exit status, which a pipe here
    // does not carry.
    expect((await exec(['rg', '-c', 'MATCH', '/a.txt'])).stdout).toBe('2');
    expect((await exec(['rg', '-c', 'MATCH', '/README.md'])).stdout).toBe('0');
    // A folder that happens to hold one file is still a folder: the count says which file.
    expect((await exec(['rg', '-c', 'MATCH', '/scripts'])).stdout).toBe('/scripts/app.js:1');
    expect((await exec(['grep', '-c', 'MATCH', '/scripts'])).stdout).toBe('/scripts/app.js:1');
  });

  it('names the one file a count is for when -H asks for its name', async () => {
    expect((await exec(['rg', '-cH', 'MATCH', '/a.txt'])).stdout).toBe('/a.txt:2');
    // A zero for one named file is printed, as with -c alone, where ripgrep prints nothing.
    expect((await exec(['rg', '-cH', 'MATCH', '/README.md'])).stdout).toBe('/README.md:0');
    expect((await exec(['grep', '-cH', 'MATCH', '/a.txt'])).stdout).toBe('/a.txt:2');
    expect((await exec(['grep', '-c', '--with-filename', 'MATCH', '/README.md'])).stdout).toBe('/README.md:0');
    // The last of -H and -h stands.
    expect((await exec(['grep', '-cHh', 'MATCH', '/a.txt'])).stdout).toBe('2');
  });

  it('matches text with -F, words with -w, the other lines with -v, any of several with -e', async () => {
    expect(await out(['rg', '-F', 'a.b(', '/'])).toEqual(['/sub/b.txt:3:three a.b(']);
    expect(await out(['rg', 'cat', '/a.txt'])).toEqual(['/a.txt:3:gamma cat', '/a.txt:6:zeta concat']);
    expect(await out(['rg', '-w', 'cat', '/a.txt'])).toEqual(['/a.txt:3:gamma cat']);
    expect(await out(['rg', '-v', 'MATCH', '/sub/b.txt'])).toEqual(['/sub/b.txt:1:one', '/sub/b.txt:3:three a.b(']);
    expect(await out(['rg', '-e', 'alpha', '-e', 'zeta', '/a.txt'])).toEqual(['/a.txt:1:alpha', '/a.txt:6:zeta concat']);
    expect(await out(['rg', '-e', 'MATCH', '/sub/b.txt'])).toEqual(['/sub/b.txt:2:MATCH in sub']);
  });

  it('prints the matching part with -o, and stops at -m lines', async () => {
    expect(await out(['rg', '-o', 'MATCH \\w+', '/a.txt', '/sub'])).toEqual(['/a.txt:2:MATCH one', '/a.txt:5:MATCH two', '/sub/b.txt:2:MATCH in']);
    expect(await out(['rg', '-m', '1', 'MATCH', '/a.txt'])).toEqual(['/a.txt:2:beta MATCH one']);
    expect(await out(['rg', '-om1', 'MATCH', '/a.txt'])).toEqual(['/a.txt:2:MATCH']);
  });

  it('puts a blank line between files where whole lines are printed, and none between matches alone', async () => {
    expect((await exec(['rg', 'MATCH', '/sub'])).stdout).toBe('/sub/b.txt:2:MATCH in sub\n\n/sub/deep/c.css:1:.MATCH { color: red }');
    expect((await exec(['rg', '-o', 'MATCH', '/sub'])).stdout).toBe('/sub/b.txt:2:MATCH\n/sub/deep/c.css:1:MATCH');
  });

  it('ignores case with -i, and with -S only for a pattern without a capital', async () => {
    const lower = ['/index.html:2:<p>match lower</p>'];
    const any = ['/index.html:1:<h1 class="MATCH">Title</h1>', ...lower];
    expect(await out(['rg', 'match', '/index.html'])).toEqual(lower);
    expect(await out(['rg', '-i', 'match', '/index.html'])).toEqual(any);
    expect(await out(['rg', '--ignore-case', 'match', '/index.html'])).toEqual(any);
    expect(await out(['rg', '-S', 'match', '/index.html'])).toEqual(any);
    expect(await out(['rg', '-S', 'Match', '/scripts/app.js'])).toEqual(['/scripts/app.js:3:Match mixed']);
    expect(await out(['rg', '-S', 'match\\S', '/index.html'])).toEqual(any.slice(0, 1));
    expect(await out(['rg', '-i', '-s', 'match', '/index.html'])).toEqual(lower);
    expect(await out(['rg', '(?i)match', '/index.html'])).toEqual(any);
  });

  it('drops line numbers with -N and file names with -I', async () => {
    expect(await out(['rg', '-N', 'MATCH', '/sub/b.txt'])).toEqual(['/sub/b.txt:MATCH in sub']);
    expect(await out(['rg', '-I', 'MATCH', '/sub/b.txt'])).toEqual(['2:MATCH in sub']);
    expect(await out(['rg', '-NI', 'MATCH', '/sub/b.txt'])).toEqual(['MATCH in sub']);
  });

  it('takes a pattern that starts with a dash after -e or --', async () => {
    const both = ['/styles.css:1::root { --accent: #f00 }', '/styles.css:2:.btn { color: var(--accent) } /* MATCH */'];
    expect(await out(['rg', '-e', '--accent', '/styles.css'])).toEqual(both);
    expect(await out(['rg', '--', '--accent', '/styles.css'])).toEqual(both);
  });

  it('answers a pattern that is not an expression with the reason, and how to search for it as text', async () => {
    const r = await exec(['rg', 'foo(', '/']);
    expect(r.success).toBe(false);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^rg: regex parse error: .*Unterminated group/);
    expect(r.stderr).toContain('add -F');
    expect(await out(['rg', '-F', 'foo(', '/'])).toEqual(['/scripts/app.js:2:call foo(bar)']);
  });

  it('reads a POSIX class in a bracket expression', async () => {
    expect(await out(['rg', '[[:space:]]in', '/sub'])).toEqual(['/sub/b.txt:2:MATCH in sub']);
    expect(await out(['rg', '[^[:alnum:]]MATCH', '/sub'])).toEqual(['/sub/deep/c.css:1:.MATCH { color: red }']);
  });
});

describe('whole words', () => {
  const ACCENT = ['/styles.css:1::root { --accent: #f00 }', '/styles.css:2:.btn { color: var(--accent) } /* MATCH */'];

  it('takes a pattern that starts or ends with a character no word has, with -w', async () => {
    expect(await out(['rg', '-w', '-e', '--accent', '/styles.css'])).toEqual(ACCENT);
    expect(await out(['grep', '-nw', '-e', '--accent', '/styles.css'])).toEqual(ACCENT);
    expect(await out(['rg', '-wF', 'a.b(', '/sub/b.txt'])).toEqual(['/sub/b.txt:3:three a.b(']);
    expect(await out(['grep', '-wF', '.btn', '/styles.css'])).toEqual(['/styles.css:.btn { color: var(--accent) } /* MATCH */']);
  });

  it('still refuses a match with a word character against either end, with -w', async () => {
    expect(await out(['rg', '-wF', '.b(', '/sub/b.txt'])).toEqual([]);
    expect(await out(['grep', '-w', 'conca', '/a.txt'])).toEqual([]);
  });

  it('reads \\< and \\> as the start and the end of a word', async () => {
    expect(await out(['grep', '\\<cat\\>', '/a.txt'])).toEqual(['/a.txt:gamma cat']);
    expect(await out(['rg', '\\<cat', '/a.txt'])).toEqual(['/a.txt:3:gamma cat']);
    expect(await out(['grep', '-E', 'cat\\>', '/a.txt'])).toEqual(['/a.txt:gamma cat', '/a.txt:zeta concat']);
    expect(await out(['grep', '\\<accent', '/styles.css'])).toEqual(ACCENT.map(line => line.replace(/:\d+:/, ':')));
    // A space ends no word: \> is not a plain word boundary, which would match before "MATCH".
    expect(await out(['grep', '-c', ' \\>', '/a.txt'])).toEqual(['0']);
    // Inside a bracket expression they are the characters, and with -F the text.
    expect(await out(['grep', '-c', '[\\<]', '/index.html'])).toEqual(['2']);
    expect(await out(['grep', '-c', '^[\\<]', '/index.html'])).toEqual(['2']);
    expect(await out(['grep', '-c', '^[\\<]', '/a.txt'])).toEqual(['0']);
    expect(await out(['grep', '-F', '\\<cat', '/a.txt'])).toEqual([]);
  });
});

describe('rg: which files', () => {
  it.each([
    [['-g', '*.css'], ['/sub/deep/c.css', '/styles.css']],
    [['--glob=*.css'], ['/sub/deep/c.css', '/styles.css']],
    [['-g', '!*.css'], ['/a.txt', '/sub/b.txt', '/index.html', '/scripts/app.js']],
    [['-g', '*.{css,html}'], ['/sub/deep/c.css', '/styles.css', '/index.html']],
    [['-g', '*.css', '-g', '!styles.css'], ['/sub/deep/c.css']],
    [['-g', 'sub/**'], ['/sub/b.txt', '/sub/deep/c.css']],
    [['-g', 'sub/*'], ['/sub/b.txt']],
    [['-g', '?.txt'], ['/a.txt', '/sub/b.txt']],
    [['-g', '[!a]*.txt'], ['/sub/b.txt']],
    [['-g', '!sub'], ['/a.txt', '/styles.css', '/index.html', '/scripts/app.js']],
    [['-g', '!sub/'], ['/a.txt', '/styles.css', '/index.html', '/scripts/app.js']],
    [['-g', '!deep'], ['/a.txt', '/sub/b.txt', '/styles.css', '/index.html', '/scripts/app.js']],
    [['-g', '/a.txt'], ['/a.txt']],
    [['-g', 'b.txt'], ['/sub/b.txt']],
    [['-g', 'deep/*.css'], []],
    [['-g', '**/deep/*.css'], ['/sub/deep/c.css']],
    [['-g', 'scripts/*.js'], ['/scripts/app.js']],
    [['-g', '[as]*.*'], ['/a.txt', '/styles.css', '/scripts/app.js']],
    [['-t', 'css'], ['/sub/deep/c.css', '/styles.css']],
    [['-tcss'], ['/sub/deep/c.css', '/styles.css']],
    [['--type=css'], ['/sub/deep/c.css', '/styles.css']],
    [['-t', 'html', '-t', 'js'], ['/index.html', '/scripts/app.js']],
    [['-T', 'css'], ['/a.txt', '/sub/b.txt', '/index.html', '/scripts/app.js']],
  ])('%j', async (filter, files) => {
    const r = await exec(['rg', '-l', ...filter, 'MATCH', '/']);
    if (files.length === 0) {
      // Nothing passed the filter: that is not the same answer as "no match".
      expect(r.success).toBe(false);
      expect(r.stderr).toContain('rg: no files were searched');
    } else {
      expect(r.stdout!.split('\n')).toEqual(files);
    }
  });

  it.each([
    ['[]]*', '/]x.txt'],
    ['[!]a]*.txt', '/sub/b.txt'],
  ])('reads a ] first in a [...] class as a member of it: %s', async (glob, listed) => {
    mockVfs.getAllFilesAndDirectories.mockResolvedValue([...ENTRIES, { type: 'file' as const, path: '/]x.txt', content: 'x' }]);
    try {
      expect((await exec(['rg', '--files', '-g', glob, '/'])).stdout).toBe(listed);
    } finally {
      mockVfs.getAllFilesAndDirectories.mockResolvedValue(ENTRIES);
    }
  });

  it('leaves out nothing without a filter', async () => {
    expect(await filesOf(['rg', '-l', 'MATCH', '/'])).toEqual(EVERY_MATCH);
  });

  it('takes a folder glob as what is in the folder', async () => {
    // ripgrep reads nothing for this one and warns that no files were searched.
    expect(await filesOf(['rg', '-l', '-g', 'sub/', 'MATCH', '/'])).toEqual(['/sub/b.txt', '/sub/deep/c.css']);
  });

  it('reads a file asked for by name whatever the filters say', async () => {
    expect(await filesOf(['rg', '-g', '*.css', 'MATCH', '/a.txt', '/sub'])).toEqual(['/a.txt', '/sub/deep/c.css']);
    expect(await filesOf(['rg', '-g', '*.css', 'MATCH', '/sub', '/sub/b.txt'])).toEqual(['/sub/b.txt', '/sub/deep/c.css']);
    expect(await filesOf(['rg', '-t', 'css', 'MATCH', '/a.txt'])).toEqual(['/a.txt']);
  });

  it('refuses a type it has no list for, and names the ones it has', async () => {
    const r = await exec(['rg', '-t', 'cobol', 'MATCH', '/']);
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('rg: unrecognized file type: cobol');
    expect(r.stderr).toContain('css, csv, hbs, html, js');
  });
});

describe('grep: paths and flags', () => {
  it('searches every path given', async () => {
    expect(await out(['grep', 'MATCH', '/sub/b.txt', '/a.txt'])).toEqual([
      '/sub/b.txt:MATCH in sub',
      '/a.txt:beta MATCH one',
      '/a.txt:epsilon MATCH two',
    ]);
    expect(await out(['grep', '-c', 'MATCH', '/a.txt', '/sub/b.txt', '/README.md'])).toEqual(['/a.txt:2', '/sub/b.txt:1']);
  });

  it('says so when a path names nothing, and expands a glob given as a path', async () => {
    const r = await exec(['grep', 'MATCH', '/nope', '/sub/b.txt']);
    expect(r.success).toBe(false);
    expect(r.stderr).toBe('grep: /nope: No such file or directory');
    expect(r.stdout).toBe('/sub/b.txt:MATCH in sub');
    expect((await exec(['grep', 'MATCH', '/empty'])).success).toBe(true);
    expect(await filesOf(['grep', 'MATCH', '/sub/*.txt'])).toEqual(['/sub/b.txt']);
    // One file, however it was named, answers a count with the number alone.
    expect((await exec(['grep', '-c', 'MATCH', '/sub/*.txt'])).stdout).toBe('1');
  });

  it.each([
    [['-r', 'MATCH', '/sub/b.txt']],
    [['-R', 'MATCH', '/sub/b.txt']],
    [['-rH', 'MATCH', '/sub/b.txt']],
    [['-rsI', 'MATCH', '/sub/b.txt']],
    [['--recursive', '--color=auto', 'MATCH', '/sub/b.txt']],
    [['--color', 'MATCH', '/sub/b.txt']],
    [['-E', 'MATCH', '/sub/b.txt']],
    [['--binary-files=without-match', 'MATCH', '/sub/b.txt']],
  ])('takes the flags that change nothing here: %j', async (args) => {
    expect(await out(['grep', ...args])).toEqual(['/sub/b.txt:MATCH in sub']);
  });

  it('reads -rn as two flags, and a bare number as that many lines of context', async () => {
    expect(await out(['grep', '-rn', 'MATCH', '/sub'])).toEqual(['/sub/b.txt:2:MATCH in sub', '/sub/deep/c.css:1:.MATCH { color: red }']);
    const context = ['/a.txt:4:delta', '/a.txt:5:epsilon MATCH two', '/a.txt:6:zeta concat'];
    expect(await out(['grep', '-n', '-1', 'epsilon', '/a.txt'])).toEqual(context);
    expect(await out(['grep', '-nC1', 'epsilon', '/a.txt'])).toEqual(context);
    expect(await out(['grep', '-n', '--context=1', 'epsilon', '/a.txt'])).toEqual(context);
    expect(await out(['grep', '-n', '-A1', 'epsilon', '/a.txt'])).toEqual(context.slice(1));
    // -A and -B stand over -C, whichever comes first.
    expect(await out(['grep', '-n', '-C2', '-A0', 'epsilon', '/a.txt'])).toEqual(['/a.txt:3:gamma cat', ...context.slice(0, 2)]);
    expect(await out(['grep', '-n', '-B0', '-C1', 'epsilon', '/a.txt'])).toEqual(context.slice(1));
  });

  it('reads piped input when no path is given, or the path is -', async () => {
    const piped = 'l1\nl2 MATCH\nl3';
    expect((await exec(['grep', '-n', 'MATCH', '-'], piped)).stdout).toBe('2:l2 MATCH');
    expect((await exec(['grep', '-c', 'MATCH'], piped)).stdout).toBe('1');
    expect((await exec(['grep', '-l', 'MATCH'], piped)).stdout).toBe('(standard input)');
  });

  it('puts a blank line between files only where context is printed', async () => {
    expect((await exec(['grep', 'MATCH', '/sub'])).stdout).toBe('/sub/b.txt:MATCH in sub\n/sub/deep/c.css:.MATCH { color: red }');
    expect((await exec(['grep', '-A1', 'MATCH', '/sub'])).stdout)
      .toBe('/sub/b.txt:MATCH in sub\n/sub/b.txt:three a.b(\n\n/sub/deep/c.css:.MATCH { color: red }\n/sub/deep/c.css:.other { width: 100px }');
  });

  it('refuses a flag it does not have by the name it was written with', async () => {
    const long = await exec(['grep', '--null', 'x', '/']);
    expect(long.success).toBe(false);
    expect(long.stderr!.split('\n')[0]).toBe('grep: unsupported flag: --null');
    expect((await exec(['grep', '-nq', 'x', '/'])).stderr!.split('\n')[0]).toBe('grep: unsupported flag: -q');
    expect((await exec(['grep', '-C', 'x', '/'])).stderr).toBe('grep: -C needs a number after it, not "x"');
  });

  it('matches words with -w, the other lines with -v, any of several with -e, and stops at -m', async () => {
    expect(await out(['grep', '-w', 'cat', '/a.txt'])).toEqual(['/a.txt:gamma cat']);
    expect(await out(['grep', '-v', 'MATCH', '/sub/b.txt'])).toEqual(['/sub/b.txt:one', '/sub/b.txt:three a.b(']);
    expect(await out(['grep', '-e', 'alpha', '-e', 'zeta', '/a.txt'])).toEqual(['/a.txt:alpha', '/a.txt:zeta concat']);
    expect(await out(['grep', '-m', '1', 'MATCH', '/a.txt'])).toEqual(['/a.txt:beta MATCH one']);
    expect(await out(['grep', '-vc', 'MATCH', '/a.txt'])).toEqual(['4']);
  });

  it('drops the file name with -h, and prints no empty match with -o', async () => {
    expect(await out(['grep', '-h', 'MATCH', '/sub/b.txt', '/a.txt'])).toEqual(['MATCH in sub', 'beta MATCH one', 'epsilon MATCH two']);
    expect(await out(['grep', '-hc', 'MATCH', '/sub/b.txt', '/a.txt'])).toEqual(['1', '2']);
    expect(await out(['grep', '-o', 'x*', '/README.md'])).toEqual(['/README.md:xx']);
  });

  it('chooses files by name with --include, --exclude and --exclude-dir', async () => {
    expect(await filesOf(['grep', '-r', '--include=*.css', 'MATCH', '/'])).toEqual(['/sub/deep/c.css', '/styles.css']);
    expect(await filesOf(['grep', '-r', '--include', '*.css', '--include', '*.html', 'MATCH', '/'])).toEqual(['/sub/deep/c.css', '/styles.css', '/index.html']);
    expect(await filesOf(['grep', '-r', '--exclude=*.css', 'MATCH', '/'])).toEqual(['/a.txt', '/sub/b.txt', '/index.html', '/scripts/app.js']);
    expect(await filesOf(['grep', '-r', '--exclude-dir=sub', 'MATCH', '/'])).toEqual(['/a.txt', '/styles.css', '/index.html', '/scripts/app.js']);
    expect(await filesOf(['grep', '-r', '--exclude-dir=deep', 'MATCH', '/'])).toEqual(['/a.txt', '/sub/b.txt', '/styles.css', '/index.html', '/scripts/app.js']);
    // It names folders: a file whose own name matches stays.
    expect(await filesOf(['grep', '-r', '--exclude-dir=*.txt', 'MATCH', '/'])).toEqual(EVERY_MATCH);
  });

  it('reads long flags as whole words', async () => {
    expect(await out(['grep', '--ignore-case', '--line-number', 'match', '/index.html'])).toEqual([
      '/index.html:1:<h1 class="MATCH">Title</h1>',
      '/index.html:2:<p>match lower</p>',
    ]);
    expect(await out(['grep', '--count', 'MATCH', '/a.txt'])).toEqual(['2']);
    expect(await out(['grep', '--files-with-matches', 'MATCH', '/sub'])).toEqual(['/sub/b.txt', '/sub/deep/c.css']);
  });
});

describe('grep: the pattern dialect', () => {
  it('reads a backslashed operator as the operator, the way a basic expression writes it', async () => {
    const either = ['/sub/b.txt:MATCH in sub', '/sub/b.txt:three a.b('];
    expect(await out(['grep', 'MATCH\\|three', '/sub/b.txt'])).toEqual(either);
    expect(await out(['grep', '\\(MATCH\\|three\\) ', '/sub/b.txt'])).toEqual(either);
    expect(await out(['grep', 'MATC[A-Z]\\+ in', '/sub/b.txt'])).toEqual(either.slice(0, 1));
    expect(await out(['grep', 'x\\?MATCH', '/sub/b.txt'])).toEqual(either.slice(0, 1));
    expect(await out(['grep', '[0-9]\\{3\\}px', '/sub'])).toEqual(['/sub/deep/c.css:.other { width: 100px }']);
    expect(await out(['grep', '[0-9]\\{4\\}px', '/sub'])).toEqual([]);
  });

  it('reads the same backslashes as plain characters with -E or -P', async () => {
    const literal = ['/README.md:a literal a|b pipe'];
    expect(await out(['grep', '-E', 'a\\|b', '/README.md'])).toEqual(literal);
    expect(await out(['grep', '-P', 'a\\|b', '/README.md'])).toEqual(literal);
    // Without either, the same pattern is "a or b".
    expect(await out(['grep', 'a\\|b', '/README.md'])).toEqual(['/README.md:a literal a|b pipe']);
    expect(await out(['grep', '-c', 'a\\|b', '/a.txt'])).toEqual(['5']);
    expect(await out(['grep', '-cE', 'a\\|b', '/a.txt'])).toEqual(['0']);
  });

  it('keeps an unescaped operator working without -E, which the real grep would read as text', async () => {
    expect(await out(['grep', 'MATCH|three', '/sub/b.txt'])).toEqual(['/sub/b.txt:MATCH in sub', '/sub/b.txt:three a.b(']);
  });

  it('finds an unescaped parenthesis that could not be an operator', async () => {
    expect(await out(['grep', 'foo(', '/scripts'])).toEqual(['/scripts/app.js:call foo(bar)']);
    expect(await out(['grep', '-n', 'a\\.b(', '/sub'])).toEqual(['/sub/b.txt:3:three a.b(']);
  });

  it('answers a pattern that is no expression in either reading with the reason', async () => {
    for (const args of [['-E', 'foo(', '/scripts'], ['foo\\(', '/scripts']]) {
      const r = await exec(['grep', ...args]);
      expect(r.success, args.join(' ')).toBe(false);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^grep: Invalid regular expression/);
      expect(r.stderr).toContain('add -F');
    }
  });

  it('reads a closing bracket that opens a bracket expression as a member of it', async () => {
    expect(await out(['grep', '-c', '[])]', '/scripts/app.js'])).toEqual(['1']);
    expect(await out(['grep', '-c', '[^])]$', '/scripts/app.js'])).toEqual(['2']);
  });

  it('reads a POSIX class in a bracket expression', async () => {
    expect(await out(['grep', '[[:space:]]in', '/sub'])).toEqual(['/sub/b.txt:MATCH in sub']);
    expect(await out(['grep', '-c', '^[[:upper:]]', '/sub/b.txt'])).toEqual(['1']);
  });
});

describe('a path that names nothing', () => {
  it('goes without its message with -s or --no-messages, and still fails', async () => {
    for (const cmd of [['grep', '-s'], ['grep', '--no-messages'], ['rg', '--no-messages']]) {
      const r = await exec([...cmd, 'MATCH', '/nope', '/sub/b.txt']);
      expect(r, cmd.join(' ')).toMatchObject({ success: false, stderr: '' });
      expect(r.stdout, cmd.join(' ')).toContain('/sub/b.txt:');
    }
  });
});

describe('a redirect', () => {
  it('writes the output to the file, and an output of nothing empties it', async () => {
    for (const cmd of [['grep', '-l', 'zzz', '/'], ['rg', '-l', 'zzz', '/'], ['grep', '-c', 'zzz', '/a.txt', '/sub/b.txt'], ['rg', 'zzz', '/a.txt']]) {
      mockVfs.createFile.mockClear();
      const r = await exec([...cmd, '>', '/out.txt']);
      expect(r, cmd.join(' ')).toMatchObject({ success: true, stdout: '' });
      expect(mockVfs.createFile, cmd.join(' ')).toHaveBeenCalledWith('test', '/out.txt', '');
    }
    await exec(['grep', '-l', 'MATCH', '/sub', '>', '/out.txt']);
    expect(mockVfs.createFile).toHaveBeenLastCalledWith('test', '/out.txt', '/sub/b.txt\n/sub/deep/c.css');
  });

  it('still writes what the paths that exist gave, when another path names nothing', async () => {
    for (const tool of ['grep', 'rg']) {
      mockVfs.createFile.mockClear();
      const r = await exec([tool, '-l', 'MATCH', '/sub', '/nope', '>', '/out.txt']);
      // The file gets the output and the answer is the failure alone, as in a shell.
      expect(mockVfs.createFile, tool).toHaveBeenCalledWith('test', '/out.txt', '/sub/b.txt\n/sub/deep/c.css');
      expect(r, tool).toMatchObject({ success: false, stdout: '', stderr: `${tool}: /nope: No such file or directory` });
    }
  });
});

describe('a command that throws', () => {
  it('answers with the error on stderr, where the rest of the command line can go on from it', async () => {
    mockVfs.getAllFilesAndDirectories.mockRejectedValueOnce(new Error('storage is gone'));
    const r = await exec(['rg', 'MATCH', '/']);
    expect(r).toMatchObject({ success: false, stdout: '', stderr: 'storage is gone' });
  });
});
