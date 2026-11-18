// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import type { EngineCallbacks } from '@/lib/canvas/engine';
import type { ArtboardBox, Tier } from '@/lib/canvas/types';
import type { ProjectRuntime } from '@/lib/vfs/types';
import type { FocusContextPayload, PlacementResult, PreviewHostMessage } from '@/lib/preview/types';
import type { StructureOp } from '@/lib/direct-edit/apply-structure';
import type { PreviewSelection, StyleChange } from '@/lib/direct-edit/types';
import type { ElementAction } from '../element-menu';
import type { NodeDocument } from '@/components/styles-content';
import en from '@/messages/en.json';

/**
 * The panel against a stand-in engine: the engine's frames run the project's own scripts, so what
 * they post reaches the panel through `onFrameMessage` as data anyone could have written. The
 * stand-in records what the panel asks of it and answers `ask` with what a test gives it.
 */

type Message = { type: string; [key: string]: unknown };
type Answer = Record<string, unknown> | null;
interface StandIn {
  callbacks: EngineCallbacks;
  boards: Map<string, ArtboardBox>;
  posted: { board: string; message: Record<string, unknown> }[];
  views: number;
  answer: (board: string, message: Record<string, unknown>) => Answer | Promise<Answer>;
  /** Each artboard's tier; 'none' when unset. */
  tiers: Map<string, Tier>;
  /** Artboards with no frame on show: posts to them go nowhere. */
  frameless: Set<string>;
  release: () => void;
}

const made = vi.hoisted(() => ({ engines: [] as unknown[] }));
vi.mock('@/lib/canvas/engine', () => ({
  CanvasEngine: class {
    callbacks: EngineCallbacks;
    boards = new Map<string, ArtboardBox>();
    posted: { board: string; message: Record<string, unknown> }[] = [];
    views = 0;
    answer: (board: string, message: Record<string, unknown>) => unknown = () => null;
    tiers = new Map<string, Tier>();
    frameless = new Set<string>();
    constructor(opts: { callbacks?: EngineCallbacks }) { this.callbacks = opts.callbacks ?? {}; made.engines.push(this); }
    destroy() {}
    setCompile() {}
    setBoards(boxes: ArtboardBox[]) { this.boards = new Map(boxes.map((b) => [b.id, { ...b }])); }
    attachSlot() {}
    setView() { this.views++; }
    setFocus() {}
    setAwake() {}
    setActive() {}
    setInteractive() {}
    touch() {}
    post(board: string, message: Record<string, unknown>) {
      if (this.frameless.has(board)) return false;
      this.posted.push({ board, message });
      return true;
    }
    ask(board: string, message: Record<string, unknown>) { return Promise.resolve(this.answer(board, message)); }
    overridesPreview() {}
    broadcast() {}
    focusFrame() {}
    hold() {}
    release() {}
    board(id: string) { return this.boards.get(id); }
    tierOf(id: string) { return this.tiers.get(id) ?? 'none'; }
    isBooting() { return false; }
    drawnByScript() { return false; }
  },
}));

const fixture = vi.hoisted(() => ({
  project: {
    pages: [{ file: '/index.html', title: 'Home' }],
    routes: [],
    compile: { blobUrls: new Map<string, string>(), pages: new Map([['/index.html', { html: '', signature: 's' }]]), deps: new Map() },
  },
  store: { isProjectGenerating: () => false, debugEvents: [], revealPanel: () => {} },
  hero: { id: 'hero', name: 'Hero Section', wireframeHtml: '<div>Hero</div>' },
}));
vi.mock('../use-canvas-compile', () => ({
  useCanvasCompile: () => ({ project: fixture.project, error: null, compiling: false }),
  pageForPath: () => null,
}));
vi.mock('@/lib/canvas/thumbs', () => ({ canvasThumbs: () => ({ get: async () => null, put: async () => {} }) }));
vi.mock('@/lib/stores/workspace', () => ({
  useWorkspaceStore: Object.assign((select: (s: typeof fixture.store) => unknown) => select(fixture.store), { getState: () => fixture.store }),
}));
vi.mock('@/components/semantic-blocks/palette-panel', () => ({
  PalettePanel: ({ onDragStart }: { onDragStart: (block: typeof fixture.hero) => void }) => (
    <div data-palette="" draggable onDragStart={() => onDragStart(fixture.hero)} />
  ),
}));

import { CanvasPanel, type CanvasPanelHandle } from '../canvas-panel';

const DESKTOP = '/index.html@desktop';
const PHONE = '/index.html@phone';

let container: HTMLDivElement;
let root: Root;
let frameQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  made.engines.length = 0;
  frameQueue = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // Animation frames run when a test steps them.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frameQueue.push(cb); return frameQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // A surface 300 px wide: narrower than any artboard zoomed in.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  // jsdom has no pointer capture.
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => {}, releasePointerCapture: () => {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  delete proto.hasPointerCapture;
  delete proto.setPointerCapture;
  delete proto.releasePointerCapture;
});

function mount(extra: { canStyle?: boolean; canPasteStyle?: boolean; runtime?: ProjectRuntime } = {}) {
  const handle = createRef<CanvasPanelHandle>();
  const props = {
    onTextEdited: vi.fn<(text: string) => void>(),
    onStructure: vi.fn<(op: StructureOp, opts?: { instances?: number }) => void>(),
    onPlacementComplete: vi.fn<(payload: PlacementResult, page: string) => void>(),
    onHandleDrag: vi.fn<(phase: 'start' | 'move' | 'end', changes: StyleChange[]) => void>(),
    onFocusSelection: vi.fn<(payload: FocusContextPayload | null) => void>(),
    onElementAction: vi.fn<(action: ElementAction, target?: PreviewSelection) => void>(),
    onStyleCommand: vi.fn<(command: 'toggle-hide' | 'clear-scope', nodeId: string, where: NodeDocument) => void>(),
    onStyleClip: vi.fn<(action: 'copy-style' | 'paste-style', element: FocusContextPayload) => void>(),
    onInspectedBoardChange: vi.fn<() => void>(),
  };
  act(() => root.render(withMessages(
    <CanvasPanel ref={handle} projectId="p1" runtime="static" onClose={() => {}} onScreen
      onToolbarAction={() => {}} onToolbarHover={() => {}} onInspectorMessage={() => {}} onFrameReady={() => {}}
      {...props} {...extra} />,
  )));
  const engine = made.engines.at(-1) as StandIn;
  expect(engine, 'the panel made no engine').toBeDefined();
  const surface = container.querySelector<HTMLElement>('[data-canvas-surface]')!;
  return { engine, props, handle, surface };
}

const fromFrame = (engine: StandIn, board: string, data: Message) => act(() => engine.callbacks.onFrameMessage?.(board, data));
const step = (frames: number) => {
  for (let i = 0; i < frames; i++) act(() => { const due = frameQueue; frameQueue = []; for (const cb of due) cb(0); });
};

/** Where a point of an artboard is on screen, from the world's transform (the surface sits at 0, 0). */
function clientPoint(engine: StandIn, board: string, x: number, y: number) {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec((container.querySelector<HTMLElement>('[data-canvas-surface] > div')!).style.transform);
  expect(m, 'the world has no transform').not.toBeNull();
  const [px, py, z] = m!.slice(1).map(Number);
  const b = engine.boards.get(board)!;
  return { clientX: (b.x + x) * z + px, clientY: (b.y + y) * z + py };
}

function key(surface: HTMLElement, init: KeyboardEventInit) {
  act(() => { surface.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });
}

/** Select the element `item` describes on the desktop artboard, as a pick in the Inspector's tree does. */
async function selectOnDesktop(engine: StandIn, handle: React.RefObject<CanvasPanelHandle | null>) {
  // Any message for the inspected artboard makes the page's first artboard the one it reads.
  act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n1' } as PreviewHostMessage));
  await act(async () => {
    engine.callbacks.onFrameMessage?.(DESKTOP, { type: 'selector-selection', payload: { nodeId: 'n1', tagName: 'h1' } as FocusContextPayload });
  });
}

const ITEM = { nodeId: 'n1', parentId: null, src: '/index.html:70', index: 0, rect: { x: 0, y: 0, w: 200, h: 40 }, height: 40, tag: 'h1', cls: [], leafText: true };
/** Another element on the same page, lower down. */
const ITEM2 = { ...ITEM, nodeId: 'n9', src: '/index.html:90', rect: { x: 0, y: 300, w: 200, h: 40 } };
/** An element inside `ITEM`. */
const CHILD = { ...ITEM, nodeId: 'n2', parentId: 'n1', src: '/index.html:75', rect: { x: 10, y: 5, w: 100, h: 20 }, tag: 'span' };
/** What the desktop artboard's frame says about `ITEM` once it is selected there. */
const H1 = {
  nodeId: 'n1', tagName: 'h1', domPath: 'body > h1', srcAttr: '/index.html:70', instanceCount: 2,
  attributes: { 'data-osw-id': 'm1' }, outerHTML: '<h1></h1>', page: '/index.html', viewportWidth: 1440,
} as FocusContextPayload;
/** `ITEM` as the write path names it. */
const H1_TARGET = { srcAttr: '/index.html:70', instanceCount: 2, tagName: 'h1', attributes: { 'data-osw-id': 'm1' } };

const rightClick = (surface: HTMLElement, at: { clientX: number; clientY: number }) => act(async () => {
  surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...at }));
});
/** The open element menu's item whose label starts with `label`. */
function menuItem(label: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[data-osw-element-menu] [role="menuitem"]')).find((el) => el.textContent?.startsWith(label));
  expect(item, `no ${label} in the element menu`).toBeTruthy();
  return item!;
}
const choose = (item: HTMLElement) => act(() => { item.click(); });

const click = (surface: HTMLElement, at: { clientX: number; clientY: number }) => act(async () => {
  surface.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...at }));
  surface.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, ...at }));
});

describe('text typed in place', () => {
  it('takes no text from an artboard where none is being typed', () => {
    const { engine, props } = mount();
    fromFrame(engine, DESKTOP, { type: 'canvas:text-done', nodeId: 'n1', text: 'Written by a page script', changed: true });
    expect(props.onTextEdited).not.toHaveBeenCalled();
  });

  it('takes the text typed into the element it started editing, and nothing else', async () => {
    const { engine, props, handle } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : null);
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n1' } as PreviewHostMessage));
    await act(async () => { handle.current!.editTextAt('/index.html:70'); });
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'canvas:edit-text', nodeId: 'n1' } });

    fromFrame(engine, DESKTOP, { type: 'canvas:text-done', nodeId: 'n2', text: 'Another element', changed: true });
    fromFrame(engine, PHONE, { type: 'canvas:text-done', nodeId: 'n1', text: 'Another artboard', changed: true });
    expect(props.onTextEdited).not.toHaveBeenCalled();
    fromFrame(engine, DESKTOP, { type: 'canvas:text-done', nodeId: 'n1', text: 'Typed', changed: true });
    expect(props.onTextEdited).toHaveBeenCalledTimes(1);
    expect(props.onTextEdited).toHaveBeenCalledWith('Typed');
  });

  it('takes no text from an edit that ended without a change, as Escape ends one', async () => {
    const { engine, props, handle } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : null);
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n1' } as PreviewHostMessage));
    await act(async () => { handle.current!.editTextAt('/index.html:70'); });
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'canvas:edit-text', nodeId: 'n1' } });
    // The bridge reports what was typed before Escape put the text back.
    fromFrame(engine, DESKTOP, { type: 'canvas:text-done', nodeId: 'n1', text: 'Typed, then abandoned', changed: false, cancelled: true });
    expect(props.onTextEdited).not.toHaveBeenCalled();
  });

  it('ends when the width it is typed on is turned off, letting go of the page, and the canvas takes clicks again', async () => {
    const { engine, handle, surface } = mount();
    const release = vi.spyOn(engine, 'release');
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n1' } as PreviewHostMessage));
    await act(async () => { handle.current!.editTextAt('/index.html:70'); });
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'canvas:edit-text', nodeId: 'n1' } });
    expect(release).not.toHaveBeenCalled();
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${en.canvas.widths.desktop}"]`)!.click(); });
    expect(engine.boards.has(DESKTOP), 'the desktop width is still on').toBe(false);
    expect(release).toHaveBeenCalled();
    await click(surface, clientPoint(engine, PHONE, 100, 100));
    expect(engine.posted).toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
  });

  it('ends when the page it is typed on is removed, letting go of the page, and the canvas takes clicks again', async () => {
    const ABOUT = '/about.html@desktop';
    const original = fixture.project;
    fixture.project = {
      ...original,
      pages: [...original.pages, { file: '/about.html', title: 'About' }],
      compile: { ...original.compile, pages: new Map([...original.compile.pages, ['/about.html', { html: '', signature: 'a' }]]) },
    };
    try {
      const { engine, handle, surface } = mount();
      const release = vi.spyOn(engine, 'release');
      engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
      // Picked on the About page, and typed into there.
      await click(surface, clientPoint(engine, ABOUT, 100, 100));
      expect(engine.posted).toContainEqual({ board: ABOUT, message: { type: 'tree-select', nodeId: 'n1' } });
      await act(async () => { handle.current!.editTextAt('/index.html:70'); });
      expect(engine.posted).toContainEqual({ board: ABOUT, message: { type: 'canvas:edit-text', nodeId: 'n1' } });
      expect(release).not.toHaveBeenCalled();
      // The page is deleted: the next compile has no About.
      fixture.project = original;
      act(() => engine.callbacks.onChange?.());
      step(1);
      expect(engine.boards.has(ABOUT), 'the About page is still laid out').toBe(false);
      expect(release).toHaveBeenCalled();
      await click(surface, clientPoint(engine, DESKTOP, 100, 100));
      expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n1' } });
    } finally {
      fixture.project = original;
    }
  });
});

describe('the dropper', () => {
  async function insertWith(place: unknown) {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:drop-at'
      ? { drop: { place, line: { x: 0, y: 0, w: 100, h: 3 }, box: { x: 0, y: 0, w: 100, h: 100 }, locked: false, parentName: 'main', instances: 1 } }
      : null);
    key(surface, { key: 't' });
    const at = clientPoint(engine, DESKTOP, 100, 100);
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...at }));
      surface.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, ...at }));
    });
    return props.onStructure;
  }

  it('inserts at a place the frame reports', async () => {
    const onStructure = await insertWith({ before: '/index.html:70' });
    expect(onStructure).toHaveBeenCalledWith({ kind: 'insert', place: { before: '/index.html:70' }, element: 'text', text: en.canvas.insert.textPlaceholder }, { instances: 1 });
  });

  it.each([
    ['a place whose source is not a string', { before: 42 }],
    ['a bare string', '/index.html:70'],
    ['a parent with no end to put it at', { parent: '/index.html:10', at: 'middle' }],
    ['an empty object', {}],
  ])('inserts nothing at %s', async (_name, place) => {
    const onStructure = await insertWith(place);
    expect(onStructure).not.toHaveBeenCalled();
  });
});

describe('a selection moving to another width', () => {
  it('centres the artboard it waits on once, not again on every frame while it waits', async () => {
    const { engine, handle, surface } = mount();
    // Zoomed in until the phone artboard is wider than the surface: centring never gets it all on screen.
    for (let i = 0; i < 20; i++) key(surface, { key: '=', ctrlKey: true });
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : null);
    await selectOnDesktop(engine, handle);
    const before = engine.views;
    act(() => handle.current!.moveToScope(768, [768]));
    const centred = engine.views;
    expect(centred, 'the artboard was not centred').toBeGreaterThan(before);
    step(10);
    expect(engine.views).toBe(centred);
  });

  it('is given up when another element is selected before the artboard is ready', async () => {
    const { engine, handle, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : m.type === 'canvas:pick' ? { chain: [ITEM2] } : null);
    await selectOnDesktop(engine, handle);
    act(() => handle.current!.moveToScope(768, [768]));
    await click(surface, clientPoint(engine, DESKTOP, 100, 320));
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n9' } });
    const before = engine.posted.length;
    // Later, the phone artboard loads a frame.
    await act(async () => { engine.callbacks.onFrameReady?.(PHONE); });
    expect(engine.posted.slice(before)).not.toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
  });

  it('is given up when another element is selected while the artboard is asked for the element', async () => {
    const { engine, handle, surface } = mount();
    // The phone artboard is live already: the move asks it for the element at once.
    engine.tiers.set(PHONE, 'live');
    let answerPhone: (reply: Answer) => void = () => {};
    engine.answer = (board, m) => (m.type === 'canvas:describe' && board === PHONE ? new Promise<Answer>((resolve) => { answerPhone = resolve; })
      : m.type === 'canvas:describe' ? { item: ITEM } : m.type === 'canvas:pick' ? { chain: [ITEM2] } : null);
    await selectOnDesktop(engine, handle);
    act(() => handle.current!.moveToScope(768, [768]));
    await click(surface, clientPoint(engine, DESKTOP, 100, 320));
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n9' } });
    await act(async () => { answerPhone({ item: ITEM }); });
    expect(engine.posted).not.toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
  });

  it('is given up when the Inspector\'s tree selects another element before the artboard is ready', async () => {
    const { engine, handle } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: m.nodeId === 'n9' ? ITEM2 : ITEM } : null);
    await selectOnDesktop(engine, handle);
    act(() => handle.current!.moveToScope(768, [768]));
    // A row of the tree picked: the frame selects it and says so.
    await act(async () => {
      engine.callbacks.onFrameMessage?.(DESKTOP, { type: 'selector-selection', payload: { nodeId: 'n9', tagName: 'h1' } as FocusContextPayload });
    });
    const before = engine.posted.length;
    await act(async () => { engine.callbacks.onFrameReady?.(PHONE); });
    expect(engine.posted.slice(before)).not.toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
  });

  it('is given up when the selection is let go before the artboard is ready', async () => {
    const { engine, handle } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : null);
    await selectOnDesktop(engine, handle);
    act(() => handle.current!.moveToScope(768, [768]));
    act(() => handle.current!.sendToFrame({ type: 'selection-clear' } as PreviewHostMessage));
    const before = engine.posted.length;
    await act(async () => { engine.callbacks.onFrameReady?.(PHONE); });
    expect(engine.posted.slice(before)).not.toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
  });
});

describe('a width turned off', () => {
  it('lets go of the selection on it, and the Inspector reads an artboard still there', async () => {
    const { engine, handle, props } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : null);
    await selectOnDesktop(engine, handle);
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${en.canvas.widths.desktop}"]`)!.click(); });
    expect(engine.boards.has(DESKTOP), 'the desktop width is still on').toBe(false);
    expect(props.onFocusSelection).toHaveBeenLastCalledWith(null);
    const before = engine.posted.length;
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n5' } as PreviewHostMessage));
    expect(engine.posted.slice(before)).toEqual([{ board: PHONE, message: { type: 'tree-select', nodeId: 'n5' } }]);
  });
});

describe('the space key', () => {
  it('stops panning when the surface loses the keyboard while it is held', async () => {
    const { engine, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    surface.focus();
    key(surface, { key: ' ' });
    // The key is let go somewhere else.
    act(() => { surface.blur(); document.body.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' })); });
    await click(surface, clientPoint(engine, DESKTOP, 100, 100));
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n1' } });
  });
});

describe('the element menu', () => {
  it('does not open again by itself after the selection was let go elsewhere', async () => {
    const { engine, handle, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    const at = clientPoint(engine, DESKTOP, 100, 100);
    const open = () => document.querySelector('[data-osw-element-menu]') !== null;
    await act(async () => { surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...at })); });
    expect(open(), 'the menu did not open').toBe(true);
    act(() => handle.current!.sendToFrame({ type: 'selection-clear' } as PreviewHostMessage));
    // The selection going takes the menu on it with it, before anything else is clicked.
    expect(open()).toBe(false);
    await click(surface, at);
    expect(open()).toBe(false);
  });

  it('selects again the element it opens on, inside the selection too, so the Inspector reads that element', async () => {
    const { engine, handle, surface } = mount();
    // The span inside the heading is selected; a click with nothing selected would take the heading.
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: CHILD } : m.type === 'canvas:pick' ? { chain: [ITEM, CHILD] } : null);
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n2' } as PreviewHostMessage));
    await act(async () => {
      engine.callbacks.onFrameMessage?.(DESKTOP, { type: 'selector-selection', payload: { nodeId: 'n2', tagName: 'span' } as FocusContextPayload });
    });
    const before = engine.posted.length;
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    expect(document.querySelector('[data-osw-element-menu]')?.textContent).toContain('span');
    expect(engine.posted.slice(before)).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n2' } });
    expect(engine.posted.slice(before)).not.toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n1' } });
  });

  it('hides and clears the element it was opened on, named with its artboard\'s page and width', async () => {
    const { engine, props, surface } = mount({ canStyle: true });
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    // The phone artboard, which is not the page's first: the width named is the one the menu is on.
    const phone = { page: '/index.html', viewportWidth: engine.boards.get(PHONE)!.w };
    expect(phone.viewportWidth).not.toBe(engine.boards.get(DESKTOP)!.w);
    await rightClick(surface, clientPoint(engine, PHONE, 100, 10));
    fromFrame(engine, PHONE, { type: 'selector-selection', payload: { ...H1, viewportWidth: phone.viewportWidth } });
    choose(menuItem(en.canvas.menu.hideAll));
    expect(props.onStyleCommand).toHaveBeenCalledWith('toggle-hide', 'n1', phone);

    await rightClick(surface, clientPoint(engine, PHONE, 100, 10));
    choose(menuItem(en.canvas.menu.clearAll));
    expect(props.onStyleCommand).toHaveBeenLastCalledWith('clear-scope', 'n1', phone);
    expect(props.onElementAction).not.toHaveBeenCalled();
  });

  it.each([
    ['takes no structural edit for a locked element', true],
    ['offers the structural edits for an element with no lock', false],
  ])('%s', async (_name, locked) => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: { ...H1, locked, frame: true } });
    const m = en.canvas.menu;
    for (const label of [m.moveUp, m.moveDown, m.wrap, m.unwrap, m.duplicate, m.delete]) {
      expect(menuItem(label).hasAttribute('data-disabled'), label).toBe(locked);
    }
    if (locked) {
      choose(menuItem(m.delete));
      expect(props.onElementAction).not.toHaveBeenCalled();
    }
  });

  it('moves the element it was opened on, named by that element\'s own source', async () => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: H1 });
    choose(menuItem(en.canvas.menu.moveUp));
    expect(props.onElementAction).toHaveBeenCalledWith('move-up', H1_TARGET);
  });

  it('acts on nothing before the frame has said where the element comes from, never on the last element\'s source', async () => {
    const { engine, props, surface } = mount();
    let chain = [ITEM2];
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain } : null);
    await click(surface, clientPoint(engine, DESKTOP, 100, 320));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: { ...H1, nodeId: 'n9', srcAttr: '/index.html:90' } });
    chain = [ITEM];
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    choose(menuItem(en.canvas.menu.delete));
    expect(props.onElementAction).not.toHaveBeenCalled();
  });
});

describe('the structure keys', () => {
  it('act on Canvas\'s own selection, named by its source', async () => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await click(surface, clientPoint(engine, DESKTOP, 100, 10));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: H1 });
    surface.focus();
    key(surface, { key: 'Backspace' });
    key(surface, { key: 'ArrowDown', altKey: true });
    key(surface, { code: 'KeyD', key: 'd', ctrlKey: true });
    expect(props.onElementAction.mock.calls).toEqual([['delete', H1_TARGET], ['move-down', H1_TARGET], ['duplicate', H1_TARGET]]);
  });
});

describe('Copy style and Paste style', () => {
  it('copy from and paste onto the element the menu was opened on, as its frame described it', async () => {
    const { engine, props, surface } = mount({ canStyle: true, canPasteStyle: true });
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: H1 });
    choose(menuItem(en.canvas.menu.copyStyle));
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    choose(menuItem(en.canvas.menu.pasteStyle));
    expect(props.onStyleClip.mock.calls).toEqual([['copy-style', H1], ['paste-style', H1]]);
    expect(props.onElementAction).not.toHaveBeenCalled();
  });

  it('copy from and paste onto Canvas\'s own selection from the keys', async () => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await click(surface, clientPoint(engine, DESKTOP, 100, 10));
    fromFrame(engine, DESKTOP, { type: 'selector-selection', payload: H1 });
    surface.focus();
    key(surface, { code: 'KeyC', key: 'ç', ctrlKey: true, altKey: true });
    key(surface, { code: 'KeyV', key: '√', ctrlKey: true, altKey: true });
    expect(props.onStyleClip.mock.calls).toEqual([['copy-style', H1], ['paste-style', H1]]);
    expect(props.onElementAction).not.toHaveBeenCalled();
  });

  it('paste onto nothing before the frame has said which element it is', async () => {
    const { engine, props, surface } = mount({ canStyle: true, canPasteStyle: true });
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await rightClick(surface, clientPoint(engine, DESKTOP, 100, 10));
    choose(menuItem(en.canvas.menu.pasteStyle));
    expect(props.onStyleClip).not.toHaveBeenCalled();
    expect(props.onElementAction).not.toHaveBeenCalled();
  });
});

describe('the artboard the Inspector reads', () => {
  it('is reported when a pick moves it to another artboard, and not for a pick on the same one', async () => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await click(surface, clientPoint(engine, DESKTOP, 100, 10));
    await click(surface, clientPoint(engine, DESKTOP, 100, 30));
    expect(props.onInspectedBoardChange).not.toHaveBeenCalled();
    await click(surface, clientPoint(engine, PHONE, 100, 10));
    expect(engine.posted).toContainEqual({ board: PHONE, message: { type: 'tree-select', nodeId: 'n1' } });
    expect(props.onInspectedBoardChange).toHaveBeenCalledTimes(1);
  });

  it('is reported when the artboard it reads is turned off', async () => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    await click(surface, clientPoint(engine, DESKTOP, 100, 10));
    await act(async () => { container.querySelector<HTMLButtonElement>(`button[aria-label="${en.canvas.widths.desktop}"]`)!.click(); });
    expect(engine.boards.has(DESKTOP), 'the desktop width is still on').toBe(false);
    expect(props.onInspectedBoardChange).toHaveBeenCalledTimes(1);
  });
});

describe('the outline of the selection on the page\'s other widths', () => {
  it('is not drawn on an artboard with no frame to say where the new selection is', async () => {
    const { engine, handle, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: ITEM } : m.type === 'canvas:pick' ? { chain: [ITEM2] } : null);
    await selectOnDesktop(engine, handle);
    act(() => engine.callbacks.onRects?.(PHONE, [{ x: 10, y: 10, w: 300, h: 30 }], null));
    // A twin's outline is the dashed one with an offset; the dropper's has none.
    const twins = () => [...container.querySelectorAll<HTMLElement>('[data-canvas-surface] div')]
      .filter((d) => { const style = d.getAttribute('style') ?? ''; return style.includes('dashed') && style.includes('outline-offset'); }).length;
    expect(twins(), 'no outline on the phone artboard').toBe(1);
    // Zoomed out, the phone artboard drops its frame: it hears nothing about the next selection.
    engine.frameless.add(PHONE);
    await click(surface, clientPoint(engine, DESKTOP, 100, 320));
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n9' } });
    expect(twins()).toBe(0);
  });
});

describe('a pinch over a live page', () => {
  it('zooms around the pointer, as over the canvas', () => {
    const { engine } = mount();
    // The phone artboard sits right of the desktop one, so its pixels are offset from the canvas's.
    expect(engine.boards.get(PHONE)!.x).toBeGreaterThan(0);
    const before = clientPoint(engine, PHONE, 200, 300);
    // The page reports the pointer in its own pixels.
    act(() => engine.callbacks.onWheel?.(PHONE, { dx: 0, dy: -100, deltaMode: 0, zoom: true, x: 200, y: 300 }));
    const after = clientPoint(engine, PHONE, 200, 300);
    expect(after.clientX).toBeCloseTo(before.clientX, 6);
    expect(after.clientY).toBeCloseTo(before.clientY, 6);
  });
});

describe('a view-only runtime', () => {
  it('takes no insert tool from the keyboard', () => {
    // Where pages can be edited, the same key takes the tool, and the crosshair shows it.
    const edit = mount().surface;
    key(edit, { key: 't' });
    expect(edit.classList.contains('cursor-crosshair'), 'an insert tool shows no crosshair').toBe(true);
    key(edit, { key: 'v' });

    const { surface } = mount({ runtime: 'react' });
    for (const letter of ['f', 't', 'i', 'b', 'd']) {
      key(surface, { key: letter });
      expect(surface.classList.contains('cursor-crosshair'), `${letter} chose an insert tool`).toBe(false);
    }
  });
});

describe('answers from an artboard\'s frame', () => {
  // The frame runs the page's scripts, which can answer the panel's questions with anything.
  const DROP = { place: { before: '/index.html:70' }, line: { x: 0, y: 0, w: 100, h: 3 }, box: { x: 0, y: 0, w: 100, h: 100 }, locked: false, parentName: 'main', instances: 1 };

  it.each([
    ['no box', { ...DROP, box: null }],
    ['no line', { ...DROP, line: undefined }],
    ['a count that is not a number', { ...DROP, instances: 'many' }],
  ])('draw and insert nothing for a dropper answer with %s', async (_name, drop) => {
    const { engine, props, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:drop-at' ? { drop } : null);
    key(surface, { key: 't' });
    const at = clientPoint(engine, DESKTOP, 100, 100);
    await act(async () => { surface.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...at })); });
    await click(surface, at);
    expect(container.querySelector('[data-canvas-surface]')).not.toBeNull();
    expect(props.onStructure).not.toHaveBeenCalled();
  });

  it.each([
    ['no box', { ...ITEM, rect: null }],
    ['an id that is not a string', { ...ITEM, nodeId: 7 }],
    ['classes that are not words', { ...ITEM, cls: [42] }],
  ])('select nothing from a pick answer whose element has %s', async (_name, item) => {
    const { engine, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [item] } : null);
    const at = clientPoint(engine, DESKTOP, 100, 100);
    await act(async () => { surface.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...at })); });
    await click(surface, at);
    expect(container.querySelector('[data-canvas-surface]')).not.toBeNull();
    expect(engine.posted.filter((p) => p.message.type === 'tree-select')).toEqual([]);
  });

  it('draw no hover for a described element with no box', async () => {
    const { engine, handle } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: { ...ITEM, rect: null } } : null);
    act(() => handle.current!.sendToFrame({ type: 'tree-select', nodeId: 'n1' } as PreviewHostMessage));
    await act(async () => { handle.current!.sendToFrame({ type: 'tree-highlight', nodeId: 'n1' } as PreviewHostMessage); });
    expect(container.querySelector('[data-canvas-surface]')).not.toBeNull();
  });
});

describe('a drag on a selection handle', () => {
  const SECTION = { ...ITEM, rect: { x: 0, y: 0, w: 800, h: 400 }, tag: 'section', leafText: false };
  const METRICS = { pt: 8, pr: 8, pb: 8, pl: 8, rowGap: 0, columnGap: 0, parentRow: false, gap: null, tag: 'section' };

  /** Select a section on the desktop artboard and press its width handle. */
  async function grab() {
    const mounted = mount({ canStyle: true });
    const { engine, handle, props } = mounted;
    engine.answer = (_board, m) => (m.type === 'canvas:describe' ? { item: SECTION } : null);
    await selectOnDesktop(engine, handle);
    act(() => engine.callbacks.onRects?.(DESKTOP, [SECTION.rect], METRICS));
    const width = container.querySelector<HTMLElement>('[data-osw-handle="e"]');
    expect(width, 'the selection has no width handle').not.toBeNull();
    act(() => { width!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 })); });
    expect(props.onHandleDrag).toHaveBeenCalledWith('start', []);
    return mounted;
  }
  const pointer = (type: string, clientX = 0) => act(() => { window.dispatchEvent(new MouseEvent(type, { clientX, clientY: 100 })); });
  const phases = (onHandleDrag: ReturnType<typeof mount>['props']['onHandleDrag']) => onHandleDrag.mock.calls.map(([phase]) => phase);

  it('ends when the browser cancels the pointer, as on its release', async () => {
    const { props } = await grab();
    pointer('pointermove', 120);
    pointer('pointercancel');
    pointer('pointermove', 140);
    expect(phases(props.onHandleDrag)).toEqual(['start', 'move', 'end']);
  });

  it('runs no double-click on the page when pressed twice quickly; one on the page still goes deeper', async () => {
    const { engine, surface } = await grab();
    // The section holds a heading: a double-click on the page goes from the section to the heading.
    const heading = { nodeId: 'n2', parentId: 'n1', src: '/index.html:70', index: 0, rect: { x: 0, y: 0, w: 200, h: 40 }, tag: 'h1', cls: [], leafText: true, height: 40 };
    const asked: string[] = [];
    engine.answer = (_board, m) => {
      asked.push(String(m.type));
      return m.type === 'canvas:pick' ? { chain: [{ ...SECTION, height: 400 }, heading] } : null;
    };
    const fire = (target: Element, type: string, at: { clientX: number; clientY: number }, detail = 0) => act(async () => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, detail, ...at }));
    });
    const deeper = { board: DESKTOP, message: { type: 'tree-select', nodeId: 'n2' } };

    const onHandle = clientPoint(engine, DESKTOP, 800, 200);
    const width = () => container.querySelector<HTMLElement>('[data-osw-handle="e"]')!;
    await fire(width(), 'pointerup', onHandle);
    await fire(width(), 'click', onHandle, 1);
    await fire(width(), 'pointerdown', onHandle);
    await fire(width(), 'pointerup', onHandle);
    await fire(width(), 'click', onHandle, 2);
    expect(asked).not.toContain('canvas:pick');
    expect(engine.posted).not.toContainEqual(deeper);

    const onPage = clientPoint(engine, DESKTOP, 100, 100);
    for (const detail of [1, 2]) {
      await fire(surface, 'pointerdown', onPage);
      await fire(surface, 'pointerup', onPage);
      await fire(surface, 'click', onPage, detail);
    }
    expect(engine.posted).toContainEqual(deeper);
  });

  it('ends, and stops following the pointer, when the panel goes mid-drag', async () => {
    const { props } = await grab();
    act(() => root.unmount());
    pointer('pointermove', 140);
    pointer('pointerup');
    expect(phases(props.onHandleDrag)).toEqual(['start', 'end']);
  });
});

describe('a pan the browser cancels', () => {
  it('stops following the pointer, and the next press selects as usual', async () => {
    const { engine, surface } = mount();
    engine.answer = (_board, m) => (m.type === 'canvas:pick' ? { chain: [ITEM] } : null);
    const on = (type: string, at: { clientX: number; clientY: number }) => act(async () => {
      surface.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...at }));
    });
    const start = clientPoint(engine, DESKTOP, 100, 100);
    await on('pointerdown', start);
    const before = engine.views;
    await on('pointermove', { ...start, clientX: start.clientX + 40 });
    const panned = engine.views;
    expect(panned, 'the press did not pan').toBeGreaterThan(before);
    await on('pointercancel', { ...start, clientX: start.clientX + 40 });
    await on('pointermove', { ...start, clientX: start.clientX + 80 });
    expect(engine.views).toBe(panned);

    const at = clientPoint(engine, DESKTOP, 100, 100);
    await on('pointerdown', at);
    await on('pointerup', at);
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'tree-select', nodeId: 'n1' } });
  });
});

describe('a placement-complete from an artboard frame', () => {
  const placed = (blockId: string): PlacementResult => ({ blockId, place: { after: '/index.html:70' }, instances: 1, page: '/index.html' });

  /** Drag the hero block over the desktop artboard, live unless `tier` says otherwise. */
  function drag(engine: StandIn, surface: HTMLElement, tier: Tier = 'live') {
    engine.tiers.set(DESKTOP, tier);
    act(() => { container.querySelector<HTMLElement>(`button[aria-label="${en.canvas.tools.blocks}"]`)!.click(); });
    act(() => { container.querySelector('[data-palette]')!.dispatchEvent(new Event('dragstart', { bubbles: true })); });
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, ...clientPoint(engine, DESKTOP, 100, 100) });
    Object.defineProperty(over, 'dataTransfer', { value: { dropEffect: '' } });
    act(() => { surface.dispatchEvent(over); });
  }

  function drop(surface: HTMLElement) {
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } });
    act(() => { surface.dispatchEvent(event); });
  }

  it('is ignored when no drop is waiting for it', () => {
    const { engine, props } = mount();
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is ignored while a block is only being dragged, before it is dropped', () => {
    const { engine, props, surface } = mount();
    drag(engine, surface);
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'placement-start', block: fixture.hero } });
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is taken once, from the artboard the block was dropped on and for that block', () => {
    const { engine, props, surface } = mount();
    drag(engine, surface);
    drop(surface);
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'placement-drop' } });
    fromFrame(engine, PHONE, { type: 'placement-complete', payload: placed('hero') });
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('footer') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).toHaveBeenCalledTimes(1);
    expect(props.onPlacementComplete).toHaveBeenCalledWith(placed('hero'), '/index.html');
  });

  it('is ignored once the artboard has cancelled the drop', () => {
    const { engine, props, surface } = mount();
    drag(engine, surface);
    drop(surface);
    fromFrame(engine, DESKTOP, { type: 'placement-cancelled' });
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
  });

  it.each(['still', 'image'] as const)('is never waited for from a %s artboard, which places nothing', (tier) => {
    const { engine, props, surface } = mount();
    drag(engine, surface, tier);
    drop(surface);
    expect(engine.posted.filter((p) => String(p.message.type).startsWith('placement-'))).toEqual([]);
    // Later, live, the artboard's page posts one.
    engine.tiers.set(DESKTOP, 'live');
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is never waited for from an artboard that stopped being live before the drop', () => {
    const { engine, props, surface } = mount();
    drag(engine, surface);
    expect(engine.posted).toContainEqual({ board: DESKTOP, message: { type: 'placement-start', block: fixture.hero } });
    engine.tiers.set(DESKTOP, 'still');
    drop(surface);
    expect(engine.posted).not.toContainEqual({ board: DESKTOP, message: { type: 'placement-drop' } });
    engine.tiers.set(DESKTOP, 'live');
    fromFrame(engine, DESKTOP, { type: 'placement-complete', payload: placed('hero') });
    expect(props.onPlacementComplete).not.toHaveBeenCalled();
  });
});
