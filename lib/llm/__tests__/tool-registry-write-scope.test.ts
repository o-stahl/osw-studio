import { describe, it, expect, vi } from 'vitest';
import type { ToolCall } from '../types';
import { SHELL_COMMANDS } from '@/lib/vfs/shell-commands';

const mockVfs = {
  init: vi.fn(),
  createFile: vi.fn().mockResolvedValue({}),
  updateFile: vi.fn().mockResolvedValue({}),
  readFile: vi.fn().mockResolvedValue({ content: '' }),
  listFiles: vi.fn().mockResolvedValue([]),
  getFile: vi.fn().mockResolvedValue(null),
  getAllFilesAndDirectories: vi.fn().mockResolvedValue([]),
  // Enough of the VFS for the shell to reach its unknown-command path: without this the
  // shell throws first, and a test asserting "did not fall through" would pass on the crash.
  getRuntimeDeploymentId: vi.fn().mockReturnValue(null),
};

vi.mock('@/lib/vfs', () => ({ getActiveVFS: () => mockVfs, vfs: mockVfs }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function bash(command: string): ToolCall {
  return { id: 't', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } };
}

const interviewCtx = { agentType: 'interview', isReadOnly: false, writeScope: '/.interviews/' };

describe('tool-registry write scope (interview agent end-to-end)', () => {
  it('denies a write outside the scope', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('echo "x" > /index.html'), 'p', interviewCtx);
    expect(result).toContain('/.interviews/');
    expect(result.toLowerCase()).toContain('write');
  });

  it('denies a traversal escape out of the scope', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('echo "x" > /.interviews/../index.html'), 'p', interviewCtx);
    expect(result).toContain('/.interviews/');
  });

  it('allows a write inside the scope', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('echo "notes" > /.interviews/findings.md'), 'p', interviewCtx);
    expect(result).not.toContain('may only write within');
  });

  it('allows reads anywhere under the scope', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('cat /index.html'), 'p', interviewCtx);
    expect(result).not.toContain('may only write within');
  });

  it('does not restrict an unscoped agent', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('echo "x" > /index.html'), 'p', { agentType: 'orchestrator', isReadOnly: false });
    expect(result).not.toContain('may only write within');
  });
});

const readOnlyCtx = { agentType: 'chat', isReadOnly: true, writeScope: undefined };

/** A realistic invocation per writing command. The gate fires before argv is interpreted. */
const WRITE_INVOCATIONS: Record<string, string> = {
  ss: '/f.txt',
  touch: '/f.txt',
  mkdir: '/d',
  rm: '-rf /d',
  rmdir: '/d',
  mv: '/a /b',
  cp: '/a /b',
  'generate-image': '"a cat"',
  runtime: 'react',
};

describe('read-only mode blocks every writing command', () => {
  // The read-only gate kept its own list of writing commands, which had fallen behind the shell:
  // generate-image and runtime both write, so Chat mode could modify the project. Listing the
  // cases here by hand would rebuild that drift in the test, so they come from the registry.
  const alwaysWrite = SHELL_COMMANDS.filter((c) => c.writes === 'always').map((c) => c.name);

  it('covers every writing command the registry declares', () => {
    // Without this the loop below would silently run `undefined` arguments for a new command.
    const missing = alwaysWrite.filter((name) => !(name in WRITE_INVOCATIONS));

    expect(missing).toEqual([]);
  });

  it.each(alwaysWrite)('refuses %s', async (name) => {
    const { toolRegistry } = await import('../tool-registry');

    const result = await toolRegistry.execute(bash(`${name} ${WRITE_INVOCATIONS[name]}`), 'p', readOnlyCtx);

    expect(result).toContain('read-only');
  });

  it('still allows reading', async () => {
    const { toolRegistry } = await import('../tool-registry');

    const result = await toolRegistry.execute(bash('ls /'), 'p', readOnlyCtx);

    expect(result).not.toContain('read-only');
  });
});

/**
 * Commands the registry marks `handledBy: 'tool'` never reach the shell — the tool layer picks
 * them off first. The registry test asserts they have no shell handler; this asserts the other
 * half, that something still handles them. Without both, removing an interception would leave a
 * command advertised to the agent that answers "command not found".
 */
describe('commands the tool layer intercepts', () => {
  it.each([
    ['cd /somewhere'],
    ['preview /index.html'],
    ['python script.py'],
    ['lua script.lua'],
    ['agent explore "look around"'],
  ])('does not fall through to the shell for %s', async (command) => {
    const { toolRegistry } = await import('../tool-registry');

    const result = await toolRegistry.execute(bash(command), 'p', {
      agentType: 'code',
      isReadOnly: false,
    });

    // It may fail for its own reasons in a test environment; what it must not do is reach the
    // shell's unknown-command path.
    expect(result).not.toContain('command not found');
  });
});

describe('the interview agent\'s shell', () => {
  it('is described with the commands an interview reads, asks and records with', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const [bashDef] = toolRegistry.getDefinitions(['bash'], 'interview');
    expect(bashDef.description).toContain('/.interviews/');
    expect(bashDef.description).toContain('ask [--prompt');
    // The general description offers sub-agents, builds and runtime changes, none of which apply.
    for (const offered of ['agent', 'build', 'runtime', 'sqlite3']) {
      expect(bashDef.description).not.toMatch(new RegExp(`\\b${offered}\\b`));
    }
  });

  it('is told it cannot start sub-agents, rather than shown a usage it already followed', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('agent task "build the site"'), 'p', interviewCtx);
    expect(result).toContain('only the main agent');
    expect(result).not.toContain('requires a type');
  });

  it('cannot keep what a script writes to /output/, which is outside its scope', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash('python /.interviews/count.py'), 'p', interviewCtx);
    expect(result).toContain('/.interviews/');
    expect(result).toContain('/output/');
  });
});

describe('read-only mode and sed', () => {
  it('refuses an in-place edit spelled with a backup suffix', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const result = await toolRegistry.execute(bash("sed -i.bak 's/a/b/' /index.html"), 'p', { agentType: 'orchestrator', isReadOnly: true });
    expect(result).toContain('read-only');
  });
});

describe('read-only mode and a deployment\'s data', () => {
  it('refuses a statement that changes data, and lets a query through', async () => {
    const { toolRegistry } = await import('../tool-registry');
    const readOnly = { agentType: 'orchestrator', isReadOnly: true };
    expect(await toolRegistry.execute(bash('sqlite3 "DELETE FROM signups"'), 'p', readOnly)).toContain('read-only');
    expect(await toolRegistry.execute(bash('sqlite3 "SELECT count(*) FROM signups"'), 'p', readOnly)).not.toContain('read-only');
    expect(await toolRegistry.execute(bash(`sqlite3 "SELECT replace(title, '-', ' ') FROM posts"`), 'p', readOnly)).not.toContain('read-only');
    expect(await toolRegistry.execute(bash(`sqlite3 "SELECT * FROM events WHERE action = 'delete'"`), 'p', readOnly)).not.toContain('read-only');
    expect(await toolRegistry.execute(bash(`sqlite3 "/* it's */ DELETE FROM signups WHERE name = 'bob'"`), 'p', readOnly)).toContain('read-only');
    expect(await toolRegistry.execute(bash('sqlite3 -- "DELETE FROM signups"'), 'p', readOnly)).toContain('read-only');
  });
});
