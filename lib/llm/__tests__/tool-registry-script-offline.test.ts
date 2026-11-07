// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockScriptExecute = vi.fn();

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
  vfsShell: { execute: vi.fn().mockResolvedValue({ success: true, stdout: '' }) },
}));

const outputListeners: Array<(msg: { type: string; exitCode?: number }) => void> = [];

vi.mock('@/lib/scripting/script-runner', () => ({
  scriptRunner: {
    execute: (...args: unknown[]) => mockScriptExecute(...args),
    onOutput: (listener: (msg: { type: string; exitCode?: number }) => void) => {
      outputListeners.push(listener);
      return () => outputListeners.splice(outputListeners.indexOf(listener), 1);
    },
  },
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function bashToolCall(command: string, id = 'tc-1') {
  return { id, type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command }) } };
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { value, configurable: true });
}

describe('python/lua fast-fail when offline', () => {
  let registry: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../tool-registry');
    registry = new mod.ToolRegistry();
  });

  afterEach(() => {
    setOnline(true);
  });

  it('python3: returns an actionable error and does not spin up the worker when offline', async () => {
    setOnline(false);

    const result = await registry.execute(bashToolCall('python3 /main.py'), 'test-project', {});

    expect(result).toContain('unavailable');
    expect(result.toLowerCase()).toContain('offline');
    expect(result.toLowerCase()).toContain('do not retry');
    expect(mockScriptExecute).not.toHaveBeenCalled();
  });

  it('lua: returns an actionable error when offline', async () => {
    setOnline(false);

    const result = await registry.execute(bashToolCall('lua /main.lua'), 'test-project', {});

    expect(result).toContain('Lua runtime');
    expect(result.toLowerCase()).toContain('offline');
    expect(mockScriptExecute).not.toHaveBeenCalled();
  });
});

describe('scripts in a read-only run', () => {
  let registry: { execute: (call: ReturnType<typeof bashToolCall>, projectId: string, context: object) => Promise<string> };

  beforeEach(async () => {
    vi.clearAllMocks();
    setOnline(true);
    // The run ends as soon as it starts, so the tool's own wait resolves.
    mockScriptExecute.mockImplementation(async () => { for (const listener of [...outputListeners]) listener({ type: 'complete', exitCode: 0 }); });
    const mod = await import('../tool-registry');
    registry = new mod.ToolRegistry();
  });

  it('run, keeping none of the files they write, while any other run keeps them', async () => {
    await registry.execute(bashToolCall('python3 /main.py'), 'test-project', { isReadOnly: true });
    expect(mockScriptExecute).toHaveBeenLastCalledWith('test-project', 'python', '/main.py', undefined, { keepOutputFiles: false });

    await registry.execute(bashToolCall('python3 /main.py'), 'test-project', {});
    expect(mockScriptExecute).toHaveBeenLastCalledWith('test-project', 'python', '/main.py', undefined, { keepOutputFiles: true });
  });
});
