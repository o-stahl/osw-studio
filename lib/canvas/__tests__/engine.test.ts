// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '@/lib/utils';
import { layoutArtboards } from '../layout';
import { DEFAULT_BUDGET, artboardId, type LiveBudget } from '../types';
import type { ThumbCache } from '../thumbs';

/**
 * The engine against stand-in frames: jsdom gives each iframe a window but never loads its srcdoc, so
 * what a frame would post (its shell asking for the page, `canvas:ready`, a settle's result) is
 * posted here from that window. The shell's page delivery, function calls and painting are stubbed.
 */

const stubs = vi.hoisted(() => ({
  send: vi.fn<(target: Window, loadId: number, html: string, blobUrls: Iterable<string>, cache?: Map<string, Blob>) => Promise<void>>(),
  answer: vi.fn<() => Promise<void>>(),
  capture: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('@/lib/preview/preview-shell', () => ({
  previewShellHtml: (loadId: number) => `<!doctype html><title>shell ${loadId}</title>`,
  sendShellContent: (target: Window, loadId: number, html: string, blobUrls: Iterable<string>, cache?: Map<string, Blob>) =>
    stubs.send(target, loadId, html, blobUrls, cache),
}));
vi.mock('@/lib/preview/function-proxy', () => ({ answerFunctionCall: () => stubs.answer() }));
vi.mock('@/lib/preview/frame-capture', () => ({ requestFrameCapture: () => stubs.capture() }));

import { CanvasEngine, type CanvasCompile, type EngineCallbacks } from '../engine';

const PAGE = '/index.html';
const BOARD = artboardId(PAGE, 'desktop');
const HTML = '<!doctype html><html><head></head><body><img src="/logo.png"><h1>Hi</h1></body></html>';
/** The desktop artboard and around it, zoomed in far enough for pages to go live. */
const IN_VIEW = { x: -100, y: -100, w: 2000, h: 1400 };

/** A compile: `version` names its blob URLs, which every compile makes anew; the signature follows the HTML. */
function compileOf(version: string, html = HTML): CanvasCompile {
  return {
    blobUrls: new Map([['/logo.png', `blob:http://localhost:3000/logo-${version}`], ['/index.html', `blob:http://localhost:3000/index-${version}`]]),
    pages: new Map([[PAGE, { html, signature: `sig:${html.length}:${html.slice(-40)}` }]]),
  };
}

let host: HTMLDivElement;
let engine: CanvasEngine | null = null;
let urls = 0;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  stubs.send.mockReset().mockResolvedValue(undefined);
  stubs.answer.mockReset().mockResolvedValue(undefined);
  // Nothing paints in jsdom.
  stubs.capture.mockReset().mockRejectedValue(new Error('nothing paints in jsdom'));
  vi.spyOn(logger, 'error').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => `blob:http://localhost:3000/thumb-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  engine?.destroy();
  engine = null;
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(opts: { budget?: Partial<LiveBudget>; thumbs?: ThumbCache; callbacks?: EngineCallbacks } = {}) {
  engine = new CanvasEngine({ budget: { ...DEFAULT_BUDGET, ...opts.budget }, jobHost: host, thumbs: opts.thumbs, callbacks: opts.callbacks });
  const slot = document.createElement('div');
  host.appendChild(slot);
  engine.setBoards(layoutArtboards([{ file: PAGE, title: 'Home' }], ['desktop'], () => undefined));
  engine.attachSlot(BOARD, slot);
  return { engine, slot };
}

/** Let promise callbacks run, and timers due by now. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function post(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
}

const loadIdOf = (frame: HTMLIFrameElement) => Number(/shell (\d+)/.exec(frame.srcdoc)?.[1]);
const frames = (slot: HTMLElement) => [...slot.querySelectorAll('iframe')];
const jobFrame = () => [...host.children].find((el): el is HTMLIFrameElement => el instanceof HTMLIFrameElement) ?? null;

/** Run the next background job, a settle, and answer it with `html`. */
async function settleNext(html = HTML, height = 1600) {
  await vi.advanceTimersByTimeAsync(1000);
  const frame = jobFrame();
  expect(frame, 'no settle started').not.toBeNull();
  post(frame!, { type: 'canvas:settled', loadId: loadIdOf(frame!), html, height });
  await flush();
}

/** The live artboard's frame, ready. */
function liveFrame(slot: HTMLElement): HTMLIFrameElement {
  const [frame] = frames(slot);
  expect(frame, 'no live frame').toBeDefined();
  post(frame, { type: 'canvas:ready', height: 1600 });
  return frame;
}

describe('frames that fail to load', () => {
  it('logs a page that could not be sent to its frame', async () => {
    const { engine, slot } = setup();
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    const [frame] = frames(slot);
    const failure = new Error('the page could not be read');
    stubs.send.mockRejectedValueOnce(failure);
    post(frame, { type: 'preview:shell-ready', loadId: loadIdOf(frame) });
    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('logs a function call it could not answer', async () => {
    const { engine, slot } = setup();
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    const failure = new Error('the function route is down');
    stubs.answer.mockRejectedValueOnce(failure);
    post(frames(slot)[0], { type: 'preview:function-call', id: 1, path: '/api/x', method: 'GET', headers: [], body: null });
    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('logs the error a frame reports when it cannot build its page', async () => {
    const { engine, slot } = setup();
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    post(frames(slot)[0], { type: 'preview:shell-error', loadId: 1, error: 'document.write failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), 'document.write failed');
  });
});

describe('the shell cache', () => {
  it('serves each frame from the files of the compile it was built with, and nothing older', async () => {
    const cached: Map<string, Blob>[] = [];
    const sent: string[][] = [];
    stubs.send.mockImplementation(async (_target, _loadId, _html, blobUrls, cache) => {
      const list = [...blobUrls];
      for (const url of list) if (!cache!.has(url)) cache!.set(url, new Blob([url]));
      sent.push(list);
      cached.push(cache!);
    });
    const { engine, slot } = setup();
    const first = compileOf('1');
    engine.setCompile(first);
    engine.setView(IN_VIEW, 0.5);
    const one = frames(slot)[0];
    post(one, { type: 'preview:shell-ready', loadId: loadIdOf(one) });
    await flush();

    // A recompile that changes the page loads it again; the same page compiled once more before the
    // new frame asks reloads nothing, so the frame's page names the second compile's files.
    const second = compileOf('2', HTML.replace('Hi', 'Hello'));
    engine.setCompile(second);
    const two = frames(slot).find((f) => f !== one)!;
    engine.setCompile(compileOf('3', HTML.replace('Hi', 'Hello')));
    post(two, { type: 'preview:shell-ready', loadId: loadIdOf(two) });
    await flush();
    expect(sent[1]).toEqual([...second.blobUrls.values()]);
    expect([...cached[1].keys()]).toEqual([...second.blobUrls.values()]);
  });

  it('copies a page left live after a newer compile with its files as tokens, not the old blob URLs', async () => {
    const { engine, slot } = setup();
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    const frame = liveFrame(slot);
    // The same page again: nothing reloads, but every file has a new blob URL.
    engine.setCompile(compileOf('2'));
    const asked = vi.spyOn(frame.contentWindow!, 'postMessage');
    engine.setActive(false);
    const freeze = asked.mock.calls.map(([m]) => m as { type: string; reqId: number }).find((m) => m.type === 'canvas:freeze');
    expect(freeze, 'the page was not asked for its copy').toBeDefined();
    post(frame, { type: 'canvas:frozen', reqId: freeze!.reqId, html: '<body><img src="blob:http://localhost:3000/logo-1"></body>', fields: null, height: 1600 });
    await flush();
    const snapshot = engine.board(BOARD)!.snapshot ?? '';
    expect(snapshot).toContain('/logo.png');
    expect(snapshot).not.toContain('blob:');
  });
});

describe('stills', () => {
  it('mounts one still for a snapshot while it loads, however often the view moves', async () => {
    const { engine, slot } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await settleNext();
    expect(engine.tierOf(BOARD)).toBe('still');
    expect(frames(slot)).toHaveLength(1);
    for (let i = 1; i <= 5; i++) engine.setView({ ...IN_VIEW, x: IN_VIEW.x + i }, 0.5);
    expect(frames(slot)).toHaveLength(1);
    // Ready, it is the one on show, and moving the view mounts nothing more.
    post(frames(slot)[0], { type: 'canvas:ready', height: 1600 });
    engine.setView(IN_VIEW, 0.5);
    expect(frames(slot)).toHaveLength(1);
    expect(frames(slot)[0].style.opacity).toBe('');
  });

  it('mounts a still again after one that was loading went because the page went live', async () => {
    const { engine, slot } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await settleNext();
    const loading = frames(slot)[0];
    // Selected, the artboard goes live; the still finishes loading after, and goes.
    engine.setFocus(BOARD);
    expect(engine.tierOf(BOARD)).toBe('live');
    post(loading, { type: 'canvas:ready', height: 1600 });
    expect(loading.isConnected).toBe(false);
    // Let go before the live page is ready: the still is mounted again.
    engine.setFocus(null);
    await flush();
    expect(engine.tierOf(BOARD)).toBe('still');
    expect(frames(slot)).toHaveLength(1);
    expect(frames(slot)[0]).not.toBe(loading);
  });

  it('shows the still of the newest snapshot when an older one finishes loading after it', async () => {
    const { engine, slot } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await settleNext();
    const older = frames(slot)[0];
    const changed = HTML.replace('Hi', 'Hello');
    engine.setCompile(compileOf('2', changed));
    await settleNext(changed);
    const newer = frames(slot).find((f) => f !== older)!;
    expect(newer).toBeDefined();
    post(older, { type: 'canvas:ready', height: 1600 });
    expect(frames(slot)).toEqual([newer]);
    post(newer, { type: 'canvas:ready', height: 1600 });
    expect(frames(slot)).toEqual([newer]);
    expect(newer.style.opacity).toBe('');
  });

  it('settles again a page copied while it reloaded with a change, as the copy is of the page before it', async () => {
    const { engine, slot } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await settleNext();
    // Selected, the artboard goes live with the first compile's page.
    engine.setFocus(BOARD);
    const frame = frames(slot).at(-1)!;
    post(frame, { type: 'canvas:ready', height: 1600 });
    expect(engine.tierOf(BOARD)).toBe('live');
    const asked = vi.spyOn(frame.contentWindow!, 'postMessage');
    // The page changes; while it reloads, the selection is let go and the old page is copied.
    const changed = HTML.replace('Hi', 'Hello');
    engine.setCompile(compileOf('2', changed));
    engine.setFocus(null);
    const freeze = asked.mock.calls.map(([m]) => m as { type: string; reqId: number }).filter((m) => m.type === 'canvas:freeze').at(-1);
    expect(freeze, 'the page was not asked for its copy').toBeDefined();
    post(frame, { type: 'canvas:frozen', reqId: freeze!.reqId, html: '<body><h1>Hi</h1></body>', fields: null, height: 1600 });
    await flush();
    expect(engine.board(BOARD)!.snapshot).toContain('Hi');
    // The copy is of the page before the change, so the changed page is settled.
    await settleNext(changed);
    expect(engine.board(BOARD)!.snapshot).toContain('Hello');
  });

  it('keeps the thumbnail on show until the still that replaces it is ready', async () => {
    const thumbs: ThumbCache = { get: async () => new Blob(['jpeg']), put: async () => {} };
    const { engine, slot } = setup({ budget: { maxLive: 0 }, thumbs });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.05);
    await flush();
    expect(engine.tierOf(BOARD)).toBe('image');
    await settleNext();
    // Zoomed in, the snapshot shows as a still; the thumbnail stays until it is ready.
    engine.setView(IN_VIEW, 0.5);
    expect(engine.tierOf(BOARD)).toBe('still');
    expect(slot.querySelector('img')).not.toBeNull();
    post(frames(slot)[0], { type: 'canvas:ready', height: 1600 });
    expect(slot.querySelector('img')).toBeNull();
  });
});

describe('a page whose settle fails', () => {
  const settleWarnings = () => vi.mocked(logger.warn).mock.calls.filter(([message]) => String(message).includes('settle'));

  it('is tried once for that version, not again as time passes or the view moves; a new compile tries again', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    // Nothing answers, so the settle times out.
    const started = new Set<number>();
    for (let s = 0; s < 40; s++) {
      engine.setView({ ...IN_VIEW, x: IN_VIEW.x + s }, 0.5);
      await vi.advanceTimersByTimeAsync(1000);
      const frame = jobFrame();
      if (frame?.srcdoc) started.add(loadIdOf(frame));
    }
    expect(started.size).toBe(1);
    expect(settleWarnings()).toEqual([[expect.stringContaining(PAGE), expect.any(Error)]]);
    expect(engine.board(BOARD)!.snapshot).toBeNull();

    const changed = HTML.replace('Hi', 'Hello');
    engine.setCompile(compileOf('2', changed));
    await settleNext(changed);
    expect(engine.board(BOARD)!.snapshot).toContain('Hello');
    expect(settleWarnings()).toHaveLength(1);
  });

  it('settles a page changed while its settle was failing, as the failure was of the version before', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    // Settled once, the artboard is a still; at this zoom no thumbnail is wanted, so only a change of
    // the page settles it again.
    await settleNext();
    expect(engine.tierOf(BOARD)).toBe('still');
    const second = HTML.replace('Hi', 'Hello');
    engine.setCompile(compileOf('2', second));
    await vi.advanceTimersByTimeAsync(1000);
    expect(jobFrame()?.srcdoc, 'no settle started').toBeTruthy();
    const third = HTML.replace('Hi', 'Good day');
    engine.setCompile(compileOf('3', third));
    // The second version's settle times out after the page changed again.
    await vi.advanceTimersByTimeAsync(8000);
    await settleNext(third);
    expect(engine.board(BOARD)!.snapshot).toContain('Good day');
  });

  it('blanks the job frame when its settle times out, and answers nothing more from the page', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    const frame = jobFrame()!;
    expect(frame?.srcdoc, 'no settle started').toBeTruthy();
    await vi.advanceTimersByTimeAsync(8000);
    expect(frame.srcdoc).toBe('');
    post(frame, { type: 'preview:function-call', id: 1, path: '/api/x', method: 'GET', headers: [], body: null });
    await flush();
    expect(stubs.answer).not.toHaveBeenCalled();
  });

  it('logs nothing about a settle under way when it is destroyed', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(jobFrame()?.srcdoc, 'no settle started').toBeTruthy();
    engine.destroy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('the job frame', () => {
  const ABOUT = '/about.html';

  /** Two pages, nothing live: each is settled in turn. */
  function twoPages() {
    engine = new CanvasEngine({ budget: { ...DEFAULT_BUDGET, maxLive: 0 }, jobHost: host });
    engine.setBoards(layoutArtboards([{ file: PAGE, title: 'Home' }, { file: ABOUT, title: 'About' }], ['desktop'], () => undefined));
    const about = '<!doctype html><html><body><h1>About us</h1></body></html>';
    engine.setCompile({ blobUrls: new Map(), pages: new Map([...compileOf('1').pages, [ABOUT, { html: about, signature: 'sig:about' }]]) });
    engine.setView({ x: -100, y: -100, w: 4000, h: 1400 }, 0.5);
    return engine;
  }

  it('is blanked when the page changes while it settles', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    const frame = jobFrame()!;
    const loadId = loadIdOf(frame);
    expect(loadId, 'no settle started').toBeGreaterThan(0);
    engine.setCompile(compileOf('2', HTML.replace('Hi', 'Hello')));
    post(frame, { type: 'canvas:settled', loadId, html: HTML, height: 1600 });
    await flush();
    expect(frame.srcdoc).toBe('');
  });

  it('takes no late answer from a page whose settle timed out as the next settle\'s', async () => {
    const engine = twoPages();
    await vi.advanceTimersByTimeAsync(1000);
    const frame = jobFrame()!;
    const first = loadIdOf(frame);
    expect(first, 'no settle started').toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(1000);
    const second = loadIdOf(frame);
    expect(second, 'the next settle did not start').toBeGreaterThan(first);
    const next = [...engine.boards.values()].find((b) => b.snapVer === '')!;
    expect(next, 'both pages were settled').toBeDefined();
    // The page that timed out answers at last, while the next page settles in the same frame.
    post(frame, { type: 'canvas:settled', loadId: first, html: '<body>Late</body>', height: 900 });
    await flush();
    expect(next.snapshot).toBeNull();
    post(frame, { type: 'canvas:settled', loadId: second, html: next.page === ABOUT ? '<body>About us</body>' : HTML, height: 900 });
    await flush();
    expect(next.snapshot).not.toBeNull();
    expect(next.snapshot).not.toContain('Late');
  });

  it('resolves no settle with a reply that names it by a negative reqId', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    await vi.advanceTimersByTimeAsync(1000);
    const frame = jobFrame()!;
    const loadId = loadIdOf(frame);
    expect(loadId, 'no settle started').toBeGreaterThan(0);
    post(frame, { type: 'canvas:picked', reqId: -loadId, chain: [] });
    post(frame, { type: 'canvas:settled', loadId, html: HTML, height: 1600 });
    await flush();
    expect(engine.board(BOARD)!.snapshot).toEqual(expect.stringContaining('Hi'));
  });
});

describe('answers to what the engine asks a frame', () => {
  it('are taken only from the frame that was asked', async () => {
    const e = new CanvasEngine({ budget: DEFAULT_BUDGET, jobHost: host });
    engine = e;
    const boxes = layoutArtboards([{ file: PAGE, title: 'Home' }], ['desktop', 'phone'], () => undefined);
    e.setBoards(boxes);
    const slots = boxes.map((b) => {
      const el = document.createElement('div');
      host.appendChild(el);
      e.attachSlot(b.id, el);
      return el;
    });
    e.setCompile(compileOf('1'));
    e.setView({ x: -100, y: -100, w: 4000, h: 1400 }, 0.5);
    const [desktop, phone] = slots.map(liveFrame);
    const asked = vi.spyOn(desktop.contentWindow!, 'postMessage');
    const answer = e.ask(BOARD, { type: 'canvas:describe', nodeId: 'n1' });
    const question = asked.mock.calls.map(([m]) => m as { type: string; reqId: number }).find((m) => m.type === 'canvas:describe');
    expect(question, 'the frame was not asked').toBeDefined();
    post(phone, { type: 'canvas:described', reqId: question!.reqId, item: 'from the other artboard' });
    post(desktop, { type: 'canvas:described', reqId: question!.reqId, item: 'from the artboard asked' });
    expect(await answer).toMatchObject({ item: 'from the artboard asked' });
  });
});

describe('what a live page reports for the panel', () => {
  // The frame runs the page's scripts, which can post these too, with anything in them.
  it('passes on the selection\'s boxes and metrics only in the shape the bridge sends them', () => {
    const onRects = vi.fn<NonNullable<EngineCallbacks['onRects']>>();
    const { engine, slot } = setup({ callbacks: { onRects } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    const frame = liveFrame(slot);
    const box = { x: 0, y: 10, w: 200, h: 40 };
    const metrics = { pt: 8, pr: 8, pb: 8, pl: 8, rowGap: 0, columnGap: 0, parentRow: false, gap: { x: 0, y: 50, w: 200, h: 16, across: false }, tag: 'section' };
    post(frame, { type: 'canvas:rects', rects: 'all of them', metrics: null });
    post(frame, { type: 'canvas:rects', rects: [{ ...box, w: '200' }], metrics: null });
    post(frame, { type: 'canvas:rects', rects: [{ ...box, h: Infinity }], metrics: null });
    post(frame, { type: 'canvas:rects', rects: [box], metrics: { ...metrics, pt: 'lots' } });
    post(frame, { type: 'canvas:rects', rects: [box], metrics: { ...metrics, gap: { x: 0, y: 50, w: 200 } } });
    expect(onRects).not.toHaveBeenCalled();
    post(frame, { type: 'canvas:rects', rects: [box, null], metrics });
    post(frame, { type: 'canvas:rects', rects: [], metrics: null });
    expect(onRects.mock.calls).toEqual([[BOARD, [box, null], metrics], [BOARD, [], null]]);
  });

  it('passes on the wheel only with numbers to move the view by', () => {
    const onWheel = vi.fn<NonNullable<EngineCallbacks['onWheel']>>();
    const { engine, slot } = setup({ callbacks: { onWheel } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    const frame = liveFrame(slot);
    post(frame, { type: 'canvas:wheel' });
    post(frame, { type: 'canvas:wheel', dx: '10', dy: 5, deltaMode: 0, zoom: false, x: 1, y: 2 });
    post(frame, { type: 'canvas:wheel', dx: 10, dy: NaN, deltaMode: 0, zoom: false, x: 1, y: 2 });
    expect(onWheel).not.toHaveBeenCalled();
    post(frame, { type: 'canvas:wheel', dx: 10, dy: 5, deltaMode: 0, zoom: true, x: 1, y: 2 });
    expect(onWheel).toHaveBeenCalledWith(BOARD, { dx: 10, dy: 5, deltaMode: 0, zoom: true, x: 1, y: 2 });
  });
});

describe('thumbnails', () => {
  it('warns once when one cannot be taken of a version of the page, and again only for a new version', async () => {
    const { engine } = setup({ budget: { maxLive: 0 } });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.5);
    // Nothing paints in jsdom, so every capture fails.
    await settleNext();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(PAGE), expect.any(Error));
    // Zoomed out, where a thumbnail would be shown: the same version is not tried again.
    for (let i = 0; i < 5; i++) engine.setView({ ...IN_VIEW, x: IN_VIEW.x + i }, 0.05);
    await vi.advanceTimersByTimeAsync(20000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const changed = HTML.replace('Hi', 'Hello');
    engine.setCompile(compileOf('2', changed));
    await settleNext(changed);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('shows a newer thumbnail of an artboard that stays a thumbnail', async () => {
    const thumbs: ThumbCache = { get: async (_page, _device, signature) => new Blob([signature]), put: async () => {} };
    const { engine, slot } = setup({ thumbs });
    engine.setCompile(compileOf('1'));
    engine.setView(IN_VIEW, 0.05);
    await flush();
    expect(engine.tierOf(BOARD)).toBe('image');
    const before = slot.querySelector('img')!.src;
    expect(before).toBe(engine.board(BOARD)!.thumb);

    engine.setCompile(compileOf('2', HTML.replace('Hi', 'Hello')));
    await flush();
    expect(engine.tierOf(BOARD)).toBe('image');
    expect(engine.board(BOARD)!.thumb).not.toBe(before);
    expect(slot.querySelector('img')!.src).toBe(engine.board(BOARD)!.thumb);
  });

  describe('of an artboard removed before its picture comes', () => {
    /** Every object URL made, revoked by the time the engine is gone. */
    function expectNoneLeft(e: CanvasEngine) {
      e.destroy();
      engine = null;
      const made = vi.mocked(URL.createObjectURL).mock.results.map((r) => r.value as string);
      const revoked = vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url);
      expect(made.filter((url) => !revoked.includes(url))).toEqual([]);
    }

    it('leaves no object URL behind when the thumbnail was being painted', async () => {
      let paint: (bitmap: unknown) => void = () => {};
      stubs.capture.mockImplementation(() => new Promise((resolve) => { paint = resolve; }));
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['jpeg'])));
      const { engine } = setup({ budget: { maxLive: 0 } });
      engine.setCompile(compileOf('1'));
      engine.setView(IN_VIEW, 0.5);
      await settleNext();
      expect(stubs.capture, 'no thumbnail was being painted').toHaveBeenCalled();
      // The width is turned off while the thumbnail is painted.
      engine.setBoards([]);
      paint({ width: 10, height: 10, close: () => {} });
      await flush();
      expectNoneLeft(engine);
    });

    it('leaves no object URL behind when the thumbnail was being looked up', async () => {
      let found: (blob: Blob | null) => void = () => {};
      const get = vi.fn(() => new Promise<Blob | null>((resolve) => { found = resolve; }));
      const { engine } = setup({ thumbs: { get, put: async () => {} } });
      engine.setCompile(compileOf('1'));
      expect(get, 'no thumbnail was looked up').toHaveBeenCalled();
      engine.setBoards([]);
      found(new Blob(['jpeg']));
      await flush();
      expectNoneLeft(engine);
    });
  });
});
