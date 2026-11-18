// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '@/lib/utils';

/**
 * A render job's frame, standing in for a page: jsdom never loads the frame's srcdoc, so what the
 * shell would post comes from the frame's window here. The project, its compile and the shell's
 * page delivery are stubbed.
 */

const stubs = vi.hoisted(() => ({
  send: vi.fn<() => Promise<void>>(),
  answer: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/lib/vfs', () => ({
  vfs: { init: async () => {}, getProject: async () => ({ settings: {} }), getRuntimeDeploymentId: () => 'dep-1' },
}));
vi.mock('@/lib/vfs/project-settings', () => ({ resolveRuntime: () => 'static' }));
vi.mock('@/lib/runtimes/registry', () => ({ canvasSupport: () => 'edit' }));
vi.mock('@/lib/preview/preview-shell', () => ({
  previewShellHtml: (loadId: number) => `<!doctype html><title>shell ${loadId}</title>`,
  sendShellContent: () => stubs.send(),
}));
vi.mock('@/lib/preview/function-proxy', () => ({ answerFunctionCall: () => stubs.answer() }));
vi.mock('@/lib/preview/frame-capture', () => ({ requestFrameCapture: () => Promise.reject(new Error('nothing paints in jsdom')) }));
vi.mock('../project-compile', () => ({
  compileForCanvas: async () => ({
    project: {
      routes: [],
      pages: [{ file: '/index.html', title: 'Home' }],
      compile: { blobUrls: new Map(), pages: new Map([['/index.html', { html: '<html><body><h1>Hi</h1></body></html>', signature: 's' }]]) },
    },
    dispose: () => {},
  }),
  pageForPath: (_routes: unknown, _pages: unknown, path: string) => path,
}));

import { renderPage } from '../render-job';
import { inspectCommand } from '@/lib/vfs/shell/commands/inspect';
import type { ShellEnv } from '@/lib/vfs/shell/types';

beforeEach(() => {
  vi.useFakeTimers();
  stubs.send.mockReset().mockResolvedValue(undefined);
  stubs.answer.mockReset().mockResolvedValue(undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // A job left waiting keeps its frame in the document.
  for (const frame of document.body.querySelectorAll('iframe')) frame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function post(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
}

describe('a render job whose page fails to load', () => {
  it('logs a page it could not send to its frame, and a function call it could not answer', async () => {
    const sendFailure = new Error('the page could not be read');
    const callFailure = new Error('the function route is down');
    stubs.send.mockRejectedValueOnce(sendFailure);
    stubs.answer.mockRejectedValueOnce(callFailure);
    const result = renderPage({ kind: 'inspect', projectId: 'p1', page: '/index.html', width: 1440 });
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe');
    expect(frame, 'no render frame').not.toBeNull();
    const loadId = Number(/shell (\d+)/.exec(frame!.srcdoc)?.[1]);
    post(frame!, { type: 'preview:shell-ready', loadId });
    post(frame!, { type: 'preview:function-call', id: 1, path: '/api/x', method: 'GET', headers: [], body: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), sendFailure);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), callFailure);
    // Nothing settles: the job ends when its wait does.
    await vi.advanceTimersByTimeAsync(16000);
    expect(await result).toEqual({ ok: false, error: expect.stringContaining('did not finish loading') });
    expect(document.body.querySelector('iframe')).toBeNull();
  });

  it('ends at once when its frame cannot build the page, with the frame\'s reason as one short line', async () => {
    const reason = `Failed to read ${'a'.repeat(400)}\n    at swap (about:srcdoc:1:200)`;
    let ended = false;
    const result = renderPage({ kind: 'inspect', projectId: 'p1', page: '/index.html', width: 1440 }).finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe')!;
    const loadId = Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]);
    post(frame, { type: 'preview:shell-error', loadId, error: reason });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    const outcome = await result;
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? '' : outcome.error;
    expect(error.startsWith('/index.html could not be loaded: Failed to read aaa')).toBe(true);
    expect(error).not.toContain('\n');
    expect(error.length).toBeLessThan(300);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), reason);
    expect(document.body.querySelector('iframe')).toBeNull();
  });

  it('gives only the first line of the frame\'s reason, without the stack under it', async () => {
    const result = renderPage({ kind: 'inspect', projectId: 'p1', page: '/index.html', width: 1440 });
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe')!;
    const loadId = Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]);
    post(frame, { type: 'preview:shell-error', loadId, error: 'TypeError: x is not a function\n    at swap (about:srcdoc:1:200)' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ ok: false, error: '/index.html could not be loaded: TypeError: x is not a function' });
  });

  it('takes no failure reported for another load than its own', async () => {
    let ended = false;
    const result = renderPage({ kind: 'inspect', projectId: 'p1', page: '/index.html', width: 1440 }).finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe')!;
    const loadId = Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]);
    expect(loadId, 'no render frame').toBeGreaterThan(0);
    // The frame runs the page's scripts, which can post the shell's messages too.
    post(frame, { type: 'preview:shell-error', loadId: loadId + 1, error: 'posted by a page script' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    post(frame, { type: 'preview:shell-error', loadId, error: 'the real reason' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual({ ok: false, error: '/index.html could not be loaded: the real reason' });
  });

  it('shows the agent that reason on one line of inspect\'s output', async () => {
    const env = { args: ['/index.html'], projectId: 'p1', vfs: {}, ctx: {} } as unknown as ShellEnv;
    let ended = false;
    const output = inspectCommand(env).finally(() => { ended = true; });
    for (let i = 0; i < 10 && !document.body.querySelector('iframe'); i++) await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe')!;
    post(frame, { type: 'preview:shell-error', loadId: Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]), error: 'NotReadableError: the file could not be read' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
    expect(await output).toEqual({ stdout: '', stderr: 'inspect: /index.html could not be loaded: NotReadableError: the file could not be read', exitCode: 1 });
  });
});
