// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { toolRegistry } from '../tool-registry';
import type { ToolCall } from '../types';

/**
 * A command can print results and still fail: `grep` over a found file and a missing one prints the
 * found file's matches and exits 2. The answer keeps both, the error first, so it still reads as a
 * failure to everything that checks for the `Error` prefix, and the output follows under a label.
 */

globalThis.indexedDB = new IDBFactory();
let seq = 0;

const OUTPUT_LABEL = 'Output before the failure:';

async function seed(): Promise<string> {
  await vfs.init();
  const project = await vfs.createProject('Failed output', 'fixture', `p-registry-failed-${++seq}`);
  await vfs.createFile(project.id, '/a.txt', 'first line\nMATCH here\nlast line\n', { silent: true });
  return project.id;
}

const bash = (command: string): ToolCall => ({ id: 't', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } });
const context = { agentType: 'orchestrator' as const, isReadOnly: false, permissionMode: 'auto' as const };

describe('the answer to a command that fails after printing output', () => {
  it('keeps the matches of grep -s over a found and a missing path, under the exit status', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep -s -rn MATCH /a.txt /nope'), projectId, context);

    expect(reply.startsWith('Error: ')).toBe(true);
    expect(reply).toContain('/a.txt:2:MATCH here');
    expect(reply).toContain('exit status 2');
    expect(reply.indexOf('exit status 2')).toBeLessThan(reply.indexOf(OUTPUT_LABEL));
    expect(reply.indexOf(OUTPUT_LABEL)).toBeLessThan(reply.indexOf('/a.txt:2:MATCH here'));
  });

  it('keeps the matches of grep over a found and a missing path, after the missing-path message', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep -rn MATCH /a.txt /nope'), projectId, context);

    expect(reply.startsWith('Error: grep: /nope: No such file or directory')).toBe(true);
    expect(reply).toContain('/a.txt:2:MATCH here');
    expect(reply).toBe(`Error: grep: /nope: No such file or directory\n\n${OUTPUT_LABEL}\n/a.txt:2:MATCH here`);
  });

  it('stops an && chain at a failure that printed output, and keeps that output', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep -rn MATCH /a.txt /nope && echo next'), projectId, context);

    expect(reply.startsWith('Error')).toBe(true);
    expect(reply).toContain('/a.txt:2:MATCH here');
    expect(reply).not.toContain('next');
  });

  it('runs the fallback of an || chain after a failure that printed output', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep -rn MATCH /a.txt /nope || echo fallback'), projectId, context);

    expect(reply).toContain('/a.txt:2:MATCH here');
    expect(reply).toContain('fallback');
  });
});

describe('the answer to a command that fails without output', () => {
  it('stops an && chain at the failure', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep MATCH /nope && echo next'), projectId, context);

    expect(reply.startsWith('Error')).toBe(true);
    expect(reply).not.toContain('next');
  });

  it('runs the fallback of an || chain', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep MATCH /nope || echo fallback'), projectId, context);

    expect(reply).toContain('fallback');
  });

  it('is the error message alone', async () => {
    const projectId = await seed();
    const reply = await toolRegistry.execute(bash('grep MATCH /nope'), projectId, context);

    expect(reply).toBe('Error: grep: /nope: No such file or directory');
  });
});
