import { describe, it, expect } from 'vitest';
import { commandLineWrites } from '@/lib/llm/write-scope';

/**
 * Which scope the MCP `bash` tool demands, and whether it announces a change afterwards, both
 * hang on this answer. It previously came from `classifyCommand`, a display grouping, so a write
 * reached through a pipe asked only for `projects:read` and fired no notification.
 */
describe('does an MCP bash command line write', () => {
  it.each([
    'rm /index.html',
    'ls / | rm /index.html',
    'ls / | mv /a /b',
    "cat /a | sed -i 's/x/y/' /a",
    'ls / | touch /new',
    'ls / ; rm /index.html',
    'ls / && rm /index.html',
    'cat /a > /b',
    'ls / | grep x > /out',
    'curl -o /logo.png https://example.com/x.png',
    'ls /\nrm /index.html',
    // The shell splits a redirect written against its path, so these write.
    "cat >/index.html << 'EOF'\n<h1>Hi</h1>\nEOF",
    'echo hi>/index.html',
    'echo hi >>/index.html',
    "cat << 'EOF' >/index.html\n<h1>Hi</h1>\nEOF",
    "ls /\ncat >/index.html << 'EOF'\n<h1>Hi</h1>\nEOF",
    // The command portion is unescaped before it runs, as models sometimes send entities.
    'echo hi &gt; /index.html',
    // The lines after a heredoc's delimiter run one by one, whatever quote one leaves open.
    "echo 'x\ncat > /a << EOF\nbody\nEOF\necho \"q\nrm /b.txt",
  ])('yes: %s', (command) => expect(commandLineWrites(command)).toBe(true));

  it.each([
    'ls /',
    'cat /index.html',
    'ls / | grep html | wc -l',
    'rg -n pattern /',
    'curl localhost/',
    "sed 's/a/b/' /index.html",
    // A heredoc body is the command's input, not more command line.
    "cat << 'EOF'\nnav > a { color: red; }\nEOF",
    'rg "ul > li" /styles.css',
    'ls / 2>/dev/null',
    // A comment line after a heredoc's delimiter runs nothing.
    "echo 'x\ncat << EOF\nbody\nEOF\n# ; rm /b.txt",
  ])('no: %s', (command) => expect(commandLineWrites(command)).toBe(false));
});
