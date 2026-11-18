// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { OVERRIDES_PATH } from '@/lib/direct-edit/apply-style';
import { toolRegistry } from '../tool-registry';
import type { ToolCall } from '../types';

/**
 * Which bash calls the write guard runs around: every one the shell runs as a write, decided from
 * the tokens the shell runs rather than from the words between spaces.
 */

globalThis.indexedDB = new IDBFactory();
let seq = 0;

const PAGE = '<body>\n  <h1 data-osw-id="h7x2m4qp" class="title">Welcome</h1>\n</body>';
const CSS = '[data-osw-id="h7x2m4qp"][data-osw-id] {\n  color: red;\n}\n';

async function seed(): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Guard', 'fixture', `p-registry-guard-${++seq}`);
  await vfs.createFile(project.id, '/index.html', PAGE, { silent: true });
  await vfs.createFile(project.id, OVERRIDES_PATH, CSS, { silent: true });
  return project.id;
}

const bash = (command: string): ToolCall => ({ id: 't', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });
const context = { agentType: 'orchestrator' as const, isReadOnly: false, permissionMode: 'auto' as const };
const rewrite = PAGE.replace(' data-osw-id="h7x2m4qp"', '');

describe('the write guard around a bash call', () => {
  it.each([
    ['a redirect written against its path', `cat >/index.html << 'EOF'\n${rewrite}\nEOF`],
    ['a redirect after the heredoc', `cat << 'EOF' >/index.html\n${rewrite}\nEOF`],
  ])('runs for a page rewrite with %s', async (_label, command) => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash(command), projectId, context);

    expect(reply).toContain('It was put back');
    expect(String((await vfs.readFile(projectId, '/index.html')).content)).toContain('<h1 data-osw-id="h7x2m4qp" class="title">');
  });
});
