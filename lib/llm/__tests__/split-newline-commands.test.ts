import { describe, it, expect } from 'vitest';
import { splitNewlineCommands } from '../tool-registry';
import { splitHeredoc } from '../bash-command';

describe('splitNewlineCommands', () => {
  it('returns single command for simple input', () => {
    expect(splitNewlineCommands('ls -la')).toEqual(['ls -la']);
  });

  it('splits two simple commands on separate lines', () => {
    const result = splitNewlineCommands('echo hello\necho world');
    expect(result).toEqual(['echo hello', 'echo world']);
  });

  it('keeps heredoc body as part of its command', () => {
    const cmd = `cat > /file.html << 'EOF'
<h1>Hello</h1>
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('<h1>Hello</h1>');
    expect(result[0]).toContain('EOF');
  });

  it('splits two chained heredocs into separate commands', () => {
    const cmd = `cat > /a.html << 'EOF'
content-a
EOF
cat > /b.html << 'EOF'
content-b
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('content-a');
    expect(result[1]).toContain('content-b');
  });

  it('splits three chained heredocs', () => {
    const cmd = `cat > /index.html << 'EOF'
<html>index</html>
EOF
cat > /about.html << 'EOF'
<html>about</html>
EOF
cat > /contact.html << 'EOF'
<html>contact</html>
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain('index');
    expect(result[1]).toContain('about');
    expect(result[2]).toContain('contact');
  });

  it('splits chained heredocs even when a body has an odd number of quotes (regression)', () => {
    // A heredoc body with an odd number of quote chars used to make
    // hasUnbalancedQuotes(current) true AFTER the heredoc closed, swallowing the next
    // chained heredoc command (three blocks collapsing into two). The first body below
    // has a single lone apostrophe; all three must still split cleanly.
    const cmd = `cat > /a.js << 'EOF'
// Eileen's first file
EOF
cat > /b.js << 'EOF'
const t = 2;
EOF
cat > /c.js << 'EOF'
console.log('c');
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(3);
    expect(result[0]).toContain('/a.js');
    expect(result[1]).toContain('/b.js');
    expect(result[2]).toContain('/c.js');
  });

  it('splits chained heredocs when a body has a single lone apostrophe (regression)', () => {
    const cmd = `cat > /a.txt << 'EOF'
Eileen's note
EOF
cat > /b.txt << 'EOF'
second file
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("Eileen's note");
    expect(result[1]).toContain('second file');
  });

  it('handles heredoc followed by a trailing echo', () => {
    const cmd = `cat > /file.css << 'EOF'
body { color: red; }
EOF
echo "done"`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('body { color: red; }');
    expect(result[1]).toBe('echo "done"');
  });

  it('handles heredoc with different delimiters', () => {
    const cmd = `cat > /a.txt << 'HEREDOC'
alpha
HEREDOC
cat > /b.txt << 'MARKER'
beta
MARKER`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('alpha');
    expect(result[1]).toContain('beta');
  });

  it('handles unquoted heredoc delimiters', () => {
    const cmd = `cat > /file.txt << EOF
hello world
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('hello world');
  });

  it('preserves multi-line heredoc content with special characters', () => {
    const cmd = `cat > /style.css << 'EOF'
:root {
  --font: 'Inter', sans-serif;
  --bg: #FDF8F3;
}
body { font-family: var(--font); }
EOF`;
    const result = splitNewlineCommands(cmd);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("'Inter', sans-serif");
    expect(result[0]).toContain('var(--font)');
  });

  it('skips comment lines', () => {
    const cmd = `# this is a comment
echo hello`;
    const result = splitNewlineCommands(cmd);
    expect(result).toEqual(['echo hello']);
  });

  it('handles empty input', () => {
    expect(splitNewlineCommands('')).toEqual([]);
  });

  it('handles whitespace-only lines between commands', () => {
    const cmd = `echo hello

echo world`;
    const result = splitNewlineCommands(cmd);
    expect(result).toEqual(['echo hello', 'echo world']);
  });
});

describe('splitHeredoc', () => {
  it('takes a heredoc apart into the command around the << and the body', () => {
    expect(splitHeredoc("cat > /a.txt << 'EOF'\nl1\nl2\nEOF")).toEqual({ command: 'cat > /a.txt', stdin: 'l1\nl2' });
  });

  it('takes the body as everything after the first line when the closing delimiter never came', () => {
    expect(splitHeredoc("cat > /a.txt << 'EOF'\nl1\nl2")).toEqual({ command: 'cat > /a.txt', stdin: 'l1\nl2' });
    expect(splitHeredoc("cat << 'EOF' > /a.txt\nl1")).toEqual({ command: 'cat > /a.txt', stdin: 'l1' });
  });
});
