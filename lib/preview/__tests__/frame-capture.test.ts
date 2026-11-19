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
  options: {
    filter: (n: Node) => boolean; width: number; height: number; scale: number; autoDestruct: boolean;
    backgroundColor: string; onCreateForeignObjectSvg: (svg: SVGSVGElement) => void;
  };
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

  it('paints the root in the page\'s own background, and white where it has none', async () => {
    const contexts = stubPainter();
    document.documentElement.style.backgroundColor = 'rgb(11, 10, 8)';
    await run();
    document.documentElement.style.backgroundColor = '';
    await run();
    expect(contexts.map(c => c.options.backgroundColor)).toEqual(['rgb(11, 10, 8)', '#ffffff']);
  });

  describe('web fonts of a stylesheet the frame cannot read', () => {
    const rule = (family: string, range: string, cssText: string) => ({ type: 5, cssText, family, range });
    type Rule = ReturnType<typeof rule>;
    class FakeSheet {
      cssRules: unknown[] = [];
      replaceSync(text: string) {
        this.cssRules = (JSON.parse(text) as Rule[]).map(r => ({
          type: r.type,
          cssText: r.cssText,
          style: { getPropertyValue: (p: string) => ({ 'font-family': r.family, 'font-style': 'normal', 'unicode-range': r.range } as Record<string, string>)[p] ?? '' },
        }));
      }
    }

    beforeEach(() => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.test/css';
      Object.defineProperty(link, 'sheet', { get: () => ({ get cssRules() { throw new DOMException('blocked', 'SecurityError'); } }) });
      document.head.appendChild(link);
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: [
          { family: '"Inter"', style: 'normal', unicodeRange: 'U+0-FF', status: 'loaded' },
          { family: 'Inter', style: 'normal', unicodeRange: 'U+100-1FF', status: 'unloaded' },
        ],
      });
      vi.stubGlobal('CSSStyleSheet', FakeSheet);
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        text: async () => JSON.stringify([
          rule('Inter', 'U+0-FF', '@font-face{latin}'),
          rule('Inter', 'U+100-1FF', '@font-face{extended}'),
          { ...rule('Inter', 'U+0-FF', 'p{}'), type: 1 },
        ]),
      })));
    });
    afterEach(() => { delete (document as unknown as { fonts?: unknown }).fonts; });

    const fontStyle = () => document.querySelector<HTMLStyleElement>('style[data-osw-capture]');

    it('hands the painter the faces the page loaded, in a sheet the page does not apply', async () => {
      let seen: { css: string; media: string; painted: boolean } | null = null;
      stubPainter(async (context: Context) => {
        const style = fontStyle()!;
        seen = { css: style.textContent!.trim(), media: style.media, painted: context.options.filter(style) };
        return canvas;
      });

      await run();

      expect(fetch).toHaveBeenCalledWith('https://fonts.test/css');
      expect(seen).toEqual({ css: '@font-face{latin}', media: 'not all', painted: false });
      expect(fontStyle()).toBeNull();
    });

    it('removes that sheet when painting fails', async () => {
      stubPainter(async () => { throw new Error('no foreignObject'); });
      await run();
      expect(fontStyle()).toBeNull();
    });

    it('paints without the fonts when they do not arrive in time', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
        let styled = true;
        stubPainter(async () => { styled = fontStyle() !== null; return canvas; });
        const pending = run();
        await vi.advanceTimersByTimeAsync(1500);
        expect((await pending).reply.bitmap).toEqual({ from: canvas });
        expect(styled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('gives the painter 10 s before it reports the render timed out', async () => {
    vi.useFakeTimers();
    try {
      stubPainter(() => new Promise(() => {}));
      let reply: Record<string, unknown> | null = null;
      void run().then(r => { reply = r.reply; });
      await vi.advanceTimersByTimeAsync(9900);
      expect(reply).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(reply).toMatchObject({ error: 'render timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts what CSS gave a symbol\'s shapes on the painter\'s copy, and leaves what resolves at the <use>', async () => {
    const NS = 'http://www.w3.org/2000/svg';
    const holder = document.createElement('div');
    holder.innerHTML = `<svg><symbol id="i"><path class="ic"/><rect fill="var(--logo-bg,#000)"/><g fill="currentColor"><path class="inherits"/></g></symbol></svg>`;
    document.body.appendChild(holder);
    const symbol = holder.querySelector('symbol')!;
    const color = 'rgb(1, 2, 3)';
    const base: Record<string, string> = { color, fill: 'rgb(0, 0, 0)', stroke: 'none', 'stroke-width': '1px' };
    const styles = new Map<Element, Record<string, string>>([
      [symbol, base],
      [symbol.querySelector('.ic')!, { ...base, fill: 'none', stroke: color, 'stroke-width': '2px' }],
      [symbol.querySelector('rect')!, { ...base, fill: 'rgb(9, 9, 9)' }],
      [symbol.querySelector('g')!, { ...base, fill: color }],
      [symbol.querySelector('.inherits')!, { ...base, fill: color }],
    ]);
    vi.stubGlobal('getComputedStyle', (el: Element) => {
      const values = styles.get(el) ?? base;
      return { color: values.color, backgroundColor: '', getPropertyValue: (p: string) => values[p] ?? '' };
    });
    const contexts = stubPainter();
    await run();

    const svg = document.createElementNS(NS, 'svg');
    const defs = svg.appendChild(document.createElementNS(NS, 'defs'));
    const copy = defs.appendChild(symbol.cloneNode(true)) as SVGElement;
    contexts[0].options.onCreateForeignObjectSvg(svg);

    const style = (selector: string) => copy.querySelector<SVGElement>(selector)!.style;
    expect(style('.ic').getPropertyValue('fill')).toBe('none');
    expect(style('.ic').getPropertyValue('stroke').toLowerCase()).toBe('currentcolor');
    expect(style('.ic').getPropertyValue('stroke-width')).toBe('2px');
    expect(style('rect').getPropertyValue('fill')).toBe('');
    expect(style('g').getPropertyValue('fill')).toBe('');
    expect(style('.inherits').getPropertyValue('fill')).toBe('');
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
