import { describe, it, expect } from 'vitest';
import { parseCommand, parseToolArgs } from '@/lib/agent-activity/parse-command';

describe('parseCommand', () => {
  it('has nothing to say about an empty command', () => {
    expect(parseCommand('   ')).toBeNull();
  });

  it('looks past a leading cd, which is how the agent writes most commands', () => {
    expect(parseCommand('cd / && build')?.kind).toBe('build');
    expect(parseCommand('cd / && status --task "x" --complete')?.kind).toBe('evaluate');
    expect(parseCommand('cd /tmp && ls')?.kind).toBe('list');
    expect(parseCommand('cd / && cat /index.html')).toMatchObject({ kind: 'read', path: '/index.html' });
  });

  it.each([
    ['cat > /index.html', 'write', '/index.html'],
    ['ss /styles.css << \'EOF\'', 'write', '/styles.css'],
    ['cat /about.html', 'read', '/about.html'],
    ['head -n 20 /pages/blog.html', 'read', '/pages/blog.html'],
    ['sed -i s/a/b/ /index.html', 'edit', '/index.html'],
    ['mkdir -p /assets/img', 'create', '/assets/img'],
    ['rm /old.html', 'delete', '/old.html'],
    ['mv /a.html /b.html', 'move', '/b.html'],
    ['cp /a.html /b.html', 'copy', '/b.html'],
  ])('reads %s as %s on %s', (command, kind, path) => {
    expect(parseCommand(command)).toMatchObject({ kind, path });
  });

  it.each([
    ['ls /', 'list'],
    ['grep -n hero /index.html', 'search'],
    ['status done', 'evaluate'],
    ['agent explore "where is the nav"', 'delegate'],
    ['search best pizza', 'lookup'],
    ['generate-image a cat', 'image'],
    ['sqlite3 SELECT 1', 'database'],
    ['runtime restart', 'build'],
    ['spec write', 'spec'],
    ['brief --merge', 'brief'],
    ['propose-create', 'propose'],
    ['ask --prompt "Which look?" "Bold" "Soft"', 'ask'],
    ['someunknowncmd --flag', 'other'],
  ])('reads %s as %s and claims no file', (command, kind) => {
    expect(parseCommand(command)).toMatchObject({ kind, path: null });
  });

  it('reads sed that prints a range, and edits with sed only in place', () => {
    expect(parseCommand('sed -n 60,400p /index.html')).toMatchObject({ kind: 'read', path: '/index.html' });
    expect(parseCommand("sed -i.bak 's/a/b/' /index.html")).toMatchObject({ kind: 'edit', path: '/index.html' });
  });

  it('finds sed\'s file before a quoted script, and never takes the script for a file', () => {
    expect(parseCommand('sed -i /index.html "/^$/d"')).toMatchObject({ kind: 'edit', path: '/index.html', paths: ['/index.html'] });
    expect(parseCommand("sed -n /about.html '/<main>/,/<\\/main>/p'")).toMatchObject({ kind: 'read', paths: ['/about.html'] });
    expect(parseCommand('sed -i "s/old words/new words/" /about.html')).toMatchObject({ kind: 'edit', paths: ['/about.html'] });
  });

  it('treats a redirection as a write even when the line opens with a reading command', () => {
    // Precedence matters: `cat > /x` shares its verb with the read case and is not one.
    expect(parseCommand('cat > /notes.html')?.kind).toBe('write');
  });

  it('still accepts delegate, the pre-v1.70.0 spelling of agent', () => {
    expect(parseCommand('delegate task "do the thing"')).toMatchObject({ kind: 'delegate', detail: 'task' });
  });

  it('reads a chain as its first command, not its last', () => {
    expect(parseCommand('cat /index.html | grep hero')).toMatchObject({ kind: 'read', path: '/index.html' });
    expect(parseCommand('ss /a.css << \'EOF\' && status done')).toMatchObject({ kind: 'write', path: '/a.css' });
  });

  it('leaves a quoted pipe inside a search pattern alone', () => {
    expect(parseCommand('grep -n "hero|banner" /index.html')?.detail).toContain('hero|banner');
  });

  it('finds the file when the verb rule points somewhere that is not one', () => {
    // Real runs put the file before the flags often enough to matter; without the scan this reads
    // as an edit to no particular file.
    expect(parseCommand('sed -i /index.html -e s/a/b/')).toMatchObject({ kind: 'edit', path: '/index.html' });
  });

  it('reads a relative target from the project root, as the shell does, where cd changes nothing', () => {
    expect(parseCommand('cat notes.txt')).toMatchObject({ kind: 'read', path: '/notes.txt', detail: 'notes.txt' });
    expect(parseCommand('cd / && cat scripts/main.js')).toMatchObject({ kind: 'read', path: '/scripts/main.js' });
    expect(parseCommand("cd / && sed -n '211,260p' styles/style.css")).toMatchObject({ kind: 'read', path: '/styles/style.css' });
    expect(parseCommand('cd /styles && cat style.css')).toMatchObject({ path: '/style.css' });
  });

  it('takes every file a command names when it takes several', () => {
    expect(parseCommand('cat /a.html b.css')).toMatchObject({ kind: 'read', path: '/a.html', paths: ['/a.html', '/b.css'] });
    expect(parseCommand('head -n 40 scripts/main.js')).toMatchObject({ paths: ['/scripts/main.js'] });
    expect(parseCommand('tail -n +5 a.html')).toMatchObject({ paths: ['/a.html'] });
    expect(parseCommand('rm -f a.html pages/b.html')).toMatchObject({ kind: 'delete', paths: ['/a.html', '/pages/b.html'] });
  });

  it('names no file above the project root', () => {
    expect(parseCommand('cat ../../home/user/key.txt')).toMatchObject({ kind: 'read', path: null, paths: [] });
    expect(parseCommand('cat /../etc/hosts.conf')).toMatchObject({ path: null, paths: [] });
  });

  it('takes no argument for a file unless it reads as one', () => {
    // A sed script, a line range, a count and an echo's words all sit where a file could.
    expect(parseCommand("sed -i 's/a/b/' index.html")).toMatchObject({ kind: 'edit', paths: ['/index.html'] });
    expect(parseCommand('sed -n 1,80p notes')).toMatchObject({ kind: 'read', path: null, paths: [] });
    expect(parseCommand('echo hello world')).toMatchObject({ kind: 'edit', path: null, paths: [] });
    expect(parseCommand('propose-create landing.page')).toMatchObject({ kind: 'propose', path: null, paths: [] });
  });

  it('reads the setup agent\'s commands as their own, though they carry a heredoc', () => {
    // Taken as heredoc writes, they read "Wrote a file" in describe mode's thread.
    expect(parseCommand("brief --merge << 'EOF'")).toMatchObject({ kind: 'brief', path: null });
    expect(parseCommand(`spec --append "Audience" << 'EOF'`)).toMatchObject({ kind: 'spec', path: null });
  });

  it('writes to a relative redirect target, past a > inside quoted words', () => {
    expect(parseCommand("cat > styles/style.css << 'EOF'")).toMatchObject({ kind: 'write', path: '/styles/style.css' });
    expect(parseCommand('echo "a > b" > out.txt')).toMatchObject({ kind: 'write', path: '/out.txt' });
  });

  it('reads no redirect inside quotes, where a selector or a comparison puts a >', () => {
    expect(parseCommand("sed -i 's/.card > img.thumb {/.card > img.cover {/' /styles.css")).toMatchObject({ kind: 'edit', paths: ['/styles.css'] });
    expect(parseCommand('rg "ul > li.active a" /styles.css')).toMatchObject({ kind: 'search', paths: [] });
    expect(parseCommand('grep -n "a > b.length &&" /app.js')).toMatchObject({ kind: 'search', paths: [] });
    expect(parseCommand('echo hi > "notes.md"')).toMatchObject({ kind: 'write', paths: ['/notes.md'] });
  });

  it('takes an echo\'s file only from an absolute path at its end', () => {
    expect(parseCommand('echo "See /docs/api.md for details"')).toMatchObject({ kind: 'edit', paths: [] });
    expect(parseCommand('echo "Saved to /index.html"')).toMatchObject({ kind: 'edit', paths: ['/index.html'] });
  });

  it('refuses a glob as a path', () => {
    expect(parseCommand('rm /assets/*.png')).toMatchObject({ kind: 'delete', path: null });
  });
});

describe('parseToolArgs', () => {
  it('reads the command out of the arguments the executor reported', () => {
    expect(parseToolArgs('{"command":"cat /index.html"}')).toMatchObject({ kind: 'read', path: '/index.html' });
  });

  it('accepts cmd as well as command', () => {
    expect(parseToolArgs('{"cmd":"ls /"}')?.kind).toBe('list');
  });

  it('has nothing to say about arguments that are still streaming in', () => {
    expect(parseToolArgs('{"command":"cat /ind')).toBeNull();
  });

  it('has nothing to say about arguments that are not a string', () => {
    expect(parseToolArgs({ command: 'cat /index.html' })).toBeNull();
    expect(parseToolArgs(undefined)).toBeNull();
  });

  it('has nothing to say when the arguments carry no command', () => {
    expect(parseToolArgs('{"prompt":"hello"}')).toBeNull();
  });
});

describe('parseCommand, around the shapes the agent actually writes', () => {
  it('still classifies a bare cd as nothing in particular', () => {
    expect(parseCommand('cd /')?.kind).toBe('other');
  });

  it('does not mistake a command merely starting with those letters for a cd', () => {
    expect(parseCommand('cdn-sync /assets')?.kind).toBe('other');
  });

  it('reads a file whose stderr was sent to /dev/null', () => {
    // The read branch refuses any `>` so a real redirect is not read as a read; the stderr form
    // carries no such meaning and must not defeat it.
    expect(parseCommand('cat /.PROMPT.md 2>/dev/null')).toMatchObject({ kind: 'read', path: '/.PROMPT.md' });
    expect(parseCommand('cat /a.md 2>&1')).toMatchObject({ kind: 'read', path: '/a.md' });
  });

  it('still treats a real redirect as a write, not a read', () => {
    expect(parseCommand('cat /a.html > /b.html')).toMatchObject({ kind: 'write', path: '/b.html' });
  });

  it('runs python3, not only python', () => {
    expect(parseCommand('python3 -c "print(1)"')?.kind).toBe('run');
  });
});
