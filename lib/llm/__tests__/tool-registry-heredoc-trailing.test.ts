import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import type { ToolCall } from '../types';

const { vfs } = await import('@/lib/vfs');
const { toolRegistry } = await import('../tool-registry');

/**
 * The lines after a heredoc's closing delimiter run as commands of their own. They reached the
 * shell unsplit, so a comment line carrying `; rm …` was gated as a `#` command and the shell then
 * ran the rest, past read-only mode, an Ask-mode approval and an agent's write scope.
 */

const bash = (command: string): ToolCall => ({ id: 't', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });

let projectId: string;
beforeAll(async () => {
  await vfs.init();
  projectId = (await vfs.createProject('trailing')).id;
});
beforeEach(async () => {
  for (const path of ['/index.html', '/trail.txt', '/.interviews/x.md']) {
    if (await vfs.fileExists(projectId, path)) await vfs.deleteFile(projectId, path);
  }
  await vfs.createFile(projectId, '/index.html', '<h1>Hi</h1>');
});
const exists = (path: string) => vfs.fileExists(projectId, path);

describe('the lines after a heredoc', () => {
  it('are gated one command at a time in read-only mode, and a comment line runs nothing', async () => {
    for (const trailing of ['# ; rm /index.html', 'ls / ; rm /index.html']) {
      await toolRegistry.execute(bash(`cat /index.html << 'EOF'\nhi\nEOF\n${trailing}`), projectId, { agentType: 'orchestrator', isReadOnly: true } as never);
      expect(await exists('/index.html'), trailing).toBe(true);
    }
  });

  it('stay inside an agent\'s write scope', async () => {
    for (const trailing of ['# || touch /trail.txt', 'ls / && touch /trail.txt']) {
      await toolRegistry.execute(bash(`cat > /.interviews/x.md << 'EOF'\nhi\nEOF\n${trailing}`), projectId, { agentType: 'interview', writeScope: '/.interviews/' } as never);
      expect(await exists('/.interviews/x.md'), trailing).toBe(true);
      expect(await exists('/trail.txt'), trailing).toBe(false);
    }
  });

  it('ask for approval as any other command does', async () => {
    const asked: string[] = [];
    const ask = {
      agentType: 'orchestrator', permissionMode: 'ask', permissionOverrides: {},
      onApprovalNeeded: async (request: { gateKey: string }) => { asked.push(request.gateKey); return 'deny'; },
    } as never;

    await toolRegistry.execute(bash("cat /index.html << 'EOF'\nhi\nEOF\nls / ; rm /index.html"), projectId, ask);
    expect(asked).toEqual(['rm']);
    await toolRegistry.execute(bash("cat /index.html << 'EOF'\nhi\nEOF\n# ; rm /index.html"), projectId, ask);
    expect(asked).toEqual(['rm']);
    expect(await exists('/index.html')).toBe(true);
  });

  it('read a comment as a comment, and still run a command after the heredoc', async () => {
    const commented = await toolRegistry.execute(bash("cat > /trail.txt << 'EOF'\nhi\nEOF\n# wrote the file"), projectId, { agentType: 'orchestrator' } as never);
    expect(commented).not.toContain('Error');

    const listed = await toolRegistry.execute(bash("cat > /trail.txt << 'EOF'\nhi\nEOF\nls /"), projectId, { agentType: 'orchestrator' } as never);
    expect(listed).toContain('index.html');
  });
});
