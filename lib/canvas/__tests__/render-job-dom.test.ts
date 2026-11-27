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
  capture: vi.fn<(frame: unknown, opts: { captureWidth: number; captureHeight: number }) => Promise<unknown>>(),
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
vi.mock('@/lib/preview/frame-capture', () => ({
  requestFrameCapture: (frame: unknown, opts: { captureWidth: number; captureHeight: number }) => stubs.capture(frame, opts),
}));
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
  stubs.capture.mockReset().mockRejectedValue(new Error('nothing paints in jsdom'));
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

  it('says how far a page got when it does not finish, and when the tab is in the background', async () => {
    const attempt = async (messages: string[]) => {
      const result = renderPage({ kind: 'inspect', projectId: 'p1', page: '/index.html', width: 1440 });
      await vi.advanceTimersByTimeAsync(0);
      const frame = document.body.querySelector('iframe')!;
      const loadId = Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]);
      for (const type of messages) post(frame, { type, loadId });
      await vi.advanceTimersByTimeAsync(16000);
      const outcome = await result;
      return outcome.ok ? '' : outcome.error;
    };
    const prefix = '/index.html did not finish loading within 15 s: ';
    expect(await attempt([])).toBe(`${prefix}the preview frame did not start`);
    expect(await attempt(['preview:shell-ready'])).toBe(`${prefix}the page did not load`);
    expect(await attempt(['preview:shell-ready', 'preview:ready'])).toBe(`${prefix}the page loaded but did not settle`);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    expect(await attempt([])).toBe(`${prefix}the preview frame did not start, with this tab in the background`);
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

/**
 * A screenshot saved as a file (`save`): one image, of exactly the region, in the asked format.
 * jsdom paints nothing, so the capture hands back a stand-in bitmap and the canvas records what was
 * drawn and encodes a few fixed bytes in the type it is asked for.
 */
describe('a screenshot saved as a file', () => {
  const drawn: number[][] = [];
  beforeEach(() => {
    drawn.length = 0;
    stubs.capture.mockResolvedValue({ close: () => {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      fillRect: () => {},
      drawImage: (_bitmap: unknown, ...box: number[]) => { drawn.push(box); },
    }) as unknown as CanvasRenderingContext2D);
    // jsdom's Blob has no arrayBuffer(); the encoder reads only that.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => {
      done({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Blob);
    });
  });

  /** Start a job, settle its frame at `height`, and answer an inspect with `node`. */
  async function run(job: Parameters<typeof renderPage>[0], height: number, node?: { box: { x: number; y: number; w: number; h: number } }) {
    const result = renderPage(job);
    await vi.advanceTimersByTimeAsync(0);
    const frame = document.body.querySelector('iframe')!;
    frame.contentWindow!.addEventListener('message', (event) => {
      const data = event.data as { type?: string; reqId?: number };
      if (data.type === 'canvas:inspect') post(frame, { type: 'canvas:inspected', reqId: data.reqId, report: { node: { ...node, hidden: false }, matches: 1 } });
    });
    post(frame, { type: 'canvas:settled', height });
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    return result;
  }

  it('is the whole page as one PNG, painted to its end rather than as far as tiles reach', async () => {
    // At 3840 px wide a tile is 299 px tall, so six tiles reach about 1,840 px of a 3,000 px page.
    const result = await run({ kind: 'screenshot', projectId: 'p1', page: '/index.html', width: 3840, full: true, save: 'image/png' }, 3000);
    expect(result.ok && result.kind === 'screenshot' ? result.images.map(({ mediaType, width, height }) => ({ mediaType, width, height })) : result)
      .toEqual([{ mediaType: 'image/png', width: 3840, height: 3000 }]);
    expect(stubs.capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ captureWidth: 3840, captureHeight: 3000 }));
  });

  it('is exactly the element, with none of the room a model gets around it', async () => {
    const box = { x: 100, y: 200, w: 300, h: 150 };
    const saved = await run({ kind: 'screenshot', projectId: 'p1', page: '/index.html', width: 1440, target: '.hero', save: 'image/jpeg' }, 900, { box });
    expect(saved.ok && saved.kind === 'screenshot' ? saved.images.map(({ mediaType, region }) => ({ mediaType, region })) : saved)
      .toEqual([{ mediaType: 'image/jpeg', region: { x: 100, y: 200, w: 300, h: 150 } }]);
    expect(drawn.at(-1)).toEqual([100, 200, 300, 150, 0, 0, 300, 150]);

    document.body.querySelectorAll('iframe').forEach((f) => f.remove());
    const looked = await run({ kind: 'screenshot', projectId: 'p1', page: '/index.html', width: 1440, target: '.hero' }, 900, { box });
    expect(looked.ok && looked.kind === 'screenshot' ? looked.images[0].region : looked).toEqual({ x: 84, y: 184, w: 332, h: 182 });
  });

  it('is refused before painting when a side would pass 4096 px', async () => {
    const result = await run({ kind: 'screenshot', projectId: 'p1', page: '/index.html', width: 1440, full: true, save: 'image/png' }, 5000);
    expect(result).toEqual({ ok: false, error: 'the image would be 1440×5000 px, and a saved image is at most 4096 px on a side' });
    expect(stubs.capture).not.toHaveBeenCalled();
  });
});
