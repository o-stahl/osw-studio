import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScriptWorkerResponse } from '../types';

/**
 * The script runner hands a project's files to a sandboxed worker (lib/sandbox/script-sandbox.ts) and
 * reports the end of the run exactly once, including when the sandbox fails to start. A sandbox that
 * fails is dropped, so the next run starts in a new one.
 */
type Handlers = { onMessage: (msg: ScriptWorkerResponse) => void; onError: (message: string) => void };

const h = vi.hoisted(() => ({
  sandboxes: [] as Array<{ handlers: Handlers; posted: unknown[]; terminated: boolean }>,
  releaseFiles: null as null | (() => void),
}));

vi.mock('@/lib/vfs', () => ({
  vfs: {
    init: async () => {},
    listFiles: () => new Promise((resolve) => {
      h.releaseFiles = () => resolve([{ path: '/main.py', content: 'print(1)' }]);
    }),
  },
}));
vi.mock('@/lib/preview/compile-errors', () => ({ beginCompilation: vi.fn(), pushCompileError: vi.fn(), commitCompilation: vi.fn() }));
vi.mock('@/lib/sandbox/script-sandbox', () => ({
  ScriptSandbox: class {
    posted: unknown[] = [];
    terminated = false;
    constructor(public handlers: Handlers) { h.sandboxes.push(this); }
    postMessage(data: unknown) { this.posted.push(data); }
    terminate() { this.terminated = true; }
  },
}));

import { scriptRunner } from '../script-runner';

const EXECUTE = { type: 'execute', payload: { runtime: 'python', entryPoint: '/main.py', files: { '/main.py': 'print(1)' } } };

let seen: ScriptWorkerResponse[];
let unsubscribe: () => void;

/** One run of /main.py, up to its files reaching a sandbox; `meanwhile` happens while they are gathered. */
async function runMain(meanwhile?: () => void) {
  h.releaseFiles = null;
  const run = scriptRunner.execute('p1', 'python', '/main.py');
  await vi.waitFor(() => expect(h.releaseFiles).not.toBeNull());
  meanwhile?.();
  h.releaseFiles!();
  await run;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sandboxes.length = 0;
  seen = [];
  unsubscribe = scriptRunner.onOutput((msg) => seen.push(msg));
});
afterEach(() => {
  unsubscribe();
  scriptRunner.abort();
  vi.useRealTimers();
});

describe('scriptRunner', () => {
  it('sends the project\'s files to the sandbox and ends when the worker says so', async () => {
    await runMain();
    expect(h.sandboxes[0].posted).toEqual([EXECUTE]);
    h.sandboxes[0].handlers.onMessage({ type: 'complete', exitCode: 0 });
    expect(scriptRunner.isRunning()).toBe(false);
    expect(seen.filter((m) => m.type === 'complete')).toEqual([{ type: 'complete', exitCode: 0 }]);
  });

  it('drops what a run that keeps no output files writes to /output/, and passes it on otherwise', async () => {
    const file = { type: 'output-file', path: '/output/chart.html', content: '<svg/>' } as const;
    await runMain();
    h.sandboxes.at(-1)!.handlers.onMessage(file);
    expect(seen).toContainEqual(file);

    seen.length = 0;
    h.releaseFiles = null;
    const run = scriptRunner.execute('p1', 'python', '/main.py', undefined, { keepOutputFiles: false });
    await vi.waitFor(() => expect(h.releaseFiles).not.toBeNull());
    h.releaseFiles!();
    await run;
    h.sandboxes.at(-1)!.handlers.onMessage(file);
    h.sandboxes.at(-1)!.handlers.onMessage({ type: 'complete', exitCode: 0 });
    expect(seen).not.toContainEqual(file);
    expect(seen).toContainEqual({ type: 'complete', exitCode: 0 });
  });

  it('ends the run once when the sandbox fails to start', async () => {
    await runMain();
    h.sandboxes[0].handlers.onError('Failed to load the script runner: offline');

    expect(seen.filter((m) => m.type === 'error').map((m) => (m as { data: string }).data))
      .toEqual([expect.stringContaining('offline')]);
    expect(seen.filter((m) => m.type === 'complete')).toEqual([{ type: 'complete', exitCode: 1 }]);
    expect(scriptRunner.isRunning()).toBe(false);

    // Nothing left to time out.
    const before = seen.length;
    vi.advanceTimersByTime(60_000);
    expect(seen).toHaveLength(before);
  });

  it('starts the next run in a new sandbox after one fails to start', async () => {
    await runMain();
    h.sandboxes[0].handlers.onError('Failed to load the script runner: offline');

    await runMain();
    expect(h.sandboxes.map((s) => s.posted)).toEqual([[EXECUTE], [EXECUTE]]);
    expect(h.sandboxes.map((s) => s.terminated)).toEqual([true, false]);
    expect(scriptRunner.isRunning()).toBe(true);
  });

  it('drops a sandbox that fails between runs, and the next run carries on in a new one without its error', async () => {
    await runMain();
    h.sandboxes[0].handlers.onMessage({ type: 'complete', exitCode: 0 });
    seen.length = 0;

    // The sandbox kept from the finished run fails while the next run's files are gathered. The
    // next run's listener is already subscribed (lib/llm/tool-registry.ts), and the failure is not its.
    await runMain(() => h.sandboxes[0].handlers.onError('crashed'));
    expect(h.sandboxes.map((s) => s.posted)).toEqual([[EXECUTE], [EXECUTE]]);
    expect(h.sandboxes.map((s) => s.terminated)).toEqual([true, false]);
    expect(scriptRunner.isRunning()).toBe(true);
    expect(seen.filter((m) => m.type === 'complete' || m.type === 'error')).toEqual([]);

    h.sandboxes[1].handlers.onMessage({ type: 'complete', exitCode: 0 });
    expect(seen.filter((m) => m.type === 'complete')).toEqual([{ type: 'complete', exitCode: 0 }]);
  });
});
