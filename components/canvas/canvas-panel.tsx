'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Frame, Hand, Image as ImageIcon, ImagePlus, LayoutGrid, MessageSquarePlus, Minus, Monitor, MousePointer2, Plus, RectangleHorizontal, Scan, SlidersHorizontal, Smartphone, SquareDashed, Tablet, Type, X } from 'lucide-react';
import { toast } from 'sonner';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { canvasSupport, getRuntimeConfig } from '@/lib/runtimes/registry';
import { getPreviewStorage } from '@/lib/preview/preview-storage';
import { elementKind } from '@/lib/preview/toolbar-dom';
import type { FocusContextPayload, PlacementBlockInfo, PlacementResult, PreviewHostMessage, PreviewMessage, StructurePlace, ToolbarAction } from '@/lib/preview/types';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { CanvasEngine, type SelectionMetrics } from '@/lib/canvas/engine';
import { canvasThumbs } from '@/lib/canvas/thumbs';
import { artboardAt, fitView, layoutArtboards } from '@/lib/canvas/layout';
import { OwnSelections, clickTarget, doubleClickTarget, isDoubleClick, type ChainItem } from '@/lib/canvas/selection';
import { CANVAS_DEVICE_ORDER, CANVAS_DEVICES, DEFAULT_BUDGET, artboardId, viewRectOf, type ArtboardBox, type CanvasDevice, type CanvasView } from '@/lib/canvas/types';
import { scopeOfWidth } from '@/lib/direct-edit/breakpoints';
import type { OverrideScope } from '@/lib/direct-edit/overrides-css';
import type { InsertKind, StructureOp } from '@/lib/direct-edit/apply-structure';
import type { PreviewSelection, StyleChange } from '@/lib/direct-edit/types';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import type { NodeDocument } from '@/components/styles-content';
import { toPreviewSelection } from '@/components/styles-content/commit';
import { modShortcut, shiftShortcut } from '@/lib/platform';
import { pageForPath, useCanvasCompile } from './use-canvas-compile';
import { ElementMenu, type ElementAction, type ElementMenuFacts } from './element-menu';
import { agentWrites, pagesWritten } from './agent-writing';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { PalettePanel } from '@/components/semantic-blocks/palette-panel';
import type { SemanticBlock } from '@/lib/semantic-blocks/types';
import { isPlace } from '@/lib/semantic-blocks/placement';

interface Rect { x: number; y: number; w: number; h: number }

/** One element under a pick, as the bridge describes it. */
interface PickItem extends ChainItem {
  rect: Rect;
  tag: string;
  cls: string[];
  src: string | null;
  index: number;
  leafText: boolean;
}

/** Where the dropper would put a new element, as the artboard's frame worked it out (`canvas:drop-at`). */
interface DropInfo {
  board: string;
  /** `null` where the spot lies between elements of other files. */
  place: StructurePlace | null;
  line: Rect;
  box: Rect;
  locked: boolean;
  parentName: string;
  /** How many times the parent renders: more than one is a loop. */
  instances: number;
}

// A frame's answers are read before they are used: the frame runs the page's scripts, which can
// answer the same questions with anything.

const isRect = (value: unknown): value is Rect =>
  typeof value === 'object' && value !== null && (['x', 'y', 'w', 'h'] as const).every((k) => Number.isFinite((value as Record<string, unknown>)[k]));

/** An element as the bridge describes it (`__cvItem`). */
function isPickItem(value: unknown): value is PickItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.nodeId === 'string' && (v.parentId === null || typeof v.parentId === 'string')
    && isRect(v.rect) && Number.isFinite(v.height) && typeof v.tag === 'string'
    && Array.isArray(v.cls) && v.cls.every((c) => typeof c === 'string')
    && (v.src === null || typeof v.src === 'string') && Number.isFinite(v.index) && typeof v.leafText === 'boolean';
}

/** Where the dropper would put an element, as the bridge works it out (`__cvDropAt`), its place unread. */
function isDrop(value: unknown): value is Omit<DropInfo, 'board'> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isRect(v.line) && isRect(v.box) && typeof v.locked === 'boolean' && typeof v.parentName === 'string' && Number.isFinite(v.instances);
}

type Tool = 'select' | 'interact' | InsertKind;
const INSERT_TOOLS: readonly InsertKind[] = ['frame', 'text', 'image', 'button', 'divider'];
const isInsertTool = (tool: Tool): tool is InsertKind => (INSERT_TOOLS as readonly string[]).includes(tool);

/** What is selected on Canvas: which artboard, which element there, and its twins' handle. */
interface CanvasSelection {
  board: string;
  nodeId: string;
  parentId: string | null;
  src: string | null;
  index: number;
  name: string;
}

/** What the Inspector talks to while Canvas made the last pick, in the shape of Live Preview's handle. */
export interface CanvasPanelHandle {
  sendToFrame: (message: PreviewHostMessage) => void;
  /** The page the inspected artboard shows. */
  getActivePath: () => string;
  /** The Inspector's `Select element`: clicks on artboards select again. */
  selectTool: () => void;
  /** Start typing the text of the element carrying this `data-osw-src`, in place, on the artboard the Inspector reads. */
  editTextAt: (src: string) => void;
  /**
   * The Styles tab's Applies to: select the same element on the page's artboard whose width is in
   * `scope`, turning that width on if it is off.
   */
  moveToScope: (scope: OverrideScope, breakpoints: readonly number[]) => void;
}

export interface CanvasPanelProps {
  projectId: string;
  /** The project's runtime, resolved: Canvas lays out pages, which terminal runtimes don't have. */
  runtime: ProjectRuntime;
  onClose: () => void;
  /** In front of its cell and not behind a maximized one. Off screen, Canvas holds nothing live. */
  onScreen: boolean;
  /** A selection made on Canvas, or null when it is let go. */
  onFocusSelection: (payload: FocusContextPayload | null) => void;
  onToolbarAction: (message: Extract<PreviewMessage, { type: 'toolbar-action' }>) => void;
  onToolbarHover: (message: Extract<PreviewMessage, { type: 'toolbar-hover' }>) => void;
  /** The Inspector's replies from the inspected artboard's frame. */
  onInspectorMessage: (message: PreviewMessage) => void;
  /** The inspected artboard's frame loaded a document: the Inspector's node ids are gone. */
  onFrameReady: () => void;
  /** The deployment a page's edge-function calls go to. */
  deploymentId?: string | null;
  /** The dropper's insert at a place; the workspace writes it. */
  onStructure?: (op: StructureOp, opts?: { instances?: number }) => void;
  /**
   * Keys and the element menu: an action for the workspace on the element it was invoked on, named
   * by that element's own source (`target`), never by the Inspector's selection, which can be
   * another element. Selecting the parent or a child, typing text and Add to next message are
   * Canvas's own; Hide and Clear go to `onStyleCommand`, Copy style and Paste style to `onStyleClip`.
   */
  onElementAction?: (action: ElementAction, target?: PreviewSelection) => void;
  /** Copy style and Paste style, on the element they were invoked on, as its frame described it. */
  onStyleClip?: (action: 'copy-style' | 'paste-style', element: FocusContextPayload) => void;
  /**
   * The element menu's Hide/Show and Clear, for the element it was opened on: its node id, and the
   * page and width of the artboard whose document gave it that id.
   */
  onStyleCommand?: (command: 'toggle-hide' | 'clear-scope', nodeId: string, where: NodeDocument) => void;
  /**
   * The Inspector reads another artboard now, or none: the node ids it holds are another
   * document's, numbered that document's own way.
   */
  onInspectedBoardChange?: () => void;
  /** A drag on a handle: one undo step from `start` to `end`, written through the Styles tab. */
  onHandleDrag?: (phase: 'start' | 'move' | 'end', changes: StyleChange[]) => void;
  /** Text typed in place on an artboard, for the selected element. */
  onTextEdited?: (text: string) => void;
  /** The element under the pointer on the artboard the Inspector reads, for its tree; `null` off one. */
  onHoverNode?: (nodeId: string | null) => void;
  /** The Styles tab is there to write through: handles and the menu's style entries need it. */
  canStyle?: boolean;
  /** Copy style has something for Paste. */
  canPasteStyle?: boolean;
  /** The project's breakpoints, for the width scope the menu's Hide and Clear name. */
  breakpoints?: readonly number[];
  /** A Semantic block placed on an artboard, with the page that artboard shows. */
  onPlacementComplete?: (payload: PlacementResult, page: string) => void;
}

/** Left to right, the widest first. */
const DEVICE_ORDER: readonly CanvasDevice[] = ['desktop', 'tablet', 'phone'];
const DEVICE_ICON = { phone: Smartphone, tablet: Tablet, desktop: Monitor } as const;
/** A toolbar toggle that is on: the tool in use, the open palette, a width shown. One look for all three. */
const TOGGLE_ON: React.CSSProperties = { backgroundColor: 'var(--button-canvas-active)', color: 'white' };
const MIN_Z = 0.02;
const MAX_Z = 2;
/** The preview's selection colour, so a selection reads the same on both surfaces. */
const SELECTION = 'rgba(99, 102, 241, 0.95)';
const SELECTION_SOLID = 'rgb(99, 102, 241)';
/** Refused: the dropper's line and tag when nothing can go there. */
const REFUSED = '#d97706';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const nameOf = (item: { tag: string; cls: string[] }) => item.tag + item.cls.map((c) => `.${c}`).join('');
const selectionOf = (board: string, item: PickItem): CanvasSelection =>
  ({ board, nodeId: item.nodeId, parentId: item.parentId, src: item.src, index: item.index, name: nameOf(item) });

export const CanvasPanel = forwardRef<CanvasPanelHandle, CanvasPanelProps>(function CanvasPanel(props, ref) {
  const { projectId, runtime, onClose, onScreen } = props;
  const t = useTranslations('canvas');
  const tw = useTranslations('workspace');
  const support = canvasSupport(runtime);
  const { project, error, compiling } = useCanvasCompile(projectId, runtime, support !== null, onScreen);

  // ---------- the agent outline: pages using a file the run is writing ----------
  const running = useWorkspaceStore((s) => s.isProjectGenerating(projectId));
  const events = useWorkspaceStore((s) => s.debugEvents);
  /** Moves on while something is outlined, so a write's hold runs out. */
  const [writingTick, setWritingTick] = useState(0);
  const agentPages = useMemo(
    () => (running && project ? pagesWritten(agentWrites(events, Date.now()), project.compile.pages, project.compile.deps) : new Set<string>()),
    // writingTick: recomputed as time passes, not only when events arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [running, project, events, writingTick],
  );
  useEffect(() => {
    if (agentPages.size === 0) return;
    const timer = setTimeout(() => setWritingTick((n) => n + 1), 500);
    return () => clearTimeout(timer);
  }, [agentPages, writingTick]);

  // Callbacks from the workspace, read through a ref so the engine's handlers never go stale.
  const cb = useRef(props);
  cb.current = props;

  const [tool, setTool] = useState<Tool>('select');
  /** The selection's padding and gap, for its handles (`canvas:rects`). */
  const [metrics, setMetrics] = useState<SelectionMetrics | null>(null);
  const [drop, setDrop] = useState<DropInfo | null>(null);
  /** The element menu: where it is open, and the element it was opened on. */
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; on: CanvasSelection } | null>(null);
  /** The element whose text is being typed in place. */
  const [editing, setEditing] = useState<{ board: string; nodeId: string } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** The handle under the pointer or being dragged: its padding or gap shows. */
  const [handleOn, setHandleOn] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The Semantic blocks palette, open beside the canvas. */
  const [blocksOpen, setBlocksOpen] = useState(false);
  /** A block being dragged from it (state: the palette folds away), and the artboard placing it. */
  const [draggingBlock, setDraggingBlock] = useState<PlacementBlockInfo | null>(null);
  /** The same, from the moment the drag starts: the first drag-over can come before the state does. */
  const draggingRef = useRef<PlacementBlockInfo | null>(null);
  const placeBoardRef = useRef<string | null>(null);
  /** A block dropped on an artboard, whose `placement-complete` is the only one taken. */
  const pendingDrop = useRef<{ board: string; blockId: string } | null>(null);
  const [devices, setDevices] = useState<CanvasDevice[]>(['desktop', 'phone']);
  const [page, setPage] = useState<string | null>(null);
  const [sel, setSel] = useState<CanvasSelection | null>(null);
  /**
   * The selection's payload, as the frame built it, and the artboard whose frame built it: what the
   * toolbar's middle slot is decided from, and how an action names the element to the write path.
   */
  const [picked, setPicked] = useState<{ board: string; payload: FocusContextPayload } | null>(null);
  const payload = picked?.payload ?? null;
  /** The frame's payload for this element, once it has come. */
  const payloadFor = (on: CanvasSelection): FocusContextPayload | null =>
    picked && picked.board === on.board && picked.payload.nodeId === on.nodeId ? picked.payload : null;
  const selRef = useRef<CanvasSelection | null>(null);
  selRef.current = sel;
  /** The selection, mirrored into `selRef` at once: a pick that answers before the next render reads it. */
  const setSelection = useCallback((next: CanvasSelection | null) => {
    selRef.current = next;
    setSel(next);
  }, []);
  /** Selections Canvas made, so the frame's late confirmation of an older one is not taken again. */
  const ownSelections = useRef(new OwnSelections());
  const [hover, setHover] = useState<{ board: string; rect: Rect; name: string } | null>(null);
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const [, setTick] = useState(0);
  const tickPending = useRef(false);
  const redraw = useCallback(() => {
    if (tickPending.current) return;
    tickPending.current = true;
    requestAnimationFrame(() => { tickPending.current = false; setTick((n) => n + 1); });
  }, []);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<CanvasView>({ z: 0.3, px: 36, py: 66 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const fittedRef = useRef(false);
  /** The artboard the Inspector reads: the last one picked on, else the first of the page in view. */
  const inspectRef = useRef<string | null>(null);
  /** The Inspector reads `boardId` now; it is told when that is not the artboard it read before. */
  const inspect = useCallback((boardId: string | null) => {
    const was = inspectRef.current;
    inspectRef.current = boardId;
    if (was !== null && was !== boardId) cb.current.onInspectedBoardChange?.();
  }, []);
  /** Each artboard's frame slot, for an engine made after they mounted. */
  const slotEls = useRef(new Map<string, HTMLDivElement>());
  /** What the engine calls back into, current as of the last render. */
  const handlers = useRef<{
    watchBoard: (board: string) => void;
    onFrameMessage: (board: string, data: { type: string; [key: string]: unknown }) => void;
    wheel: (dx: number, dy: number, deltaMode: number, zoom: boolean, x: number, y: number) => void;
    finishMove: (board: string) => void;
  }>({ watchBoard: () => {}, onFrameMessage: () => {}, wheel: () => {}, finishMove: () => {} });

  // ---------- the engine ----------
  const engineRef = useRef<CanvasEngine | null>(null);
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  useEffect(() => {
    if (support === null) return;
    const e = new CanvasEngine({
      storage: () => getPreviewStorage(projectId),
      thumbs: canvasThumbs(projectId),
      deploymentId: () => cb.current.deploymentId,
      callbacks: {
        onChange: redraw,
        onRects: (board, list, m) => {
          if (board === selRef.current?.board) {
            setMetrics((prev) => (JSON.stringify(prev) === JSON.stringify(m) ? prev : m));
          }
          setRects((prev) => {
            const next = list[0] ?? null;
            const was = prev[board];
            if (was && next && was.x === next.x && was.y === next.y && was.w === next.w && was.h === next.h) return prev;
            return { ...prev, [board]: next };
          });
        },
        onFrameReady: (board) => {
          // A new document has no edit in it: the element went with the old one.
          if (editingRef.current?.board === board) { editingRef.current = null; setEditing(null); engineRef.current?.release(); }
          handlers.current.watchBoard(board);
          handlers.current.finishMove(board);
          if (board === inspectRef.current) cb.current.onFrameReady();
        },
        onFrameMessage: (board, data) => handlers.current.onFrameMessage(board, data),
        onKey: (_board, key) => {
          if (key !== 'v' && key !== 'V') return;
          setTool('select');
          surfaceRef.current?.focus({ preventScroll: true });
        },
        onWheel: (board, data) => {
          const r = surfaceRef.current?.getBoundingClientRect();
          const b = engineRef.current?.board(board);
          if (!r || !b) return;
          // The page gives the pointer in its own pixels; zoomed, it stays where it is on screen.
          const v = viewRef.current;
          handlers.current.wheel(data.dx, data.dy, data.deltaMode, data.zoom, r.left + v.px + (b.x + data.x) * v.z, r.top + v.py + (b.y + data.y) * v.z);
        },
      },
    });
    engineRef.current = e;
    for (const [id, el] of slotEls.current) e.attachSlot(id, el);
    setEngine(e);
    return () => { e.destroy(); engineRef.current = null; setEngine(null); };
    // The engine lives as long as the panel; the handlers it calls read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, support]);

  useEffect(() => { if (engine && project) engine.setCompile(project.compile); }, [engine, project]);

  const pages = useMemo(() => project?.pages ?? [], [project]);
  const ordered = useMemo(() => DEVICE_ORDER.filter((d) => devices.includes(d)), [devices]);
  const heightOf = (id: string) => { const b = engineRef.current?.board(id); return b?.measured ? b.h : undefined; };
  // One ref callback per artboard for as long as the panel lives: a new one each render would detach
  // and reattach the slot, and the engine would take its frames down every time.
  const slotRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const slotRef = (id: string) => {
    let fn = slotRefs.current.get(id);
    if (!fn) {
      fn = (el) => {
        if (el) slotEls.current.set(id, el); else slotEls.current.delete(id);
        engineRef.current?.attachSlot(id, el);
      };
      slotRefs.current.set(id, fn);
    }
    return fn;
  };
  const boards: ArtboardBox[] = layoutArtboards(pages, ordered, heightOf);
  const boardsKey = boards.map((b) => `${b.id}:${b.x}:${b.h}`).join('|');
  useEffect(() => {
    engineRef.current?.setBoards(boards);
    // Keyed by what the layout is, not by the array, which is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, boardsKey]);

  // Off screen, or the browser tab hidden: nothing live, no background work.
  useEffect(() => {
    if (!engine) return;
    const sync = () => engine.setActive(onScreen && document.visibilityState !== 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [engine, onScreen]);

  useEffect(() => { engine?.setInteractive(tool === 'interact'); }, [engine, tool]);

  // ---------- view ----------
  const apply = useCallback(() => {
    const v = viewRef.current;
    const world = worldRef.current;
    if (world) {
      world.style.transform = `translate(${v.px}px, ${v.py}px) scale(${v.z})`;
      world.style.setProperty('--z', String(v.z));
    }
    const rect = viewRectOf(v, sizeRef.current.w, sizeRef.current.h);
    engineRef.current?.setView(rect, v.z);
    // The page picker follows the view while nothing is selected: the page nearest the middle.
    if (!selRef.current) {
      const cx = rect.x + rect.w / 2;
      let best: { page: string } | null = null, bestD = Infinity;
      for (const b of engineRef.current?.boards.values() ?? []) {
        const d = cx < b.x ? b.x - cx : cx > b.x + b.w ? cx - b.x - b.w : 0;
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best) setPage(best.page);
    }
    redraw();
  }, [redraw]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const r = surfaceRef.current?.getBoundingClientRect();
    if (!r) return;
    const v = viewRef.current;
    const z = clamp(v.z * factor, MIN_Z, MAX_Z);
    const sx = clientX - r.left, sy = clientY - r.top;
    viewRef.current = { z, px: sx - ((sx - v.px) / v.z) * z, py: sy - ((sy - v.py) / v.z) * z };
    apply();
  }, [apply]);

  const wheel = useCallback((dx: number, dy: number, deltaMode: number, zoom: boolean, clientX: number, clientY: number) => {
    engineRef.current?.touch();
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
    if (zoom) { zoomAt(clientX, clientY, Math.exp(-dy * unit * 0.0015)); return; }
    viewRef.current = { ...viewRef.current, px: viewRef.current.px - dx * unit, py: viewRef.current.py - dy * unit };
    apply();
  }, [apply, zoomAt]);

  const fitPage = useCallback((file: string | null) => {
    if (!file) return;
    const group = layoutArtboards(pages, DEVICE_ORDER.filter((d) => devices.includes(d)), heightOf).filter((b) => b.page === file);
    const v = fitView(group, sizeRef.current.w);
    if (!v) return;
    viewRef.current = v;
    apply();
  }, [pages, devices, apply]);

  const goToPage = useCallback((file: string) => { setPage(file); fitPage(file); }, [fitPage]);

  // The surface's size, and the first view once there are pages to show.
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const measure = () => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
      if (!fittedRef.current && pages.length && el.clientWidth) {
        fittedRef.current = true;
        const first = pages.find((p) => p.file === '/index.html') ?? pages[0];
        goToPage(first.file);
      } else apply();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages, apply, goToPage]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheel(e.deltaX, e.deltaY, e.deltaMode, e.ctrlKey || e.metaKey, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [wheel]);


  // ---------- selection ----------
  const boardOf = (id: string) => boards.find((b) => b.id === id) ?? null;

  /** One element of an artboard's page, as its frame describes it; null when there is none, or the answer is not one. */
  const describeOn = useCallback(async (boardId: string, query: { nodeId: string } | { childOf: string } | { src: string; index: number }) => {
    const reply = await engineRef.current?.ask<{ item?: unknown }>(boardId, { type: 'canvas:describe', ...query });
    return isPickItem(reply?.item) ? reply.item : null;
  }, []);

  /** Which elements each artboard of the selected page reports the box of: the selection, and its twins. */
  const watchBoard = useCallback((boardId: string) => {
    const e = engineRef.current;
    const s = selRef.current;
    const b = e?.board(boardId);
    if (!e || !b) return;
    const watch = (targets: Record<string, unknown>[]) => {
      // With no frame on show to tell, the box it last reported is of the elements watched before.
      if (!e.post(boardId, { type: 'canvas:watch', targets }) && boardId !== s?.board) {
        setRects((prev) => (prev[boardId] ? { ...prev, [boardId]: null } : prev));
      }
    };
    if (!s) { watch([]); return; }
    const selPage = e.board(s.board)?.page;
    if (boardId === s.board) watch([{ nodeId: s.nodeId }]);
    else if (b.page === selPage && s.src) watch([{ src: s.src, index: s.index }]);
    else watch([]);
  }, []);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    for (const id of e.boards.keys()) watchBoard(id);
    if (!sel) setRects({});
    e.setFocus(sel?.board ?? null);
  }, [sel, watchBoard]);

  /** A selection moving to another width's artboard, waiting for its frame; a newer selection, or none, gives it up. */
  const pendingMove = useRef<{ board: string; src: string; index: number } | null>(null);

  const takeSelection = useCallback((boardId: string, item: PickItem) => {
    inspect(boardId);
    setSelection(selectionOf(boardId, item));
    setRects((prev) => ({ ...prev, [boardId]: item.rect }));
  }, [setSelection, inspect]);

  const select = useCallback((boardId: string, item: PickItem) => {
    pendingMove.current = null;
    takeSelection(boardId, item);
    ownSelections.current.add(boardId, item.nodeId);
    // The frame answers with the same payload a click in Live Preview makes.
    engineRef.current?.post(boardId, { type: 'tree-select', nodeId: item.nodeId });
  }, [takeSelection]);

  const clearSelection = useCallback((tell: boolean) => {
    pendingMove.current = null;
    setSelection(null);
    setPicked(null);
    setHover(null);
    setMetrics(null);
    setMenu(null);
    if (tell) cb.current.onFocusSelection(null);
  }, [setSelection]);

  // A width turned off, or a page removed, takes its artboard: text typed there ends with its frame,
  // the selection on it goes, and the Inspector reads another.
  useEffect(() => {
    const ids = new Set(boards.map((b) => b.id));
    if (editingRef.current && !ids.has(editingRef.current.board)) { editingRef.current = null; setEditing(null); engineRef.current?.release(); }
    if (inspectRef.current && !ids.has(inspectRef.current)) inspect(null);
    if (selRef.current && !ids.has(selRef.current.board)) clearSelection(true);
    // Keyed by what the layout is, as `setBoards` is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardsKey, clearSelection]);

  /** The artboard on screen, centred across when it is not. */
  const revealBoard = useCallback((id: string) => {
    const b = engineRef.current?.board(id);
    if (!b) return;
    const v = viewRef.current;
    const { w } = sizeRef.current;
    const left = b.x * v.z + v.px;
    const right = (b.x + b.w) * v.z + v.px;
    if (left >= 0 && right <= w) return;
    viewRef.current = { ...v, px: w / 2 - (b.x + b.w / 2) * v.z };
    apply();
  }, [apply]);

  /** The moved selection's artboard has a frame: the same element there becomes the selection. */
  const finishMove = useCallback((boardId: string) => {
    const want = pendingMove.current;
    const e = engineRef.current;
    if (!want || want.board !== boardId || !e) return;
    void describeOn(boardId, { src: want.src, index: want.index }).then((item) => {
      // Given up meanwhile, or finished by an earlier answer.
      if (pendingMove.current !== want) return;
      pendingMove.current = null;
      if (item) select(boardId, item);
    });
  }, [select, describeOn]);

  /** Start a pending move once its artboard exists: live as the focus, and on screen. */
  const startMove = useCallback(() => {
    const want = pendingMove.current;
    const e = engineRef.current;
    if (!want || !e || !e.board(want.board)) return;
    e.setFocus(want.board);
    revealBoard(want.board);
    if (e.tierOf(want.board) === 'live' && !e.isBooting(want.board)) finishMove(want.board);
  }, [revealBoard, finishMove]);
  // Keyed by what the layout is, as `setBoards` is: re-centring redraws, and a render must not start it again.
  useEffect(() => { startMove(); }, [boardsKey, startMove]);

  /** A selection the frame made: from a pick, from the Inspector's tree, or re-resolved after a reload. */
  const onFrameMessage = useCallback((boardId: string, data: { type: string; [key: string]: unknown }) => {
    const e = engineRef.current;
    if (!e) return;
    if (data.type === 'navigate') {
      const file = project ? pageForPath(project.routes, project.pages, String(data.path ?? '')) : null;
      if (file) goToPage(file);
      return;
    }
    if (data.type === 'preview:external') return;
    if (data.type === 'placement-complete') {
      // Taken only for a drop Canvas made, on that board and of that block, once: a page's script can post this too.
      const b = e.board(boardId);
      const pending = pendingDrop.current;
      const payload = data.payload as PlacementResult | null | undefined;
      if (!b || !payload || typeof payload !== 'object' || !pending || pending.board !== boardId || payload.blockId !== pending.blockId) return;
      pendingDrop.current = null;
      cb.current.onPlacementComplete?.(payload, b.page);
      return;
    }
    if (data.type === 'placement-cancelled') {
      if (pendingDrop.current?.board === boardId) pendingDrop.current = null;
      // A board left mid-drag is cancelled by Canvas itself; the palette stays open.
      return;
    }
    if (data.type === 'iframe-click') return;
    if (data.type === 'canvas:text-done') {
      // Only the edit Canvas started, on that board and element: a page's script can post this too.
      const edit = editingRef.current;
      if (!edit || edit.board !== boardId || edit.nodeId !== data.nodeId) return;
      editingRef.current = null;
      setEditing(null);
      // A change is written, and its recompile is what the page should reload with.
      e.release(data.changed === true);
      surfaceRef.current?.focus({ preventScroll: true });
      if (data.changed === true && typeof data.text === 'string') cb.current.onTextEdited?.(data.text);
      return;
    }
    if (boardId !== inspectRef.current) return;
    if (data.type === 'selector-selection' || data.type === 'selection-resolved') {
      const payload = (data.payload ?? null) as FocusContextPayload | null;
      if (data.type === 'selector-selection' && payload) {
        const mine = ownSelections.current.settle(boardId, payload.nodeId);
        // A newer selection of Canvas's own is on its way: this one would put an older one back.
        if (mine === 'stale') return;
        // Canvas took this selection when it made it; the frame's payload is what it adds.
        if (mine === 'own') { setPicked({ board: boardId, payload }); cb.current.onFocusSelection(payload); return; }
        // Made in the frame (the Inspector's tree): newer than a move still waiting.
        pendingMove.current = null;
      }
      setPicked(payload ? { board: boardId, payload } : null);
      if (payload) {
        void describeOn(boardId, { nodeId: payload.nodeId }).then((item) => {
          if (item) takeSelection(boardId, item);
        });
      } else if (data.type === 'selection-resolved') setSelection(null);
      if (data.type === 'selector-selection') { cb.current.onFocusSelection(payload); return; }
    }
    cb.current.onInspectorMessage(data as unknown as PreviewMessage);
  }, [project, goToPage, takeSelection, setSelection, describeOn]);

  handlers.current = { watchBoard, onFrameMessage, wheel, finishMove };

  // ---------- pointer ----------
  const boardAtClient = useCallback((clientX: number, clientY: number) => {
    const r = surfaceRef.current?.getBoundingClientRect();
    if (!r) return null;
    const v = viewRef.current;
    const cx = (clientX - r.left - v.px) / v.z, cy = (clientY - r.top - v.py) / v.z;
    const b = artboardAt(boards, cx, cy);
    return b ? { b, x: cx - b.x, y: cy - b.y } : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardsKey]);

  const pick = useCallback(async (boardId: string, x: number, y: number) => {
    const reply = await engineRef.current?.ask<{ chain?: unknown }>(boardId, { type: 'canvas:pick', x, y }, 800);
    const chain = reply?.chain;
    return Array.isArray(chain) && chain.every(isPickItem) ? chain : null;
  }, []);

  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean; id: number } | null>(null);
  const spaceRef = useRef(false);
  const hoverBusy = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    surfaceRef.current?.focus({ preventScroll: true });
    engineRef.current?.touch();
    drag.current = { x: e.clientX, y: e.clientY, px: viewRef.current.px, py: viewRef.current.py, moved: false, id: e.pointerId };
    if (e.button === 1 || spaceRef.current) e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; surfaceRef.current?.setPointerCapture(e.pointerId); setHover(null); }
      if (d.moved) {
        viewRef.current = { ...viewRef.current, px: d.px + dx, py: d.py + dy };
        engineRef.current?.touch();
        apply();
      }
      return;
    }
    const at = boardAtClient(e.clientX, e.clientY);
    engineRef.current?.setAwake(at?.b.id ?? null);
    if (!at || support !== 'edit' || hoverBusy.current || editing) return;
    hoverBusy.current = true;
    if (isInsertTool(tool)) {
      void dropAt(at.b.id, at.x, at.y).then((found) => { hoverBusy.current = false; setDrop(found); });
      return;
    }
    const deepest = e.metaKey || e.ctrlKey;
    void pick(at.b.id, at.x, at.y).then((chain) => {
      hoverBusy.current = false;
      const s = selRef.current;
      const target = chain ? clickTarget(chain, at.b.h, s && s.board === at.b.id ? s : null, deepest) : null;
      setHover(target ? { board: at.b.id, rect: target.rect, name: nameOf(target) } : null);
      hoverNode(target && at.b.id === inspectRef.current ? target.nodeId : null);
    });
  };

  /** The last press dragged the canvas or took a handle: the click the browser still sends for it is not a click on the page. */
  const dragged = useRef(false);

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    dragged.current = d.moved || spaceRef.current;
    if (surfaceRef.current?.hasPointerCapture(e.pointerId)) surfaceRef.current.releasePointerCapture(e.pointerId);
    if (d.moved || e.button !== 0 || spaceRef.current) return;
    const at = boardAtClient(e.clientX, e.clientY);
    if (!at) { if (selRef.current) clearSelection(true); return; }
    if (support !== 'edit' || editing) return;
    if (isInsertTool(tool)) { void insertAt(tool, at.b.id, at.x, at.y); return; }
    void pick(at.b.id, at.x, at.y).then((chain) => {
      if (!chain) return;
      const s = selRef.current;
      const target = clickTarget(chain, at.b.h, s && s.board === at.b.id ? s : null, e.metaKey || e.ctrlKey);
      if (target) select(at.b.id, target);
      else if (s) clearSelection(true);
    });
  };

  /** Every second click of a run goes a level deeper (`isDoubleClick`); odd ones keep the selection. */
  const onClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || !isDoubleClick(e.detail) || dragged.current) return;
    const at = boardAtClient(e.clientX, e.clientY);
    if (!at || support !== 'edit' || editing || isInsertTool(tool)) return;
    const deep = e.metaKey || e.ctrlKey;
    void pick(at.b.id, at.x, at.y).then((chain) => {
      if (!chain) return;
      const s = selRef.current;
      const next = doubleClickTarget(chain, at.b.h, s && s.board === at.b.id ? s : null, deep);
      if (!next.select) return;
      if (!(s && s.board === at.b.id && s.nodeId === next.select.nodeId)) select(at.b.id, next.select);
      if (next.editText) startTextEdit(at.b.id, next.select.nodeId);
    });
  };

  // ---------- Semantic blocks: dragged from the palette onto an artboard ----------
  const endPlacement = useCallback((cancel: boolean) => {
    const board = placeBoardRef.current;
    placeBoardRef.current = null;
    if (board && cancel) engineRef.current?.post(board, { type: 'placement-cancel' });
    draggingRef.current = null;
    setDraggingBlock(null);
  }, []);
  useEffect(() => {
    if (!draggingBlock) return;
    // A drag let go outside, or cancelled with Esc, never reaches the surface's drop.
    const ended = () => endPlacement(true);
    window.addEventListener('dragend', ended);
    return () => window.removeEventListener('dragend', ended);
  }, [draggingBlock, endPlacement]);
  const onBlockDragStart = (block: SemanticBlock) => {
    const info = { id: block.id, name: block.name, wireframeHtml: block.wireframeHtml };
    draggingRef.current = info;
    pendingDrop.current = null;
    // After the drag has begun: re-rendering the source during dragstart cancels the drag.
    setTimeout(() => setDraggingBlock(info), 0);
  };
  /** Only a live page has the placement script: a still, or a picture of one, takes no block. */
  const takesBlocks = (id: string) => {
    const engine = engineRef.current;
    return !!engine && engine.tierOf(id) === 'live' && !engine.isBooting(id);
  };
  const onBlockDragOver = (e: React.DragEvent) => {
    const block = draggingRef.current;
    if (!block) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const found = boardAtClient(e.clientX, e.clientY);
    const at = found && takesBlocks(found.b.id) ? found : null;
    const engine = engineRef.current;
    if (!engine) return;
    if (!at) {
      if (placeBoardRef.current) { engine.post(placeBoardRef.current, { type: 'placement-cancel' }); placeBoardRef.current = null; }
      return;
    }
    if (placeBoardRef.current !== at.b.id) {
      if (placeBoardRef.current) engine.post(placeBoardRef.current, { type: 'placement-cancel' });
      placeBoardRef.current = at.b.id;
      engine.post(at.b.id, { type: 'placement-start', block });
    }
    engine.post(at.b.id, { type: 'placement-hover', x: at.x, y: at.y });
  };
  const onBlockDrop = (e: React.DragEvent) => {
    const block = draggingRef.current;
    if (!block) return;
    e.preventDefault();
    const board = placeBoardRef.current;
    if (board && takesBlocks(board)) {
      pendingDrop.current = { board, blockId: block.id };
      engineRef.current?.post(board, { type: 'placement-drop' });
    }
    endPlacement(false);
  };

  // ---------- the dropper, typing in place, the element menu ----------
  const dropAt = useCallback(async (boardId: string, x: number, y: number): Promise<DropInfo | null> => {
    const reply = await engineRef.current?.ask<{ drop?: unknown }>(boardId, { type: 'canvas:drop-at', x, y }, 800);
    const drop = reply?.drop;
    // A place that is not one counts as none: the spot is shown, refused.
    return isDrop(drop) ? { board: boardId, ...drop, place: isPlace(drop.place) ? drop.place : null } : null;
  }, []);

  const insertAt = async (kind: InsertKind, boardId: string, x: number, y: number) => {
    const found = await dropAt(boardId, x, y);
    setDrop(null);
    if (!found) return;
    if (!found.place) { toast(t('insert.noPlace')); return; }
    if (found.locked) { toast.error(t('insert.locked', { parent: found.parentName })); return; }
    inspect(boardId);
    setTool('select');
    const text = kind === 'text' ? t('insert.textPlaceholder') : kind === 'button' ? t('insert.buttonLabel') : undefined;
    cb.current.onStructure?.({ kind: 'insert', place: found.place, element: kind, text }, { instances: found.instances });
  };

  /** The tree lights the row of what the pointer is on, on the artboard it reads. */
  const hoverNodeRef = useRef<string | null>(null);
  const hoverNode = (nodeId: string | null) => {
    if (hoverNodeRef.current === nodeId) return;
    hoverNodeRef.current = nodeId;
    cb.current.onHoverNode?.(nodeId);
  };

  const startTextEdit = (boardId: string, nodeId: string) => {
    const e = engineRef.current;
    if (!e) return;
    // Mirrored into the ref at once: the frame's answer can come before the next render.
    editingRef.current = { board: boardId, nodeId };
    setEditing(editingRef.current);
    // A recompile meanwhile (the write that made a new Text) must not reload the page under the typing.
    e.hold(boardId);
    // The frame takes the keyboard from here; the page focuses the element itself.
    e.focusFrame(boardId);
    e.post(boardId, { type: 'canvas:edit-text', nodeId });
  };

  /** An action on `s`: Canvas's selection for a key, the element the menu was opened on for the menu. */
  const act = (action: ElementAction, s: CanvasSelection | null = selRef.current) => {
    const e = engineRef.current;
    if (!s || !e) return;
    switch (action) {
      case 'select-parent':
        if (!s.parentId) { clearSelection(true); return; }
        void describeOn(s.board, { nodeId: s.parentId }).then((item) => { if (item) select(s.board, item); });
        return;
      case 'select-child':
        void describeOn(s.board, { childOf: s.nodeId }).then((item) => { if (item) select(s.board, item); });
        return;
      case 'edit-text':
        startTextEdit(s.board, s.nodeId);
        return;
      case 'include':
        cb.current.onToolbarAction({ type: 'toolbar-action', action: 'include', nodeId: s.nodeId });
        return;
      case 'toggle-hide':
      case 'clear-scope': {
        const b = e.board(s.board);
        if (b) cb.current.onStyleCommand?.(action, s.nodeId, { page: b.page, viewportWidth: b.w });
        return;
      }
      case 'copy-style':
      case 'paste-style': {
        const known = payloadFor(s);
        if (known) cb.current.onStyleClip?.(action, known);
        return;
      }
      case 'move-up':
      case 'move-down':
      case 'wrap':
      case 'unwrap':
      case 'duplicate':
      case 'delete': {
        // Until the frame has said which source the element comes from, there is nothing to name it by.
        const known = payloadFor(s);
        if (known) cb.current.onElementAction?.(action, toPreviewSelection(known));
        return;
      }
    }
  };

  /**
   * A right-click selects what is under it, or the selection when it is inside that, and opens the
   * menu there. Selected again even when it is the selection, so the Inspector reads it by the time
   * the menu acts: it may be reading Live Preview, or another artboard.
   */
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const at = boardAtClient(e.clientX, e.clientY);
    if (!at || support !== 'edit' || editing) return;
    const point = { x: e.clientX, y: e.clientY };
    const deepest = e.metaKey || e.ctrlKey;
    void pick(at.b.id, at.x, at.y).then((chain) => {
      if (!chain || !chain.length) return;
      const s = selRef.current;
      const inside = s && s.board === at.b.id ? chain.find((c) => c.nodeId === s.nodeId) : undefined;
      const target = inside ?? clickTarget(chain, at.b.h, null, deepest);
      if (!target) return;
      select(at.b.id, target);
      setMenu({ at: point, on: selectionOf(at.b.id, target) });
    });
  };

  const zoomCentre = (factor: number) => {
    const r = surfaceRef.current?.getBoundingClientRect();
    if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== surfaceRef.current) return;
    if (e.key === ' ') { spaceRef.current = true; e.preventDefault(); return; }
    const mod = e.metaKey || e.ctrlKey;
    const s = selRef.current;
    const run = (action: ElementAction) => { e.preventDefault(); act(action); };
    if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomCentre(1.25); return; }
    if (mod && !e.altKey && e.key === '-') { e.preventDefault(); zoomCentre(1 / 1.25); return; }
    if (e.shiftKey && !mod && e.code === 'Digit1') { e.preventDefault(); fitPage(page); return; }
    if (!s) {
      if (mod || e.altKey) return;
    } else {
      // Alt changes what the letter keys type on a Mac (⌥C is ç), so these read the key's place.
      if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { run(e.key === 'ArrowUp' ? 'move-up' : 'move-down'); return; }
      if (mod && e.altKey && e.code === 'KeyC') { run('copy-style'); return; }
      if (mod && e.altKey && e.code === 'KeyV') { run('paste-style'); return; }
      if (mod && e.altKey && e.code === 'KeyG') { run('wrap'); return; }
      if (mod && !e.altKey && e.code === 'KeyD') { run('duplicate'); return; }
      if (mod || e.altKey) return;
      if (e.key === 'Enter') { run('select-child'); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { run('delete'); return; }
    }
    if (e.key === 'Escape') {
      if (isInsertTool(tool)) { setTool('select'); setDrop(null); return; }
      if (s) act('select-parent');
      return;
    }
    const keyed: Record<string, Tool> = { v: 'select', p: 'interact', f: 'frame', t: 'text', i: 'image', b: 'button', d: 'divider' };
    const next = keyed[e.key.toLowerCase()];
    // The insert tools are only where pages can be edited, as on the toolbar.
    if (next && (support === 'edit' || !isInsertTool(next))) { setTool(next); setDrop(null); }
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === ' ') spaceRef.current = false; };
  /** A key let go once the keyboard has left is never heard here: Space must not stay held. */
  const onBlur = () => { spaceRef.current = false; };

  // ---------- the Inspector's handle ----------
  useImperativeHandle(ref, () => ({
    sendToFrame(message: PreviewHostMessage) {
      const e = engineRef.current;
      if (!e) return;
      switch (message.type) {
        case 'overrides-preview':
          e.overridesPreview(message.css, message.marks, message.unmarks);
          return;
        case 'structure-patch':
        case 'variable-preview':
          // Every artboard shows the edit at once: the page's other widths, and every page a partial is in
          // or a variable reaches.
          e.broadcast(message as unknown as Record<string, unknown>);
          return;
        case 'selection-clear':
          clearSelection(false);
          return;
        case 'tree-highlight': {
          const boardId = inspectRef.current;
          if (!boardId || !message.nodeId) { setHover(null); return; }
          void describeOn(boardId, { nodeId: message.nodeId }).then((item) => {
            setHover(item ? { board: boardId, rect: item.rect, name: nameOf(item) } : null);
          });
          return;
        }
        case 'selector-toggle':
        case 'toolbar-theme':
        case 'scroll-restore':
        case 'placement-start':
        case 'placement-remove':
          // The placeholder is in whichever artboard frame took the drop.
          e.broadcast(message as unknown as Record<string, unknown>);
          return;
        case 'placement-hover':
        case 'placement-drop':
        case 'placement-cancel':
          return;
        default: {
          const boardId = inspectRef.current ?? boards.find((b) => b.page === page)?.id ?? null;
          if (!boardId) return;
          inspect(boardId);
          e.post(boardId, message as unknown as Record<string, unknown>);
        }
      }
    },
    getActivePath() {
      const id = inspectRef.current;
      return (id && engineRef.current?.board(id)?.page) || page || '/index.html';
    },
    selectTool() {
      setTool('select');
    },
    editTextAt(src) {
      const e = engineRef.current;
      const boardId = inspectRef.current;
      if (!e || !boardId) return;
      // Found by where it is in source: the selection may still be on its way from the frame.
      void describeOn(boardId, { src, index: 0 }).then((item) => {
        if (item) startTextEdit(boardId, item.nodeId);
      });
    },
    moveToScope(scope, breakpoints) {
      const s = selRef.current;
      const from = s ? engineRef.current?.board(s.board) : null;
      if (!s || !s.src || !from) return;
      const fits = CANVAS_DEVICE_ORDER.filter((d) => scopeOfWidth(CANVAS_DEVICES[d].w, breakpoints) === scope);
      const device = fits.find((d) => devices.includes(d)) ?? fits[0];
      if (!device) return;
      const target = artboardId(from.page, device);
      if (target === s.board) return;
      pendingMove.current = { board: target, src: s.src, index: s.index };
      if (!devices.includes(device)) setDevices((list) => [...list, device]);
      else startMove();
    },
  }), [boards, page, clearSelection, devices, startMove, describeOn, inspect]);

  // ---------- drawing ----------
  const v = viewRef.current;
  const toScreen = (b: ArtboardBox, r: Rect): Rect => ({ x: (b.x + r.x) * v.z + v.px, y: (b.y + r.y) * v.z + v.py, w: r.w * v.z, h: r.h * v.z });
  const selBoard = sel ? boardOf(sel.board) : null;
  const selRect = sel && selBoard && rects[sel.board] ? toScreen(selBoard, rects[sel.board]!) : null;
  const twins = sel ? boards.filter((b) => b.id !== sel.board && b.page === selBoard?.page && rects[b.id]).map((b) => toScreen(b, rects[b.id]!)) : [];
  const hoverBoard = hover ? boardOf(hover.board) : null;
  const hoverRect = hover && hoverBoard && !(sel && sel.board === hover.board && selRect && hover.name === sel.name && rects[sel.board] && hover.rect.x === rects[sel.board]!.x && hover.rect.y === rects[sel.board]!.y) ? toScreen(hoverBoard, hover.rect) : null;

  // ---------- handles: size, padding and gap, dragged on the selection ----------
  const selPage = selBoard && rects[selBoard.id] ? rects[selBoard.id]! : null;
  const gapRect = selBoard && metrics?.gap ? toScreen(selBoard, metrics.gap) : null;
  const handlesOn = Boolean(selRect && metrics && cb.current.canStyle && !editing && support === 'edit' && v.z >= 0.1
    && selRect.w >= 28 && selRect.h >= 14 && payload?.locked !== true);
  /** Ends the handle drag under way, its window listeners with it. */
  const endHandleDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endHandleDrag.current?.(), []);
  const startHandle = (kind: string, e: React.PointerEvent) => {
    const s = selRef.current;
    const box = s ? rects[s.board] : null;
    const m = metrics;
    if (!s || !box || !m) return;
    e.preventDefault();
    e.stopPropagation();
    // The surface never sees this press, so its pointerup leaves `dragged` alone for the click.
    dragged.current = true;
    const z = viewRef.current.z;
    const from = { x: e.clientX, y: e.clientY, all: e.altKey };
    const px = (n: number) => `${Math.max(0, Math.round(n))}px`;
    setDragging(kind);
    cb.current.onHandleDrag?.('start', []);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - from.x) / z;
      const dy = (ev.clientY - from.y) / z;
      const changes: StyleChange[] = [];
      const pad = (side: 'top' | 'right' | 'bottom' | 'left', value: number) => {
        for (const which of from.all ? (['top', 'right', 'bottom', 'left'] as const) : [side]) changes.push({ property: `padding-${which}`, value: px(value) });
      };
      if (kind === 'e' || kind === 'se') {
        changes.push({ property: 'width', value: `${Math.max(8, Math.round(box.w + dx))}px` });
        // In a flex row the basis would decide the width instead.
        if (m.parentRow) changes.push({ property: 'flex', value: null });
      }
      if (kind === 's' || kind === 'se') changes.push({ property: 'height', value: `${Math.max(8, Math.round(box.h + dy))}px` });
      if (kind === 'pt') pad('top', m.pt + dy);
      if (kind === 'pb') pad('bottom', m.pb - dy);
      if (kind === 'pl') pad('left', m.pl + dx);
      if (kind === 'pr') pad('right', m.pr - dx);
      if (kind === 'gap' && m.gap) changes.push(m.gap.across ? { property: 'column-gap', value: px(m.columnGap + dx) } : { property: 'row-gap', value: px(m.rowGap + dy) });
      cb.current.onHandleDrag?.('move', changes);
    };
    const up = () => {
      endHandleDrag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(null);
      cb.current.onHandleDrag?.('end', []);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    endHandleDrag.current = up;
  };

  const toolButton = (key: Tool, Icon: typeof Hand, label: string) => (
    <Tip key={key} label={label} side="bottom">
      <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={label} aria-pressed={tool === key}
        style={tool === key ? TOGGLE_ON : undefined}
        onClick={() => { setTool(tool === key && key !== 'select' ? 'select' : key); setDrop(null); }}>
        <Icon className="h-3 w-3" />
      </Button>
    </Tip>
  );

  const menuBoard = menu ? boardOf(menu.on.board) : null;
  /** What the frame said about the element the menu is on; nothing yet in the moment before it answers. */
  const menuPayload = menu ? payloadFor(menu.on) : null;
  const menuFacts: ElementMenuFacts | null = menu && menuBoard ? {
    name: menu.on.name,
    where: `${menuBoard.page.replace(/^\//, '')} @${menuBoard.w}`,
    locked: Boolean(menuPayload?.locked),
    frame: Boolean(menuPayload?.frame),
    textLeaf: Boolean(menuPayload?.textBearing),
    hasParent: Boolean(menu.on.parentId),
    hasChild: !menuPayload?.textBearing && menuPayload?.tagName !== 'img',
    // A right-click reaches only what the artboard draws, under the pointer and around it: never an
    // element hidden there.
    hidden: false,
    scope: scopeOfWidth(menuBoard.w, cb.current.breakpoints ?? []),
    canPaste: Boolean(cb.current.canPasteStyle),
    canStyle: Boolean(cb.current.canStyle),
    marked: Boolean(menuPayload?.attributes?.[MARKER_ATTR]),
  } : null;

  const zoomPercent = Math.round(v.z * 100);
  // Zoomed out past where pages go live, each page gets one label across its widths.
  const groupLabels = v.z < DEFAULT_BUDGET.zLive;
  const groupWidth = new Map<string, number>();
  for (const b of boards) {
    const first = boards.find((x) => x.page === b.page)!;
    groupWidth.set(b.page, b.x + b.w - first.x);
  }

  return (
    <PanelContainer>
      <PanelHeader icon={Frame} title={tw('tabs.canvas')} color="var(--button-canvas-active)" onClose={onClose} panelKey="canvas" />
      {support === null ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm font-medium">{t('unavailable')}</p>
          <p className="text-xs text-muted-foreground">{t('unavailableHint', { runtime: getRuntimeConfig(runtime).label })}</p>
        </div>
      ) : (
        <>
          <div className="border-b p-2 flex flex-wrap items-center gap-2 min-w-0">
            <div className="flex items-center gap-1" role="toolbar" aria-label={t('tools.label')}>
              {toolButton('select', MousePointer2, t('tools.select'))}
              {toolButton('interact', Hand, t('tools.usePages'))}
              {support === 'edit' && (
                <>
                  <span className="w-px h-4 bg-border mx-1" />
                  {toolButton('frame', SquareDashed, t('tools.frame'))}
                  {toolButton('text', Type, t('tools.text'))}
                  {toolButton('image', ImageIcon, t('tools.image'))}
                  {toolButton('button', RectangleHorizontal, t('tools.button'))}
                  {toolButton('divider', Minus, t('tools.divider'))}
                  <span className="w-px h-4 bg-border mx-1" />
                  <Tip label={t('tools.blocks')} side="bottom">
                    <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={t('tools.blocks')} aria-pressed={blocksOpen}
                      style={blocksOpen ? TOGGLE_ON : undefined}
                      onClick={() => setBlocksOpen((open) => !open)}>
                      <LayoutGrid className="h-3 w-3" />
                    </Button>
                  </Tip>
                </>
              )}
            </div>
            <div className="flex-1 min-w-0" />
            {pages.length > 1 && (
              <Select value={page ?? undefined} onValueChange={goToPage}>
                <Tip label={t('page')} side="bottom" wrap>
                  <SelectTrigger className="w-[180px] max-w-full h-8 min-w-0" aria-label={t('page')}>
                    <SelectValue />
                  </SelectTrigger>
                </Tip>
                <SelectContent>
                  {pages.map((p) => <SelectItem key={p.file} value={p.file}>{p.title}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center gap-1 border-l pl-2">
              {CANVAS_DEVICE_ORDER.map((d) => {
                const on = devices.includes(d);
                const Icon = DEVICE_ICON[d];
                return (
                  <Tip key={d} label={t(`widths.${d}`)} side="bottom">
                    <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={t(`widths.${d}`)} aria-pressed={on}
                      disabled={on && devices.length === 1}
                      style={on ? TOGGLE_ON : undefined}
                      onClick={() => setDevices((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]))}>
                      <Icon className="h-3 w-3" />
                    </Button>
                  </Tip>
                );
              })}
            </div>
            <div className="flex items-center gap-1 border-l pl-2">
              <Tip label={`${t('zoomOut')} (${modShortcut('−')})`} side="bottom">
                <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={t('zoomOut')}
                  onClick={() => { const r = surfaceRef.current?.getBoundingClientRect(); if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25); }}>
                  <Minus className="h-3 w-3" />
                </Button>
              </Tip>
              <span className="w-9 text-center text-xs tabular-nums text-muted-foreground" aria-label={t('zoom')}>{zoomPercent}%</span>
              <Tip label={`${t('zoomIn')} (${modShortcut('+')})`} side="bottom">
                <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={t('zoomIn')}
                  onClick={() => { const r = surfaceRef.current?.getBoundingClientRect(); if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); }}>
                  <Plus className="h-3 w-3" />
                </Button>
              </Tip>
              <Tip label={`${t('fit')} (${shiftShortcut('1')})`} side="bottom" align="end">
                <Button size="icon" variant="ghost" className="h-5 w-5 rounded-sm" aria-label={t('fit')} onClick={() => fitPage(page)}>
                  <Scan className="h-3 w-3" />
                </Button>
              </Tip>
            </div>
          </div>
          {support === 'view' && (
            <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{t('viewOnly', { runtime: getRuntimeConfig(runtime).label })}</p>
          )}
          {support === 'edit' && engine?.drawnByScript() && (
            <p data-canvas-drawn="" className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">{t('drawnByScript')}</span>
              <Button size="sm" variant="outline" className="h-6 shrink-0 text-xs" onClick={() => useWorkspaceStore.getState().revealPanel('preview')}>
                {t('openLivePreview')}
              </Button>
            </p>
          )}
          <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={surfaceRef}
            data-canvas-surface=""
            tabIndex={0}
            className={cn('relative flex-1 min-h-0 overflow-hidden bg-muted/20 dark:bg-muted/10 outline-none select-none touch-none', tool === 'interact' && 'osw-canvas-interacting', isInsertTool(tool) && 'cursor-crosshair')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; }}
            onPointerLeave={() => { setHover(null); setDrop(null); hoverNode(null); engineRef.current?.setAwake(null); }}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onBlur={onBlur}
            onContextMenu={openMenu}
            onDragOver={onBlockDragOver}
            onDrop={onBlockDrop}
          >
            <div ref={worldRef} className="absolute left-0 top-0" style={{ transformOrigin: '0 0' }}>
              {boards.map((b) => {
                const tier = engine?.tierOf(b.id) ?? 'none';
                // Until a picture arrives the board is the app's surface, not a white page, so a dark
                // studio does not flash white boards on open. A rendered page keeps the white base a
                // page with no background of its own has in a browser.
                const blank = tier === 'placeholder' || tier === 'none' || !!engine?.isBooting(b.id);
                const title = pages.find((p) => p.file === b.page)?.title ?? b.page;
                return (
                  <div key={b.id} className="absolute" style={{ left: b.x, top: b.y, width: b.w }} data-board={b.id} data-tier={tier}>
                    {(!groupLabels || boards.find((x) => x.page === b.page) === b) && (
                      <div className="absolute bottom-full left-0 flex items-baseline gap-2 whitespace-nowrap text-muted-foreground overflow-hidden"
                        style={{ fontSize: 'calc(12px / var(--z, 1))', marginBottom: 'calc(6px / var(--z, 1))', maxWidth: groupLabels ? groupWidth.get(b.page) : b.w }}>
                        <span className={cn('font-medium truncate min-w-0', sel && sel.board === b.id ? 'text-[color:var(--button-canvas-active)]' : 'text-foreground')}>{title}</span>
                        {!groupLabels && <span className="tabular-nums shrink-0">{b.w}</span>}
                        {!groupLabels && engine?.isBooting(b.id) && <span>{t('loading')}</span>}
                        {agentPages.has(b.page) && <span className="shrink-0 font-medium text-primary" data-agent-writing="">{t('agentWriting')}</span>}
                      </div>
                    )}
                    <div className={cn('relative overflow-hidden', blank ? 'bg-muted' : 'bg-white')}
                      style={{ height: b.h, boxShadow: agentPages.has(b.page) ? '0 0 0 calc(3px / var(--z, 1)) var(--primary)' : '0 0 0 calc(1px / var(--z, 1)) rgb(0 0 0 / 0.08)' }}>
                      {blank && (
                        <div className="absolute inset-0 bg-[repeating-linear-gradient(180deg,color-mix(in_oklab,var(--foreground)_4%,transparent)_0_48px,transparent_48px_96px)]" />
                      )}
                      <div ref={slotRef(b.id)} className="absolute inset-0" />
                      <div className={cn('absolute inset-0', (tier === 'live' && tool === 'interact') || editing?.board === b.id ? 'pointer-events-none' : '')} data-glass="" />
                      <div className={cn('absolute left-0 right-0 border-t border-dashed pointer-events-none', blank ? 'border-foreground/15' : 'border-black/12')} style={{ top: b.devH, borderTopWidth: 'calc(1px / var(--z, 1))' }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <Overlay
              hoverRect={tool === 'select' && !editing ? hoverRect : null}
              selRect={editing ? null : selRect}
              twins={twins}
              name={editing ? null : sel?.name ?? null}
              kind={sel && payload ? elementKind(payload) : null}
              onAction={(action) => { if (sel) cb.current.onToolbarAction({ type: 'toolbar-action', action, nodeId: sel.nodeId }); }}
              onHoverAction={(action) => cb.current.onToolbarHover({ type: 'toolbar-hover', action })}
              onTextAction={() => { const s = selRef.current; if (s) startTextEdit(s.board, s.nodeId); }}
            />
            {selRect && selPage && !editing && v.z >= 0.1 && selRect.w >= 28 && selRect.h >= 14 && (
              <div className="absolute pointer-events-none rounded px-1.5 text-[10px] leading-4 text-white tabular-nums whitespace-nowrap"
                style={{ left: selRect.x + selRect.w / 2, top: selRect.y + selRect.h + 8, transform: 'translateX(-50%)', background: SELECTION_SOLID }}>
                {t('size', { width: Math.round(selPage.w), height: Math.round(selPage.h) })}
              </div>
            )}
            {handlesOn && selRect && metrics && (
              <Handles r={selRect} m={metrics} z={v.z} gap={gapRect} show={dragging ?? handleOn} onDown={startHandle} onHover={setHandleOn} />
            )}
            {drop && isInsertTool(tool) && boardOf(drop.board) && (
              <DropMark
                box={toScreen(boardOf(drop.board)!, drop.box)}
                line={toScreen(boardOf(drop.board)!, drop.line)}
                bad={drop.locked || !drop.place}
                label={drop.locked ? t('insert.locked', { parent: drop.parentName }) : !drop.place ? t('insert.noPlace') : t('insert.into', { kind: t(`insert.kind.${tool}`), parent: drop.parentName })}
              />
            )}
            {editing && selRect && (
              <div className="absolute pointer-events-none" style={{ left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h, outline: '2px solid var(--primary)', borderRadius: 2 }} />
            )}
            {!project && (compiling || !error) && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground pointer-events-none">{t('compiling')}</div>
            )}
            {error && !project && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center pointer-events-none">
                <p className="text-sm font-medium">{t('compileFailed')}</p>
                <p className="text-xs text-muted-foreground">{error}</p>
              </div>
            )}
            {project && !pages.length && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center pointer-events-none">
                <p className="text-sm font-medium">{t('noPages')}</p>
                <p className="text-xs text-muted-foreground">{t('noPagesHint')}</p>
              </div>
            )}
          </div>
          {blocksOpen && (
            // Over the canvas's top left, as in Live Preview: beside the surface, not in it, so the
            // surface's own pointer and wheel handling never sees the palette's.
            // The full height of the canvas, so the palette's height limit has something to be a share
            // of; only the palette itself takes the pointer.
            <div className="absolute left-2 right-2 top-0 bottom-2 z-20 pointer-events-none [&>div]:pointer-events-auto">
              <PalettePanel onDragStart={onBlockDragStart} onClose={() => setBlocksOpen(false)} collapsed={draggingBlock !== null} />
            </div>
          )}
          </div>
          <ElementMenu at={menu?.at ?? null} facts={menuFacts} onAction={(action) => { const on = menu?.on ?? null; setMenu(null); act(action, on); }} onClose={() => setMenu(null)} />
        </>
      )}
    </PanelContainer>
  );
});

/**
 * The selection's handles, in screen space: width, height and both from the corner; padding on each
 * side (Alt: all four); the gap between its first two children. The padding or gap a handle changes
 * shows hatched while it is pointed at or dragged.
 */
function Handles({ r, m, z, gap, show, onDown, onHover }: {
  r: Rect;
  m: SelectionMetrics;
  z: number;
  gap: Rect | null;
  show: string | null;
  onDown: (kind: string, e: React.PointerEvent) => void;
  onHover: (kind: string | null) => void;
}) {
  if (m.tag === 'hr') return null;
  const handle = (kind: string, x: number, y: number, style: React.CSSProperties, cursor: string) => (
    <div key={kind} data-osw-handle={kind} className="absolute pointer-events-auto box-border"
      style={{ left: x, top: y, transform: 'translate(-50%, -50%)', cursor, ...style }}
      onPointerDown={(e) => onDown(kind, e)} onPointerEnter={() => onHover(kind)} onPointerLeave={() => onHover(null)} />
  );
  const corner: React.CSSProperties = { width: 9, height: 9, background: '#fff', border: `1.5px solid ${SELECTION_SOLID}`, borderRadius: 2 };
  const bar = (w: number, h: number): React.CSSProperties => ({ width: w, height: h, background: SELECTION_SOLID, border: '1px solid #fff', borderRadius: 999 });
  const zone = (key: string, x: number, y: number, w: number, h: number) => (show === key ? (
    <div key={`zone-${key}`} className="absolute pointer-events-none"
      style={{ left: x, top: y, width: w, height: h, background: 'repeating-linear-gradient(45deg, rgba(99, 102, 241, 0.25) 0 3px, transparent 3px 7px)' }} />
  ) : null);
  const pt = m.pt * z, pr = m.pr * z, pb = m.pb * z, pl = m.pl * z;
  const pads = m.tag !== 'img' && r.w > 40 && r.h > 24;
  return (
    <>
      {pads && zone('pt', r.x, r.y, r.w, pt)}
      {pads && zone('pb', r.x, r.y + r.h - pb, r.w, pb)}
      {pads && zone('pl', r.x, r.y, pl, r.h)}
      {pads && zone('pr', r.x + r.w - pr, r.y, pr, r.h)}
      {gap && zone('gap', gap.x, gap.y, gap.w, gap.h)}
      {handle('e', r.x + r.w, r.y + r.h / 2, corner, 'ew-resize')}
      {handle('s', r.x + r.w / 2, r.y + r.h, corner, 'ns-resize')}
      {handle('se', r.x + r.w, r.y + r.h, corner, 'nwse-resize')}
      {/* Over the edge handles: with little padding the two overlap, and the edge handles' outer
          halves, outside the element, stay free to grab while the padding bars would not. */}
      {pads && handle('pt', r.x + r.w / 2, r.y + Math.max(pt / 2, 4), bar(16, 5), 'ns-resize')}
      {pads && handle('pb', r.x + r.w / 2, r.y + r.h - Math.max(pb / 2, 4), bar(16, 5), 'ns-resize')}
      {pads && handle('pl', r.x + Math.max(pl / 2, 4), r.y + r.h / 2, bar(5, 16), 'ew-resize')}
      {pads && handle('pr', r.x + r.w - Math.max(pr / 2, 4), r.y + r.h / 2, bar(5, 16), 'ew-resize')}
      {gap && handle('gap', gap.x + gap.w / 2, gap.y + gap.h / 2, m.gap?.across ? bar(5, 18) : bar(18, 5), m.gap?.across ? 'ew-resize' : 'ns-resize')}
    </>
  );
}

/** Where the dropper would put the new element: the parent's box, the line, and what goes into what. */
function DropMark({ box, line, bad, label }: { box: Rect; line: Rect; bad: boolean; label: string }) {
  const colour = bad ? REFUSED : SELECTION_SOLID;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <div className="absolute" style={{ left: box.x, top: box.y, width: box.w, height: box.h, outline: `1px dashed ${SELECTION}` }} />
      <div className="absolute rounded-sm" style={{ left: line.x, top: line.y, width: Math.max(line.w, 3), height: Math.max(line.h, 3), background: colour }} />
      <div className="absolute rounded px-1.5 font-mono text-[10px] leading-4 whitespace-nowrap"
        style={{ left: line.x, top: line.y + Math.max(line.h, 3) + 4, background: colour, color: bad ? '#000' : '#fff' }}>
        {label}
      </div>
    </div>
  );
}

/** The selection, the hover, the same element on the page's other widths, and the element toolbar: screen space. */
function Overlay({ hoverRect, selRect, twins, name, kind, onAction, onHoverAction, onTextAction }: {
  hoverRect: Rect | null;
  selRect: Rect | null;
  twins: Rect[];
  name: string | null;
  kind: ReturnType<typeof elementKind> | null;
  onAction: (action: ToolbarAction) => void;
  onHoverAction: (action: ToolbarAction | null) => void;
  /** Edit text types in place on Canvas, rather than in the popover Live Preview opens. */
  onTextAction: () => void;
}) {
  const t = useTranslations('canvas.toolbar');
  const box = (r: Rect, style: React.CSSProperties, key?: string | number) => (
    <div key={key} className="absolute pointer-events-none" style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...style }} />
  );
  const button = (action: ToolbarAction, Icon: typeof X, label: string) => (
    <Tip key={action} label={label} side="top">
      <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded-sm hover:bg-accent text-foreground" aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); if (action === 'text') onTextAction(); else onAction(action); }}
        onMouseEnter={action === 'style' ? () => onHoverAction('style') : undefined}
        onMouseLeave={action === 'style' ? () => onHoverAction(null) : undefined}>
        <Icon className="h-3.5 w-3.5" />
      </button>
    </Tip>
  );
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {twins.map((r, i) => box(r, { outline: `1px dashed ${SELECTION}`, outlineOffset: 0 }, `twin-${i}`))}
      {hoverRect && box(hoverRect, { outline: `1px solid ${SELECTION}`, background: 'rgba(99, 102, 241, 0.05)' })}
      {selRect && box(selRect, { outline: `2px solid ${SELECTION}`, boxShadow: '0 0 0 4px rgba(99, 102, 241, 0.25)' })}
      {selRect && name && (
        <div className="absolute pointer-events-auto flex items-center gap-0.5 rounded-md border bg-popover px-1 py-0.5 shadow-md"
          style={{ left: Math.max(4, selRect.x), top: Math.max(4, selRect.y - 34) }}
          onPointerDown={(e) => e.stopPropagation()}>
          <span className="pl-0.5 pr-1.5 mr-0.5 border-r font-mono text-[9px] text-muted-foreground max-w-[140px] truncate">{name}</span>
          {button('style', SlidersHorizontal, t('style'))}
          {kind === 'text' && button('text', Type, t('editText'))}
          {kind === 'image' && button('replace', ImagePlus, t('replaceImage'))}
          <span className="mx-0.5 h-4 w-px bg-border" />
          {button('include', MessageSquarePlus, t('include'))}
          {button('dismiss', X, t('dismiss'))}
        </div>
      )}
    </div>
  );
}
