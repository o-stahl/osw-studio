// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CAPTURE_RUNTIME_JS, requestFrameCapture } from '../frame-capture';
import { TOOLBAR_HOST_ATTR } from '../toolbar-dom';

/**
 * The screenshot runtime runs inside the preview frame, which the host cannot read. These run it
 * against stub painters: what it paints, what it leaves out, and what it posts back.
 *
 * The selection toolbar is the reason for the filter. It lives inside the previewed document and stays
 * visible while an element is selected, so without it a capture taken with a selection bakes the
 * toolbar into the thumbnail.
 */

type Win = Window & { modernScreenshot?: unknown; __oswCaptureLibs?: unknown };
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

interface Context {
  root: Element;
  options: { filter: (n: Node) => boolean; width: number; height: number; scale: number; autoDestruct: boolean };
  sandbox?: {
    contentWindow: { document: { body: Element; createElement: (t: string) => Element }; getComputedStyle: typeof getComputedStyle };
    remove: () => void;
  };
}

/** modern-screenshot, as far as the runtime uses it: a context it can hand a sandbox to, and a painter. */
function stubPainter(paint: (context: Context) => Promise<unknown> = async () => canvas) {
  const contexts: Context[] = [];
  win.modernScreenshot = {
    createContext: vi.fn(async (root: Element, options: Context['options']) => {
      const context: Context = { root, options };
      contexts.push(context);
      return context;
    }),
    domToCanvas: vi.fn(paint),
  };
  return contexts;
}

beforeEach(() => {
  document.body.innerHTML = '<main>page</main>';
  const toolbar = document.createElement('div');
  toolbar.setAttribute(TOOLBAR_HOST_ATTR, '');
  document.body.appendChild(toolbar);
  vi.stubGlobal('createImageBitmap', vi.fn(async (c: unknown) => ({ from: c })));
});

afterEach(() => {
  delete win.modernScreenshot;
  delete win.__oswCaptureLibs;
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('CAPTURE_RUNTIME_JS', () => {
  it('paints the document and posts the bitmap back, transferred', async () => {
    const contexts = stubPainter();

    const { reply, transfer } = await run();

    expect(reply).toEqual({ type: 'preview:capture-result', reqId: 7, bitmap: { from: canvas } });
    expect(transfer).toEqual([{ from: canvas }]);
    const [{ root, options }] = contexts;
    expect(root).toBe(document.documentElement);
    expect(options.height).toBe(720);
    expect(options.autoDestruct).toBe(true);
  });

  it('leaves the selection toolbar and its own sandbox out of the picture', async () => {
    let filtered: Record<string, boolean> = {};
    const contexts = stubPainter(async (context: Context) => {
      const host = document.querySelector('[data-osw-capture]')!;
      filtered = {
        page: context.options.filter(document.querySelector('main')!),
        toolbar: context.options.filter(document.querySelector(`[${TOOLBAR_HOST_ATTR}]`)!),
        sandbox: context.options.filter(host),
      };
      return canvas;
    });

    await run();

    expect(contexts).toHaveLength(1);
    expect(filtered).toEqual({ page: true, toolbar: false, sandbox: false });
  });

  it('gives the painter a sandbox in this document, not a frame it could not read', async () => {
    let seen: { inShadow: boolean; display: string } | null = null;
    stubPainter(async (context: Context) => {
      // What modern-screenshot does with it: make an element, attach it, read its default style.
      const { document: doc, getComputedStyle: styleOf } = context.sandbox!.contentWindow;
      const probe = doc.createElement('div');
      doc.body.appendChild(probe);
      seen = { inShadow: probe.getRootNode() instanceof ShadowRoot, display: styleOf(probe).display };
      return canvas;
    });

    await run();

    expect(seen).toEqual({ inShadow: true, display: 'block' });
  });

  it('removes its sandbox when the painter destroys the context', async () => {
    stubPainter(async (context: Context) => {
      context.sandbox!.remove();
      return canvas;
    });
    await run();
    expect(document.querySelector('[data-osw-capture]')).toBeNull();
  });

  describe('page size', () => {
    // jsdom does no layout; these give the document the measurements a browser would.
    const measured: Array<[Element, string]> = [];
    function measure(el: Element, sizes: Record<string, number>) {
      for (const [name, value] of Object.entries(sizes)) {
        Object.defineProperty(el, name, { configurable: true, value });
        measured.push([el, name]);
      }
    }
    afterEach(() => {
      for (const [el, name] of measured.splice(0)) delete (el as unknown as Record<string, unknown>)[name];
    });

    it('paints the whole page when asked for the full page, and the viewport otherwise', async () => {
      measure(document.documentElement, { clientWidth: 1280, clientHeight: 720, scrollHeight: 2400, offsetHeight: 2400 });
      measure(document.body, { scrollHeight: 3100, offsetHeight: 3000 });
      const contexts = stubPainter();

      await run(msg({ fullPage: true }));
      await run(msg({ fullPage: false }));

      expect(contexts.map(c => c.options.height)).toEqual([3100, 720]);
    });

    it('paints a narrow page at a higher scale, up to twice, so the thumbnail stays sharp', async () => {
      const contexts = stubPainter();
      measure(document.documentElement, { clientWidth: 800 });
      await run();
      measure(document.documentElement, { clientWidth: 375 });
      await run();
      measure(document.documentElement, { clientWidth: 1600 });
      await run();

      expect(contexts.map(c => [c.options.width, c.options.scale])).toEqual([[800, 1.6], [375, 2], [1600, 1]]);
    });

    it('reports a page that painted nothing', async () => {
      stubPainter(async () => ({ width: 1280, height: 0 }));
      const { reply } = await run();
      expect(reply).toEqual({ type: 'preview:capture-result', reqId: 7, error: 'empty canvas' });
    });
  });

  it('reports why when painting fails', async () => {
    stubPainter(async () => { throw new Error('no foreignObject'); });

    const { reply } = await run();

    expect(reply).toEqual({ type: 'preview:capture-result', reqId: 7, error: 'no foreignObject' });
  });

  it('loads the painter from the app when the frame does not have it', async () => {
    const appended: string[] = [];
    const append = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      appended.push((node as unknown as HTMLScriptElement).src);
      append(node);
      stubPainter(); // stands in for the script having run
      queueMicrotask(() => (node as unknown as HTMLScriptElement).onload?.(new Event('load')));
      return node;
    });

    const { reply } = await run();

    expect(appended).toEqual(['http://app.test/preview-capture/modern-screenshot.js']);
    expect(reply.bitmap).toEqual({ from: canvas });
  });
});

describe('requestFrameCapture', () => {
  // jsdom has no ImageBitmap; the host accepts only a real one from the frame.
  class FakeBitmap {}
  beforeEach(() => vi.stubGlobal('ImageBitmap', FakeBitmap));
  afterEach(() => vi.unstubAllGlobals());

  function fakeFrame() {
    const contentWindow = { postMessage: vi.fn() };
    const iframe = { contentWindow } as unknown as HTMLIFrameElement;
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

    const painted = new FakeBitmap();
    reply({}, { type: 'preview:capture-result', reqId: sent.reqId, bitmap: new FakeBitmap() });
    reply(contentWindow, { type: 'preview:capture-result', reqId: sent.reqId + 1, bitmap: new FakeBitmap() });
    reply(contentWindow, { type: 'preview:capture-result', reqId: sent.reqId, bitmap: painted });

    await expect(pending).resolves.toBe(painted);
  });

  it('rejects a reply whose bitmap is not an image', async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = requestFrameCapture(iframe, opts, 1000);
    const { reqId } = contentWindow.postMessage.mock.calls[0][0];
    reply(contentWindow, { type: 'preview:capture-result', reqId, bitmap: { width: 1 } });
    await expect(pending).rejects.toThrow('capture failed');
  });

  it("rejects with the frame's reason", async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = requestFrameCapture(iframe, opts, 1000);
    const { reqId } = contentWindow.postMessage.mock.calls[0][0];
    reply(contentWindow, { type: 'preview:capture-result', reqId, error: 'painter broke' });
    await expect(pending).rejects.toThrow('painter broke');
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
