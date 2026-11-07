import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVfsShellExecute = vi.fn();

vi.mock('@/lib/vfs', () => ({
  getActiveVFS: () => ({
    init: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn().mockResolvedValue([]),
    listDirectories: vi.fn().mockResolvedValue([]),
    hasServerContext: () => false,
    getRuntimeDeploymentId: () => null,
    refreshServerContext: vi.fn(),
  }),
}));

vi.mock('@/lib/vfs/cli-shell', () => ({
  vfsShell: { execute: (...args: any[]) => mockVfsShellExecute(...args) },
}));

vi.mock('@/lib/scripting/script-runner', () => ({
  scriptRunner: { execute: vi.fn() },
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function bashToolCall(command: string, id = 'tc-1') {
  return {
    id,
    type: 'function' as const,
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

describe('ToolRegistry chained command execution', () => {
  let registry: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../tool-registry');
    registry = new mod.ToolRegistry();
  });

  it('reports completed count when a chained command fails mid-sequence', async () => {
    mockVfsShellExecute
      .mockResolvedValueOnce({ success: true, stdout: '' })
      .mockResolvedValueOnce({ success: true, stdout: '' })
      .mockResolvedValueOnce({ success: false, stderr: 'cat: /bad.txt: File not found' });

    const result = await registry.execute(
      bashToolCall("echo hello\necho world\ncat /bad.txt"),
      'test-project',
      {},
    );

    expect(result).toContain('(2/3 commands succeeded before this error)');
    expect(result).toContain('File not found');
  });

  it('does not report completed count when first command fails', async () => {
    mockVfsShellExecute
      .mockResolvedValueOnce({ success: false, stderr: 'command not found' });

    const result = await registry.execute(
      bashToolCall("bad-cmd\necho ok"),
      'test-project',
      {},
    );

    expect(result).toContain('Error');
    expect(result).not.toContain('commands succeeded');
  });

  it('returns combined output when all chained commands succeed', async () => {
    mockVfsShellExecute
      .mockResolvedValueOnce({ success: true, stdout: 'file1 created' })
      .mockResolvedValueOnce({ success: true, stdout: 'file2 created' });

    const result = await registry.execute(
      bashToolCall("echo file1\necho file2"),
      'test-project',
      {},
    );

    expect(result).toBe('file1 created\nfile2 created');
  });
});
