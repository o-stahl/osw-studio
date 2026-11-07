import { describe, it, expect } from 'vitest';
import { classifyCommand } from '@/lib/agent-activity/classify-command';

/**
 * The four buckets a tool call falls into, which the tool row's category (`ToolDisplay`), the
 * large-write pacing notice and the event processor's sub-agent check read.
 *
 * Moved here with the function, from `components/chat-panel/__tests__/event-processor.test.ts`: the
 * classifier is pure logic over a command string and shares this directory with `parseCommand`,
 * which answers the finer question about the same input.
 *
 * The cases at the bottom are the ones that keep the two from being one function -- an `echo` that
 * writes nothing, a read that names its file -- so they are the ones to read before folding
 * `classifyCommand` into `parseCommand`'s kinds.
 */

describe('classifyCommand', () => {
  it('returns bash for undefined', () => {
    expect(classifyCommand(undefined)).toBe('bash');
  });

  it('returns agent for agent commands', () => {
    expect(classifyCommand('agent explore "find auth"')).toBe('agent');
  });

  it('returns agent for delegate commands (backward compat)', () => {
    expect(classifyCommand('delegate explore "find auth"')).toBe('agent');
  });

  it('returns status for status command', () => {
    expect(classifyCommand('status')).toBe('status');
  });

  it('returns status for build command', () => {
    expect(classifyCommand('build')).toBe('status');
  });

  it('returns write for cat with redirect', () => {
    expect(classifyCommand('cat > /file.txt')).toBe('write');
    expect(classifyCommand('cat >/file.txt')).toBe('write');
    expect(classifyCommand('cat file.txt > /out.txt')).toBe('write');
  });

  it('returns write for heredoc', () => {
    expect(classifyCommand('cat <<EOF')).toBe('write');
    expect(classifyCommand("tee /file.txt <<-'HEREDOC'")).toBe('write');
  });

  it('returns write for sed -i', () => {
    expect(classifyCommand('sed -i "s/old/new/g" file.txt')).toBe('write');
  });

  it('reads sed\'s in-place flag wherever it stands, as the shell does, and a print as no write', () => {
    expect(classifyCommand("sed -n -i 's/a/b/' /x.css")).toBe('write');
    expect(classifyCommand("sed -i.bak 's/a/b/' /x.css")).toBe('write');
    expect(classifyCommand("sed -n '1,5p' /x.css")).toBe('bash');
  });

  it('returns write for ss', () => {
    expect(classifyCommand("ss /file.txt << 'EOF'")).toBe('write');
  });

  it('returns write for file-mutating commands', () => {
    expect(classifyCommand('mkdir -p /src')).toBe('write');
    expect(classifyCommand('touch /file.txt')).toBe('write');
    expect(classifyCommand('rm /file.txt')).toBe('write');
    expect(classifyCommand('mv /a.txt /b.txt')).toBe('write');
    expect(classifyCommand('cp /a.txt /b.txt')).toBe('write');
  });

  it('returns write for echo with redirect', () => {
    expect(classifyCommand('echo "hello" >> /file.txt')).toBe('write');
    expect(classifyCommand('echo "hello" > /file.txt')).toBe('write');
  });

  it('returns bash for read-only commands', () => {
    expect(classifyCommand('ls -la')).toBe('bash');
    expect(classifyCommand('cat /file.txt')).toBe('bash');
    expect(classifyCommand('grep -r "pattern" /src')).toBe('bash');
  });

  it('returns bash for cat with stderr redirect (not a write)', () => {
    expect(classifyCommand('cat /file.txt 2>/dev/null')).toBe('bash');
    expect(classifyCommand('cat /index.html && echo "---" && cat /src/App.tsx 2>/dev/null')).toBe('bash');
  });

  it('returns bash for echo without file redirect', () => {
    expect(classifyCommand('echo "---"')).toBe('bash');
    expect(classifyCommand('echo "hello"')).toBe('bash');
  });

  it('handles array input', () => {
    expect(classifyCommand(['agent', 'task', '"prompt"'])).toBe('agent');
    expect(classifyCommand(['delegate', 'task', '"prompt"'])).toBe('agent');
    expect(classifyCommand(['ls', '-la'])).toBe('bash');
  });
});

describe('classifyCommand, on the shapes the agent actually writes', () => {
  it('looks past a leading cd, as parseCommand does', () => {
    // New with the derivation, and the reason for it: the old regexes anchored on the start of the
    // string, so the `cd /` the agent prefixes most commands with hid the command behind it.
    expect(classifyCommand('cd / && status --task "x" --complete')).toBe('status');
    expect(classifyCommand('cd / && agent explore "where is the nav"')).toBe('agent');
  });

  it('groups a runtime restart with the other build commands', () => {
    // `build` was matched by name before, so `runtime restart` read as a plain command.
    expect(classifyCommand('runtime restart')).toBe('status');
  });

  it('keeps an echo that writes nothing out of the write bucket', () => {
    // parseCommand calls this an edit, because `echo` is how a file gets appended to. Folding its
    // kinds into these four buckets would move this row, which is why they are not folded.
    expect(classifyCommand('echo "---"')).toBe('bash');
    expect(classifyCommand('echo "hello"')).toBe('bash');
  });

  it('treats a sed on a relative target as a write', () => {
    // A read names its file as surely as a write does, so "has a path" cannot stand in for "wrote
    // something"; what parseCommand says the sed did is what covers it.
    expect(classifyCommand('sed -i "s/old/new/g" file.txt')).toBe('write');
  });

  it('treats a heredoc as a write whatever opens it', () => {
    // `tee` is not a verb parseCommand knows; the heredoc body is content either way.
    expect(classifyCommand("tee /file.txt <<-'HEREDOC'")).toBe('write');
  });
});
