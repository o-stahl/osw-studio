// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CAPTURE_RUNTIME_JS, requestFrameCapture } from '../frame-capture';
import { TOOLBAR_HOST_ATTR } from '../toolbar-dom';

/**
 * The screenshot runtime runs inside the preview frame, which the host cannot read. These run it
 * against stub painters: what it paints, what it leaves out, and what it posts back.
 *
 * The selection toolbar is the reason the filter and `prepareClone` exist. It lives inside the
 * previewed document and stays visible while an element is selected, so without them a capture
 * taken with a selection bakes the toolbar into the thumbnail.
 */

type Win = Window & { modernScreenshot?: unknown; html2canvas?: unknown; __oswCaptureLibs?: unknown };
const win = window as Win;

const msg = (opts: Partial<{ fullPage: boolean }> = {}) => ({
  type: 'preview:capture',
  reqId: 7,
  opts: { captureWidth: 1280, captureHeight: 720, fullPage: false, waitForContent: false, minWaitDelay: 0, ...opts },
  toolbarAttr: TOOLBAR_HOST_ATTR,
  libBase: 'http://app.test/preview-capture/',
});

function run(m = msg()): Promise<{ reply: Record<string, unknown>; transfer: unknown[] }> {
  return new Promise(resolve => {
    new Function('msg', 'post', CAPTURE_RUNTIME_JS)(m, (reply: Record<string, unknown>, transfer: unknown[]) =>
      resolve({ reply, transfer }));
  });
}

const canvas = { width: 1280, height: 720 };

beforeEach(() => {
  document.body.innerHTML = '<main>page</main>';
  const toolbar = document.createElement('div');
  toolbar.setAttribute(TOOLBAR_HOST_ATTR, '');
  document.body.appendChild(toolbar);
  vi.stubGlobal('createImageBitmap', vi.fn(async (c: unknown) => ({ from: c })));
});

afterEach(() => {
  delete win.modernScreenshot;
  delete win.html2canvas;
  delete win.__oswCaptureLibs;
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('CAPTURE_RUNTIME_JS', () => {
  it('paints the document with the browser painter and posts the bitmap back, transferred', async () => {
    const domToCanvas = vi.fn(async () => canvas);
    win.modernScreenshot = { domToCanvas };
    win.html2canvas = vi.fn();

    const { reply, transfer } = await run();

    expect(reply).toEqual({ type: 'preview:capture-result', reqId: 7, bitmap: { from: canvas } });
    expect(transfer).toEqual([{ from: canvas }]);
    const [root, options] = domToCanvas.mock.calls[0] as unknown as [Element, { filter: (n: Node) => boolean; height: number }];
    expect(root).toBe(document.documentElement);
    expect(options.height).toBe(720);
    expect(options.filter(document.querySelector('main')!)).toBe(true);
    expect(options.filter(document.querySelector(`[${TOOLBAR_HOST_ATTR}]`)!)).toBe(false);
  });

  it('falls back to html2canvas, which paints a clone without the toolbar', async () => {
    win.modernScreenshot = { domToCanvas: vi.fn(async () => { throw new Error('no foreignObject'); }) };
    let cloneHadToolbar: boolean | null = null;
    win.html2canvas = vi.fn(async (_body: Element, o: { onclone: (d: Document) => void }) => {
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      const clone = frame.contentDocument!;
      clone.body.innerHTML = document.body.innerHTML;
      o.onclone(clone);
      cloneHadToolbar = !!clone.querySelector(`[${TOOLBAR_HOST_ATTR}]`);
      frame.remove();
      return canvas;
    });

    const { reply } = await run();

    expect(cloneHadToolbar).toBe(false);
    expect(reply.bitmap).toEqual({ from: canvas });
  });

  it('reports why when neither painter manages', async () => {
    win.modernScreenshot = { domToCanvas: vi.fn(async () => { throw new Error('a'); }) };
    win.html2canvas = vi.fn(async () => { throw new Error('html2canvas broke'); });

    const { reply } = await run();

    expect(reply).toEqual({ type: 'preview:capture-result', reqId: 7, error: 'html2canvas broke' });
  });

  it('loads the painters from the app when the frame does not have them', async () => {
    const appended: string[] = [];
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      const src = (node as unknown as HTMLScriptElement).src;
      appended.push(src);
      append(node);
      // Stand in for the script having run.
      if (src.endsWith('modern-screenshot.js')) win.modernScreenshot = { domToCanvas: async () => canvas };
      if (src.endsWith('html2canvas.js')) win.html2canvas = vi.fn();
      queueMicrotask(() => (node as unknown as HTMLScriptElement).onload?.(new Event('load')));
      return node;
    });

    const { reply } = await run();

    expect(appended).toEqual([
      'http://app.test/preview-capture/modern-screenshot.js',
      'http://app.test/preview-capture/html2canvas.js',
    ]);
    expect(reply.bitmap).toEqual({ from: canvas });
  });
});

describe('requestFrameCapture', () => {
  function fakeFrame() {
    const contentWindow = { postMessage: vi.fn() };
    const iframe = {
      contentWindow,
      get contentDocument(): Document { throw new DOMException('cross-origin', 'SecurityError'); },
    } as unknown as HTMLIFrameElement;
    return { iframe, contentWindow };
  }
  const opts = { captureWidth: 1280, captureHeight: 720, fullPage: false, waitForContent: false, minWaitDelay: 0 };
  const reply = (source: unknown, data: unknown) =>
    window.dispatchEvent(Object.assign(new Event('message'), { source, data }));

  it('sends the runtime and resolves with the bitmap the frame posts for this request', async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = requestFrameCapture(iframe, opts, 1000);
    const sent = contentWindow.postMessage.mock.calls[0][0];
    expect(sent).toMatchObject({ type: 'preview:capture', runtime: CAPTURE_RUNTIME_JS, opts });

    reply({}, { type: 'preview:capture-result', reqId: sent.reqId, bitmap: 'forged' });
    reply(contentWindow, { type: 'preview:capture-result', reqId: sent.reqId + 1, bitmap: 'other request' });
    reply(contentWindow, { type: 'preview:capture-result', reqId: sent.reqId, bitmap: 'painted' });

    await expect(pending).resolves.toBe('painted');
  });

  it("rejects with the frame's reason", async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = requestFrameCapture(iframe, opts, 1000);
    const { reqId } = contentWindow.postMessage.mock.calls[0][0];
    reply(contentWindow, { type: 'preview:capture-result', reqId, error: 'html2canvas broke' });
    await expect(pending).rejects.toThrow('html2canvas broke');
  });

  it('gives up when the frame never answers', async () => {
    vi.useFakeTimers();
    const { iframe } = fakeFrame();
    const pending = requestFrameCapture(iframe, opts, 500);
    vi.advanceTimersByTime(500);
    await expect(pending).rejects.toThrow('timed out');
    vi.useRealTimers();
  });
});
