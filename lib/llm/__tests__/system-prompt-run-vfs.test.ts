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

/** A run's VFS holding one project of `runtime`. */
function projectVfs(runtime: string) {
  const runVfs = new VirtualFileSystem({ init: async () => {} } as never);
  Object.assign(runVfs, {
    initialized: true,
    getProject: async () => ({ id: 'p1', settings: { runtime } }),
    readFile: async (_projectId: string, path: string) => { throw new Error(`not found: ${path}`); },
  });
  return runVfs;
}

describe('the page tools a prompt teaches', () => {
  // What a user's hand edits leave in a project is not prompt text: the overrides file's header, the
  // selected-element message and the write guard each say it where it applies. A project nobody
  // edits by hand must read to the agent as plain HTML and CSS.
  it('teaches the reading commands and nothing about hand edits for a static or Handlebars project', async () => {
    for (const runtime of ['static', 'handlebars']) {
      const prompt = await runWithVFS(projectVfs(runtime), () => buildSystemPrompt(false, null, 'p1', 'orchestrator', true, false, false, false, true));
      expect(prompt, runtime).toContain('inspect /index.html [element] [--width N]');
      expect(prompt, runtime).toContain('screenshot /index.html [element] [--width N] [--full]');
      expect(prompt, runtime).toContain('screenshot shows it to you as an image');
      for (const word of ['data-osw-', 'overrides.css', 'Inspector', 'Canvas', 'style <element>', 'style /index.html', 'style @']) {
        expect(prompt, `${runtime}: ${word}`).not.toContain(word);
      }
    }
  });

  it('teaches inspect for a bundled runtime, and no screenshot to a model that reads no images', async () => {
    const prompt = await runWithVFS(projectVfs('react'), () => buildSystemPrompt(false, null, 'p1', 'orchestrator', true, false, false, false, false));
    expect(prompt).toContain('inspect /index.html [element] [--width N]');
    expect(prompt).not.toContain('screenshot /index.html');
    expect(prompt).toContain('You cannot see it, but inspect reads a rendered page as text');
  });

  it('teaches none of them where nothing renders pages', async () => {
    const prompt = await runWithVFS(projectVfs('python'), () => buildSystemPrompt(false, null, 'p1', 'orchestrator', true, false, false, false, true));
    expect(prompt).not.toContain('inspect /index.html');
  });

  it('gives Chat mode the reading tools', async () => {
    const prompt = await runWithVFS(projectVfs('static'), () => buildSystemPrompt(true, null, 'p1', 'orchestrator', true, false, false, false, true));
    expect(prompt).toContain('inspect /index.html [element] [--width N]');
  });
});
