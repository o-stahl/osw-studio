// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SCRIPT_FRAME_HTML, scriptWorkerResponse } from '../script-sandbox';
import type { ScriptWorkerResponse } from '@/lib/scripting/types';

/**
 * Python and Lua run in a worker the sandboxed frame starts, so project code never shares the app's
 * origin. These cover the host's side (what it creates, what it sends, and what it accepts back) and
 * the frame's script, which jsdom does not run, against stand-ins for its parent and its worker. The
 * real frame and worker need a browser and are not run here.
 */

describe('scriptWorkerResponse', () => {
  it('rebuilds the messages the runner acts on from their checked fields', () => {
    expect(scriptWorkerResponse({ type: 'stdout', data: 'hi', extra: 1 })).toEqual({ type: 'stdout', data: 'hi' });
    expect(scriptWorkerResponse({ type: 'stderr', data: 'e' })).toEqual({ type: 'stderr', data: 'e' });
    expect(scriptWorkerResponse({ type: 'status', data: 's' })).toEqual({ type: 'status', data: 's' });
    expect(scriptWorkerResponse({ type: 'error', data: 'x' })).toEqual({ type: 'error', data: 'x' });
    expect(scriptWorkerResponse({ type: 'complete', exitCode: 0 })).toEqual({ type: 'complete', exitCode: 0 });
    expect(scriptWorkerResponse({ type: 'output-file', path: '/output/plot.png', content: 'AA==' }))
      .toEqual({ type: 'output-file', path: '/output/plot.png', content: 'AA==' });
  });

  it('drops anything else', () => {
    for (const bad of [
      null, 'stdout', {}, { type: 'stdout' }, { type: 'stdout', data: 3 },
      { type: 'complete', exitCode: '0' }, { type: 'complete', exitCode: 0.5 },
      { type: 'navigate', path: '/' }, { type: 'output-file', path: '/index.html', content: 'x' },
      { type: 'output-file', path: '/output/../index.html', content: 'x' },
      { type: 'output-file', path: '/output/a/b.txt', content: 'x' },
      { type: 'output-file', path: '/output/..', content: 'x' },
      { type: 'output-file', path: '/output/x.png', content: new Uint8Array(1) },
    ]) {
      expect(scriptWorkerResponse(bad)).toBeNull();
    }
  });
});

describe('ScriptSandbox', () => {
  let messages: ScriptWorkerResponse[];
  let errors: string[];
  const fetchMock = vi.fn();
  // Fresh per test: the module keeps the worker's source once loaded.
  let ScriptSandbox: typeof import('../script-sandbox').ScriptSandbox;

  beforeEach(async () => {
    vi.resetModules();
    ({ ScriptSandbox } = await import('../script-sandbox'));
    messages = [];
    errors = [];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('/* worker */', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function open() {
    const sandbox = new ScriptSandbox({ onMessage: (m) => messages.push(m), onError: (e) => errors.push(e) });
    const frame = document.querySelector('iframe')!;
    const sent: unknown[] = [];
    vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((m: unknown) => { sent.push(m); });
    const fromFrame = (data: unknown, source: Window | null = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent('message', { data, source }));
    return { sandbox, frame, sent, fromFrame };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('starts a frame with an opaque origin and nothing else', () => {
    const { frame } = open();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.srcdoc).toBe(SCRIPT_FRAME_HTML);
    expect(frame.style.display).toBe('none');
  });

  it('sends the worker\'s source once the frame is ready, then what was posted before it', async () => {
    const { sandbox, sent, fromFrame } = open();
    sandbox.postMessage({ type: 'execute', payload: 1 });
    expect(sent).toEqual([]);

    fromFrame({ type: 'sandbox:ready' });
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('/workers/script-worker.js');
    expect(sent).toEqual([
      { type: 'sandbox:start', source: '/* worker */' },
      { type: 'sandbox:post', data: { type: 'execute', payload: 1 } },
    ]);

    sandbox.postMessage({ type: 'execute', payload: 2 });
    expect(sent.at(-1)).toEqual({ type: 'sandbox:post', data: { type: 'execute', payload: 2 } });
  });

  it('passes on checked worker output from its own frame only', async () => {
    const { fromFrame } = open();
    fromFrame({ type: 'sandbox:message', data: { type: 'stdout', data: 'hello' } });
    fromFrame({ type: 'sandbox:message', data: { type: 'output-file', path: '/src/app.py', content: 'x' } });
    fromFrame({ type: 'sandbox:message', data: { type: 'stdout', data: 'from elsewhere' } }, window);
    fromFrame({ type: 'sandbox:error', error: 'boom' });
    expect(messages).toEqual([{ type: 'stdout', data: 'hello' }]);
    expect(errors).toEqual(['boom']);
  });

  it('reports a worker source it cannot load, and tries again next time', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const first = open();
    first.fromFrame({ type: 'sandbox:ready' });
    await settle();
    expect(errors).toEqual([expect.stringContaining('HTTP 404')]);
    expect(first.sent).toEqual([]);
    first.sandbox.terminate();

    const second = open();
    second.fromFrame({ type: 'sandbox:ready' });
    await settle();
    expect(second.sent[0]).toEqual({ type: 'sandbox:start', source: '/* worker */' });
  });

  it('removes the frame on terminate, and hears nothing from it after', () => {
    const { sandbox, frame, fromFrame } = open();
    sandbox.terminate();
    expect(frame.isConnected).toBe(false);
    fromFrame({ type: 'sandbox:message', data: { type: 'stdout', data: 'late' } });
    expect(messages).toEqual([]);
  });

  it('reports nothing once terminated, though its worker source then fails to load', async () => {
    // The next run terminates this sandbox; a late error from it would end that run instead.
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    const { sandbox, sent, fromFrame } = open();
    fromFrame({ type: 'sandbox:ready' });
    sandbox.terminate();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('the frame\'s script', () => {
  type FrameListener = (event: { data: unknown; source: unknown }) => void;

  /** Runs the frame's script against stand-ins for its parent and the Worker, Blob and URL it uses. */
  function runFrame({ workerFails }: { workerFails?: Error } = {}) {
    const script = /<script>([\s\S]*)<\/script>/.exec(SCRIPT_FRAME_HTML)![1];
    const parent = { postMessage: vi.fn<(message: unknown, targetOrigin: string) => void>() };
    const blobs = new Map<string, FrameBlob>();
    const workers: FrameWorker[] = [];
    let listener: FrameListener | undefined;

    class FrameBlob {
      constructor(readonly parts: unknown[], readonly options: { type: string }) {}
    }
    class FrameWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      readonly posted: unknown[] = [];
      readonly source: string;
      readonly type: string;
      constructor(url: string) {
        if (workerFails) throw workerFails;
        const blob = blobs.get(url)!;
        this.source = blob.parts.join('');
        this.type = blob.options.type;
        workers.push(this);
      }
      postMessage(data: unknown) { this.posted.push(data); }
    }
    const urls = {
      createObjectURL: (blob: FrameBlob) => {
        const url = `blob:${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
    };
    const addEventListener = (type: string, fn: FrameListener) => { if (type === 'message') listener = fn; };

    new Function('window', 'addEventListener', 'Worker', 'Blob', 'URL', script)(
      { parent }, addEventListener, FrameWorker, FrameBlob, urls,
    );
    return {
      parent,
      workers,
      /** A message to the frame, from its parent unless another sender is given. */
      send: (data: unknown, source: unknown = parent) => listener!({ data, source }),
      /** What the frame has posted to its parent. */
      up: () => parent.postMessage.mock.calls.map(([message]) => message),
    };
  }

  it('tells its parent it is ready', () => {
    expect(runFrame().parent.postMessage.mock.calls).toEqual([[{ type: 'sandbox:ready' }, '*']]);
  });

  it('starts one worker from the source its parent sends, and hands it what its parent posts', () => {
    const frame = runFrame();
    frame.send({ type: 'sandbox:start', source: 'self.onmessage = run;' });
    frame.send({ type: 'sandbox:post', data: { type: 'execute', payload: 1 } });
    expect(frame.workers.map((w) => [w.source, w.type])).toEqual([['self.onmessage = run;', 'text/javascript']]);
    expect(frame.workers[0].posted).toEqual([{ type: 'execute', payload: 1 }]);
  });

  it('passes its worker\'s messages and errors up to its parent', () => {
    const frame = runFrame();
    frame.send({ type: 'sandbox:start', source: 'w' });
    const [worker] = frame.workers;
    worker.onmessage!({ data: { type: 'stdout', data: 'hi' } });
    worker.onerror!({ message: 'boom' });
    expect(frame.up()).toEqual([
      { type: 'sandbox:ready' },
      { type: 'sandbox:message', data: { type: 'stdout', data: 'hi' } },
      { type: 'sandbox:error', error: 'boom' },
    ]);
  });

  it('ignores messages from anyone but its parent', () => {
    // Another frame on the page can post here too; only the parent may start the worker or feed it.
    const frame = runFrame();
    const sibling = {};
    frame.send({ type: 'sandbox:start', source: 'theirs' }, sibling);
    frame.send({ type: 'sandbox:start', source: 'ours' });
    frame.send({ type: 'sandbox:post', data: 'theirs' }, sibling);
    frame.send({ type: 'sandbox:post', data: 'ours' });
    expect(frame.workers.map((w) => w.source)).toEqual(['ours']);
    expect(frame.workers[0].posted).toEqual(['ours']);
  });

  it('starts its worker once', () => {
    const frame = runFrame();
    frame.send({ type: 'sandbox:start', source: 'first' });
    frame.send({ type: 'sandbox:start', source: 'second' });
    frame.send({ type: 'sandbox:post', data: 'x' });
    expect(frame.workers.map((w) => w.source)).toEqual(['first']);
    expect(frame.workers[0].posted).toEqual(['x']);
  });

  it('tells its parent when the worker cannot be started', () => {
    const frame = runFrame({ workerFails: new Error('blocked') });
    frame.send({ type: 'sandbox:start', source: 'w' });
    expect(frame.up()).toEqual([{ type: 'sandbox:ready' }, { type: 'sandbox:error', error: 'blocked' }]);
  });
});
