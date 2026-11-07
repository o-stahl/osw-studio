import { describe, it, expect } from 'vitest';
import { describeCommand, describeForming } from '@/lib/quick-edit/forming';

/** A tool call while the model is still writing it: what it does, and how much of a file is in. */
describe('describeForming', () => {
  const args = (command: string) => JSON.stringify({ command });

  it('reads a write from its first line, with the heredoc lines written so far', () => {
    const partial = args("cat > /a.html << 'EOF'\n<!DOCTYPE html>\n<html>\n<body>").slice(0, -2);
    expect(describeForming(partial)).toEqual({ kind: 'write', path: '/a.html', lines: 3 });
  });

  it('counts no lines for a command that carries no file', () => {
    expect(describeCommand('rg -n "save" /scripts')).toMatchObject({ kind: 'search', lines: 0 });
  });

  it('has nothing to say while the arguments name no command yet', () => {
    expect(describeForming('{"comm')).toBeNull();
    expect(describeForming('')).toBeNull();
  });
});
