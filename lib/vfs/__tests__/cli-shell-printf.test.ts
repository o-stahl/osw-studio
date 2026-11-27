// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { vfs } from '@/lib/vfs';
import { vfsShell } from '../cli-shell';

globalThis.indexedDB = new IDBFactory();

let seq = 0;
async function project(): Promise<string> {
  await vfs.init();
  return (await vfs.createProject('printf', 'fixture', `p-printf-${++seq}`)).id;
}

describe('printf', () => {
  it('formats %s, %d and %%, and reads escapes in the format', async () => {
    const id = await project();
    const r = await vfsShell.execute(id, ['printf', '%s is %d%%\\n', 'load', '42']);
    expect(r.success, r.stderr).toBe(true);
    expect(r.stdout).toBe('load is 42%\n');
  });

  it('reuses the format for arguments left over, as bash does', async () => {
    const id = await project();
    const r = await vfsShell.execute(id, ['printf', '%s=%s\\n', 'a', '1', 'b', '2']);
    expect(r.stdout).toBe('a=1\nb=2\n');
  });

  it('pads and rounds: %-5s|, %5s|, %.2f, %03d', async () => {
    const id = await project();
    const r = await vfsShell.execute(id, ['printf', '%-5s|%5s|%.2f|%03d', 'ab', 'cd', '3.14159', '7']);
    expect(r.stdout).toBe('ab   |   cd|3.14|007');
  });

  it('writes a file through a redirect, with no trailing newline added', async () => {
    const id = await project();
    const r = await vfsShell.execute(id, ['printf', '{"n": %d}\\n', '3', '>', '/data.json']);
    expect(r.success, r.stderr).toBe(true);
    expect((await vfs.readFile(id, '/data.json')).content).toBe('{"n": 3}\n');
  });

  it('fails with usage and no format', async () => {
    const id = await project();
    const r = await vfsShell.execute(id, ['printf']);
    expect(r.success).toBe(false);
    expect(r.stderr).toContain('usage');
  });
});

describe('printf through the bash tool', () => {
  it('runs as the model writes it, and is refused as a write in read-only mode when redirected', async () => {
    const { toolRegistry } = await import('@/lib/llm/tool-registry');
    const id = await project();
    const bash = (command: string) => ({ id: 't', type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command }) } });
    const out = await toolRegistry.execute(bash("printf '%s: %d\\n' files 3 | cat"), id, { agentType: 'orchestrator' } as never);
    expect(String(out)).toContain('files: 3');
    await toolRegistry.execute(bash("printf 'x' > /x.txt"), id, { agentType: 'orchestrator', isReadOnly: true } as never);
    expect(await vfs.fileExists(id, '/x.txt')).toBe(false);
  });
});

describe('printf limits', () => {
  it('caps a huge width, pads right for a negative * width, and takes a long precision', async () => {
    const id = await project();
    const huge = await vfsShell.execute(id, ['printf', '%999999999s|', 'x']);
    expect(huge.success, huge.stderr).toBe(true);
    const neg = await vfsShell.execute(id, ['printf', '%*s|', '-4', 'ab']);
    expect(neg.stdout).toBe('ab  |');
    const long = await vfsShell.execute(id, ['printf', '%.200f', '1']);
    expect(long.success, long.stderr).toBe(true);
    expect(long.stdout).toMatch(/^1\.000/);
  });
});
