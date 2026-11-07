import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';

const { VirtualFileSystem } = await import('@/lib/vfs');
const { runWithVFS } = await import('@/lib/server-generate/vfs-context');
const { buildSystemPrompt } = await import('../system-prompt');

/**
 * A server run works on the VFS it was started with, not the browser's, which a server never
 * initialises: the project's `.PROMPT.md` has to come from the files that run works on.
 */
describe('the system prompt of a server run', () => {
  it('carries the project\'s .PROMPT.md, in Code mode and in Chat mode', async () => {
    const runVfs = new VirtualFileSystem({ init: async () => {} } as never);
    Object.assign(runVfs, {
      initialized: true,
      readFile: async (_projectId: string, path: string) => {
        if (path === '/.PROMPT.md') return { path, content: 'Write every page in Finnish.' };
        throw new Error(`not found: ${path}`);
      },
    });

    for (const chatMode of [false, true]) {
      const prompt = await runWithVFS(runVfs, () => buildSystemPrompt(chatMode, null, 'p1', 'orchestrator'));
      expect(prompt, `chatMode ${chatMode}`).toContain('Write every page in Finnish.');
    }
  });
});
