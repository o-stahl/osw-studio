import { describe, it, expect, vi, beforeEach } from 'vitest';

let writtenContent = '';

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  updateFile: vi.fn().mockImplementation((_pid: string, _path: string, content: string) => {
    writtenContent = content;
  }),
  listFiles: vi.fn().mockResolvedValue([]),
  listDirectories: vi.fn().mockResolvedValue([]),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
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

async function exec(cmd: string[], stdin?: string) {
  const { vfsShell } = await import('../cli-shell');
  return vfsShell.execute('test', cmd, stdin);
}

beforeEach(() => {
  vi.clearAllMocks();
  writtenContent = '';
});

// ---------- grep -o ----------

describe('grep -o (only matching)', () => {
  it('outputs only the matched portion from stdin', async () => {
    const result = await exec(
      ['grep', '-o', 'href="[^"]*"'],
      '<a href="page1.html">Link</a>\n<a href="page2.html">Other</a>'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('href="page1.html"\nhref="page2.html"');
  });

  it('outputs multiple matches per line separately', async () => {
    const result = await exec(
      ['grep', '-o', '\\d+'],
      'abc 123 def 456 ghi'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('123\n456');
  });

  it('combines -o with -n to show line numbers', async () => {
    const result = await exec(
      ['grep', '-on', '\\d+'],
      'no numbers\nabc 42 def\nxyz'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('2:42');
  });

  it('outputs matched portions from files', async () => {
    mockVfs.getAllFilesAndDirectories.mockResolvedValueOnce([
      { path: '/test.html', content: '<img src="a.png"> and <img src="b.jpg">' },
    ]);
    const result = await exec(['grep', '-o', 'src="[^"]*"', '/test.html']);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('/test.html:src="a.png"\n/test.html:src="b.jpg"');
  });

  it('returns empty output when -o finds no matches', async () => {
    const result = await exec(['grep', '-o', 'zzz'], 'abc def');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('');
  });
});

// ---------- grep -P (no-op PCRE) ----------

describe('grep -P (PCRE no-op)', () => {
  it('accepts -P without error', async () => {
    const result = await exec(['grep', '-P', '\\d+'], 'abc 123\ndef');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('abc 123');
  });
});

// ---------- sed ! negate ----------

describe('sed ! negate modifier', () => {
  it('single-address !d deletes lines NOT matching pattern', async () => {
    const result = await exec(
      ['sed', '/keep/!d'],
      'drop this\nkeep this\ndrop that\nkeep that'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('keep this\nkeep that');
  });

  it('single-address !p with -n prints non-matching lines', async () => {
    const result = await exec(
      ['sed', '-n', '/skip/!p'],
      'show\nskip\nshow too'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('show\nshow too');
  });

  it('range !d deletes lines OUTSIDE the range', async () => {
    const result = await exec(
      ['sed', '2,4!d'],
      'line1\nline2\nline3\nline4\nline5'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('line2\nline3\nline4');
  });
});

// ---------- sed {...} grouping ----------

describe('sed {...} command grouping', () => {
  it('applies sub-command within a range', async () => {
    const input = [
      '<section>',
      '  <p>content</p>',
      '  <p>more</p>',
      '</section>',
      'after',
    ].join('\n');

    const result = await exec(
      ['sed', '/<section>/,/<\\/section>/{/<\\/section>/!d}'],
      input
    );
    expect(result.success).toBe(true);
    // Inside range: lines NOT matching </section> are deleted → only </section> survives
    // Outside range: 'after' is kept
    expect(result.stdout).toBe('</section>\nafter');
  });

  it('group with substitution inside a range', async () => {
    const input = 'AAA\nstart\nBBB\nend\nCCC';
    const result = await exec(
      ['sed', '/start/,/end/{s/BBB/XXX/}'],
      input
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('AAA\nstart\nXXX\nend\nCCC');
  });

  it('single-address group applies to matching line', async () => {
    const result = await exec(
      ['sed', '/target/{s/old/new/}'],
      'target old\nother old'
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('target new\nother old');
  });
});

// ---------- sed substitution feedback ----------

describe('sed scripts of several commands', () => {
  const text = 'l1\nl2\nl3\nl4\nl5\nl6';

  it('runs commands separated by ;', async () => {
    const result = await exec(['sed', '-n', '1,2p;4,5p'], text);
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('l1\nl2\nl4\nl5');
  });

  it('runs commands on separate lines of one script', async () => {
    const result = await exec(['sed', 's/l1/one/\ns/l6/six/'], text);
    expect(result.stdout).toBe('one\nl2\nl3\nl4\nl5\nsix');
  });

  it('keeps a ; inside a pattern, a replacement or a group', async () => {
    expect((await exec(['sed', 's/a;b/c/;s/x/y/'], 'a;b x')).stdout).toBe('c y');
    expect((await exec(['sed', '-n', '/;/p;3p'], 'a\nb;c\nd')).stdout).toBe('b;c\nd');
    expect((await exec(['sed', '2{s/l2/two;2/;s/two/TWO/}'], text)).stdout).toBe('l1\nTWO;2\nl3\nl4\nl5\nl6');
  });

  it('keeps a ; after an escaped delimiter inside a pattern', async () => {
    expect((await exec(['sed', 's/a\\/;b/c/;s/x/y/'], 'a/;b x')).stdout).toBe('c y');
  });

  it('keeps a ; inside appended text, which runs to the end of its line', async () => {
    expect((await exec(['sed', '1a\\x;y'], 'l1\nl2')).stdout).toBe('l1\nx;y\nl2');
  });
});

describe('sed substitution feedback', () => {
  it('reports substitution count on -i success', async () => {
    mockVfs.readFile.mockResolvedValueOnce({ content: 'hello world\nhello there' });
    const result = await exec(['sed', '-i', 's/hello/hi/g', '/test.txt']);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('2 substitutions');
  });

  it('reports zero substitutions when pattern does not match', async () => {
    mockVfs.readFile.mockResolvedValueOnce({ content: 'no match here' });
    const result = await exec(['sed', '-i', 's/zzz/yyy/', '/test.txt']);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('0 substitutions');
    expect(result.stdout).toContain('did not match');
    // Should not write the file when nothing changed
    expect(mockVfs.updateFile).not.toHaveBeenCalled();
  });

});

// ---------- sed combined negate + group + in-place ----------

describe('sed negate + group integration', () => {
  it('real-world pattern: delete section content keeping closing tag', async () => {
    mockVfs.readFile.mockResolvedValueOnce({
      content: [
        '<html>',
        '<section id="hero">',
        '  <h1>Old Title</h1>',
        '  <p>Old text</p>',
        '</section>',
        '<footer>Keep</footer>',
      ].join('\n'),
    });

    const result = await exec([
      'sed', '-i',
      '/<section id="hero">/,/<\\/section>/{/<\\/section>/!d}',
      '/index.html',
    ]);

    expect(result.success).toBe(true);
    expect(writtenContent).toBe(
      '<html>\n</section>\n<footer>Keep</footer>'
    );
  });
});

// ---------- sed backreferences ----------

describe('sed backreferences', () => {
  it('translates \\1 \\2 to $1 $2 in replacement', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'hello world' });
    const result = await exec([
      'sed', '-i', 's/\\(hello\\) \\(world\\)/\\2 \\1/', '/test.txt'
    ]);
    expect(result.success).toBe(true);
    expect(writtenContent).toBe('world hello');
  });

  it('translates & to $& (whole match) in replacement', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'foo bar' });
    const result = await exec([
      'sed', '-i', 's/foo/[&]/', '/test.txt'
    ]);
    expect(result.success).toBe(true);
    expect(writtenContent).toBe('[foo] bar');
  });

  it('preserves literal \\& (escaped ampersand)', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'foo bar' });
    const result = await exec([
      'sed', '-i', 's/foo/a\\&b/', '/test.txt'
    ]);
    expect(result.success).toBe(true);
    expect(writtenContent).toBe('a&b bar');
  });
});

// ---------- sed error messages ----------

describe('sed multiline error message', () => {
  it('suggests ======= separator (not ===) when rejecting \\n patterns', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'test' });
    const result = await exec([
      'sed', '-i', 's/line1\\nline2/replaced/', '/test.txt'
    ]);
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('=======');
    expect(result.stderr).not.toMatch(/[^=]===[^=]/);
  });
});

// ---------- ss separator and entity mode ----------

describe('ss separator format', () => {
  it('splits on ======= (7 equals)', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'old text here' });
    const stdin = 'old text\n=======\nnew text';
    const result = await exec(['ss', '/test.txt'], stdin);
    expect(result.success).toBe(true);
    expect(writtenContent).toBe('new text here');
  });

  it('rejects === (3 equals) as separator', async () => {
    mockVfs.readFile.mockResolvedValue({ content: 'old text here' });
    const stdin = 'old text\n===\nnew text';
    const result = await exec(['ss', '/test.txt'], stdin);
    expect(result.success).toBe(false);
  });

  it('handles JS code with === in content without collision', async () => {
    const fileContent = 'if (x === 5) { return true; }';
    mockVfs.readFile.mockResolvedValue({ content: fileContent });
    const stdin = 'if (x === 5) { return true; }\n=======\nif (x === 10) { return false; }';
    const result = await exec(['ss', '/test.txt'], stdin);
    expect(result.success).toBe(true);
    expect(writtenContent).toBe('if (x === 10) { return false; }');
  });
});

describe('ss --entity without separator', () => {
  it('auto-extracts selector from first line when no separator given', async () => {
    const fileContent = 'function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}';
    mockVfs.readFile.mockResolvedValue({ content: fileContent });
    const stdin = 'function foo() {\n  return 42;\n}';
    const result = await exec(['ss', '--entity', '/test.txt'], stdin);
    expect(result.success).toBe(true);
    expect(writtenContent).toContain('return 42');
    expect(writtenContent).toContain('function bar');
  });
});
