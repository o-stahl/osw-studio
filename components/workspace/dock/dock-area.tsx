'use client';

import React, { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { PanelDockProvider, type PanelDockContext, type PanelDockHeader } from '@/components/ui/panel';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { layoutBox, layoutView } from '@/lib/stores/slices/layout';
import {
  checkLayout,
  findCell,
  findPanel,
  fold,
  geometry,
  HANDLE_PX,
  maximizedView,
  MIN_COLUMN_PX,
  minHeight,
  movePanel,
  PANEL_KEYS,
  planOpen,
  type Box,
  type DragSource,
  type DropTarget,
  type LayoutRefusal,
  type PanelKey,
  type WorkspaceLayout,
} from '@/lib/workspace-layout';
import { cn } from '@/lib/utils';
import { PANEL_INFO } from './panel-info';
import { PanelLayer } from './panel-layer';
import { PanelMenu, splitRightTarget } from './panel-menu';
import { DRAG_THRESHOLD, LONG_PRESS_MS, sameTarget, targetAt, type Gap, type Measure, type MeasuredCell, type Rect, type Region } from './drag';
import { keepWorkspaceFocus, LAYOUT_TOAST_ID, layoutShortcut, useLayoutCommands } from './use-layout-commands';
import { useDockText } from './use-dock-text';
import { isMac } from '@/lib/platform';
import { Tip } from '@/components/ui/tooltip';

type Badge = 'unread' | 'busy' | null;

interface DockAreaProps {
  /** Each open panel's content, by panel. */
  panels: Partial<Record<PanelKey, React.ReactNode>>;
  /** Quick edit: its fixed panels side by side, with no tabs, no dragging and no layout of its own to save. */
  quick: boolean;
  /** What a background tab shows: the console's unread output, the chat's run. */
  badges: Partial<Record<PanelKey, Badge>>;
}

/** The area's padding (`p-2`), for the boxes a layout gives before anything is measured. */
const PAD = 8;

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Quick edit's fixed panels as a layout: one column each. */
function quickLayout(keys: PanelKey[]): WorkspaceLayout {
  return {
    v: 1,
    columns: keys.map((key) => ({ id: `quick-${key}`, size: 100 / keys.length, cells: [{ id: `quick-cell-${key}`, size: 100, tabs: [key], active: key }] })),
  };
}

const structureOf = (l: WorkspaceLayout) => l.columns.map((c) => `${c.id}[${c.cells.map((x) => x.id).join(',')}]`).join('|');
const sizesOf = (l: WorkspaceLayout) => l.columns.map((c) => `${c.size.toFixed(2)}:${c.cells.map((x) => x.size.toFixed(2)).join(',')}`).join('|');

/** A drag under way, as far as anything renders it. */
interface DragView {
  source: DragSource;
  /** The panels it carries. */
  keys: PanelKey[];
  /** The one it is named by: the dragged panel, or a group's front tab. */
  front: PanelKey;
  sourceCell: string;
  target: DropTarget | null;
  next: WorkspaceLayout | null;
  refusal: LayoutRefusal | null;
  /** The group a tab has come off, as it will be without it. */
  behind: { cell: string; tabs: PanelKey[]; active: PanelKey } | null;
  /** The bars a new column can be made on. */
  bars: Gap[];
}

interface Press {
  source: DragSource;
  front: PanelKey;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  touch: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What the overlay draws over a cell: a drop's place, a rail button's, or a panel's outline. */
interface Preview {
  rect: Rect;
  panel: PanelKey;
  text: string | null;
  mode: 'stack' | 'tab' | 'refused' | 'outline';
}

/** Bars for new columns, drawn over the gaps, and the label beside the one in play. */
interface BarPreview {
  top: number;
  height: number;
  bars: { x: number; hot: boolean; refused: boolean }[];
  label: { x: number; text: string; panel: PanelKey; refused: boolean } | null;
}

/** Where the splitters' box starts inside the area: the area's padding. Layout geometry is relative to it. */
interface Pad {
  x: number;
  y: number;
}

function measureArea(area: HTMLElement, view: WorkspaceLayout): { m: Measure; origin: DOMRect; pad: Pad } {
  const origin = area.getBoundingClientRect();
  const style = getComputedStyle(area);
  const pad = { x: parseFloat(style.paddingLeft) || 0, y: parseFloat(style.paddingTop) || 0 };
  const rel = (r: DOMRect): Rect => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
  const cells: MeasuredCell[] = [];
  for (const col of view.columns) {
    for (const cell of col.cells) {
      const slot = area.querySelector<HTMLElement>(`[data-cell-slot="${cell.id}"]`);
      if (!slot) continue;
      const header = area.querySelector<HTMLElement>(`[data-panel-id="${cell.active}"] [data-panel-header]`);
      const handles = header
        ? Array.from(header.querySelectorAll<HTMLElement>('[role="tab"]:not([data-ghost])'))
        : [];
      const title = header?.querySelector<HTMLElement>('[data-panel-title]');
      const tabs = (handles.length ? handles : title ? [title] : []).map((el) => {
        const r = el.getBoundingClientRect();
        return { l: r.left - origin.left, r: r.right - origin.left };
      });
      cells.push({ ...rel(slot.getBoundingClientRect()), cell, head: header ? header.getBoundingClientRect().height : 37, tabs });
    }
  }
  const tops = view.columns.map((col) => cells.find((c) => c.cell.id === col.cells[0].id)).filter((c): c is MeasuredCell => !!c);
  const gaps: Gap[] = [];
  if (tops.length === view.columns.length && tops.length) {
    gaps.push({ before: view.columns[0].id, x: tops[0].x - 4, next: null, refusal: null });
    for (let i = 1; i < tops.length; i++) gaps.push({ before: view.columns[i].id, x: tops[i - 1].x + tops[i - 1].w + HANDLE_PX / 2, next: null, refusal: null });
    const last = tops[tops.length - 1];
    gaps.push({ before: null, x: last.x + last.w + 4, next: null, refusal: null });
  }
  return { m: { width: origin.width, height: origin.height, cells, gaps }, origin, pad };
}

export function DockArea({ panels, quick, badges: badgesProp }: DockAreaProps) {
  // A new object on every render of the workspace; kept while its contents are the same.
  const badgeKey = PANEL_KEYS.map((key) => badgesProp[key] ?? '').join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const badges = useMemo(() => badgesProp, [badgeKey]);
  const t = useTranslations('workspace.layout');
  const text = useDockText();
  const titles = text.titles;
  const commands = useLayoutCommands();
  const areaRef = useRef<HTMLDivElement>(null);

  const layout = useWorkspaceStore((s) => s.layout);
  const epoch = useWorkspaceStore((s) => s.layoutEpoch);
  const workspaceBox = useWorkspaceStore((s) => s.workspaceBox);
  const maximizedCell = useWorkspaceStore((s) => s.maximizedCell);
  const panelHint = useWorkspaceStore((s) => s.panelHint);
  const hintDone = useWorkspaceStore((s) => s.layoutHintDone);

  const keysSig = PANEL_KEYS.filter((key) => panels[key] !== undefined).join(',');
  const view = useMemo(() => {
    if (quick) return quickLayout(keysSig ? (keysSig.split(',') as PanelKey[]) : []);
    return fold(layout, layoutBox({ workspaceBox })).layout;
  }, [quick, keysSig, layout, workspaceBox]);
  const shown = useMemo(() => (!quick && maximizedCell && maximizedView(view, maximizedCell)) || view, [quick, maximizedCell, view]);
  // The splitters take their sizes from the layout only when they mount, so they are rebuilt for
  // every change but a divider drag. They hold nothing but empty slots, so that costs nothing.
  const groupKey = quick ? 'quick' : `${epoch}|${structureOf(shown)}${shown === layout ? '' : `|${sizesOf(shown)}`}`;

  const latest = useRef({ shown, view });
  latest.current = { shown, view };

  // ------------------------------------------------------------------ size of the area
  // Keyed by the store's setter: a store made again (a hot reload of its modules) starts without a
  // box, and the observer's first report fills it in.
  const setWorkspaceBox = useWorkspaceStore((s) => s.setWorkspaceBox);
  useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setWorkspaceBox({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setWorkspaceBox]);

  // ------------------------------------------------------------------ divider drags
  // Sizes change on every pointer move of a divider drag. They reach the store once the drag ends, so
  // the workspace does not render on every move; a keyboard resize has no drag and goes straight in.
  const resizing = useRef(false);
  const pending = useRef<{ columns: number[] | null; cells: Map<string, number[]> }>({ columns: null, cells: new Map() });
  const onColumns = useCallback((sizes: number[]) => {
    if (resizing.current) pending.current.columns = sizes;
    else useWorkspaceStore.getState().setColumnSizes(sizes);
  }, []);
  const onCells = useCallback((columnId: string, sizes: number[]) => {
    if (resizing.current) pending.current.cells.set(columnId, sizes);
    else useWorkspaceStore.getState().setCellSizes(columnId, sizes);
  }, []);
  const endResize = useRef(() => {});
  endResize.current = () => {
    if (!resizing.current) return;
    resizing.current = false;
    areaRef.current?.removeAttribute('data-resizing');
    window.removeEventListener('pointerup', endResizeListener, true);
    window.removeEventListener('pointercancel', endResizeListener, true);
    window.removeEventListener('blur', endResizeListener);
    const { columns, cells } = pending.current;
    pending.current = { columns: null, cells: new Map() };
    const store = useWorkspaceStore.getState();
    if (columns) store.setColumnSizes(columns);
    for (const [id, sizes] of cells) store.setCellSizes(id, sizes);
  };
  // The drag ends on the first release anywhere, whether or not the splitter hears it: left on, the
  // panels would stay unable to take a click.
  const endResizeListener = useCallback(() => endResize.current(), []);
  const onResizeDragging = useCallback((dragging: boolean) => {
    if (!dragging) {
      endResize.current();
      return;
    }
    resizing.current = true;
    // The preview's frame would take the pointer from a divider drag that crosses it.
    areaRef.current?.setAttribute('data-resizing', '');
    window.addEventListener('pointerup', endResizeListener, true);
    window.addEventListener('pointercancel', endResizeListener, true);
    window.addEventListener('blur', endResizeListener);
  }, [endResizeListener]);

  // ------------------------------------------------------------------ panel boxes
  const initialRect = useCallback((panel: PanelKey): Rect | null => {
    const l = latest.current.shown;
    const at = findPanel(l, panel);
    if (!at) return null;
    const g = geometry(l, layoutBox(useWorkspaceStore.getState())).cells.get(at.cell.id);
    return g ? { x: g.x + PAD, y: g.y + PAD, w: g.w, h: g.h } : null;
  }, []);
  const flipFrom = useRef<{ panel: PanelKey; rect: Rect } | null>(null);
  const [landed, setLanded] = useState<{ cell: string; at: number } | null>(null);

  // ------------------------------------------------------------------ dragging
  const [drag, setDrag] = useState<DragView | null>(null);
  const dragRef = useRef<DragView | null>(null);
  dragRef.current = drag;
  const press = useRef<Press | null>(null);
  const live = useRef<{ m: Measure; pad: Pad; region: Region; startX: number; startY: number; chip: HTMLDivElement } | null>(null);
  const suppressClick = useRef(false);
  const [barY, setBarY] = useState(0);

  const box = (): Box => layoutBox(useWorkspaceStore.getState());

  const makeChip = (front: PanelKey, count: number): HTMLDivElement => {
    const chip = document.createElement('div');
    chip.className = 'fixed z-[1000] pointer-events-none inline-flex items-center gap-2 h-[30px] px-2.5 rounded-lg border border-border bg-popover text-popover-foreground text-[13px] font-semibold shadow-[0_10px_28px_-10px_rgb(0_0_0/0.45)] translate-x-[14px] translate-y-[12px]';
    const icon = areaRef.current?.querySelector(`[data-panel-id="${front}"] [data-panel-icon], [data-panel-tab="${front}"] [data-panel-icon]`);
    if (icon) {
      const clone = icon.cloneNode(true) as SVGElement;
      clone.setAttribute('class', 'h-[15px] w-[15px] shrink-0');
      clone.style.color = PANEL_INFO[front].color;
      chip.append(clone);
    }
    const label = document.createElement('span');
    label.textContent = titles[front];
    chip.append(label);
    if (count > 1) {
      const more = document.createElement('span');
      more.className = 'font-medium text-muted-foreground';
      more.textContent = `+${count - 1}`;
      chip.append(more);
    }
    document.body.append(chip);
    return chip;
  };

  const moveDrag = (cx: number, cy: number) => {
    const d = dragRef.current;
    const run = live.current;
    const area = areaRef.current;
    if (!d || !run || !area) return;
    run.chip.style.left = `${cx}px`;
    run.chip.style.top = `${cy}px`;
    const origin = area.getBoundingClientRect();
    const x = cx - origin.left;
    const y = cy - origin.top;
    const { target, region } = targetAt(run.m, x, y, { source: d.source, sourceCell: d.sourceCell, prev: run.region });
    run.region = region;
    if (target?.kind === 'column') setBarY(Math.max(24, Math.min(run.m.height - 24, y)));
    if (sameTarget(target, d.target)) return;
    const { view: base } = latest.current;
    const recent = useWorkspaceStore.getState().recentPanels;
    const gap = target?.kind === 'column' ? run.m.gaps.find((g) => g.before === target.before) : null;
    const next = !target ? null : gap ? gap.next : movePanel(base, d.source, target, box(), { recent });
    const refusal = gap ? gap.refusal : next ? checkLayout(next, box()) : null;
    // Once a tab comes off its group, the group shows what stays: the rest, with the right tab in front.
    let behind: DragView['behind'] = null;
    if ('panel' in d.source && next) {
      const source = findCell(base, d.sourceCell);
      const after = findCell(next, d.sourceCell);
      if (source && source.cell.tabs.length > 1 && after && !after.cell.tabs.includes(d.source.panel)) {
        behind = { cell: d.sourceCell, tabs: after.cell.tabs, active: after.cell.active };
      }
    }
    const updated = { ...d, target, next, refusal, behind };
    dragRef.current = updated;
    setDrag(updated);
  };

  const finish = (drop: boolean) => {
    const d = dragRef.current;
    const run = live.current;
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    press.current = null;
    detach();
    if (!d || !run) return;
    live.current = null;
    document.documentElement.classList.remove('dock-dragging');
    areaRef.current?.removeAttribute('data-dock-dragging');
    dragRef.current = null;
    setDrag(null);
    const chip = run.chip;
    if (drop && d.target && d.next && !d.refusal) {
      const area = areaRef.current?.getBoundingClientRect();
      const r = chip.getBoundingClientRect();
      if (area) flipFrom.current = { panel: d.front, rect: { x: r.left - area.left, y: r.top - area.top, w: r.width, h: r.height } };
      chip.remove();
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
      if (commands.move(d.source, d.target)) {
        useWorkspaceStore.getState().dismissLayoutHint();
        const at = findPanel(d.next, d.front);
        if (at) setLanded({ cell: at.cell.id, at: Date.now() });
      }
      return;
    }
    if (drop) {
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
    }
    // A cancelled drag's chip slides back to where it was picked up.
    if (reducedMotion() || typeof chip.animate !== 'function') {
      chip.remove();
      return;
    }
    const dx = run.startX - parseFloat(chip.style.left || '0');
    const dy = run.startY - parseFloat(chip.style.top || '0');
    const animation = chip.animate(
      [{ transform: 'translate(14px, 12px)', opacity: 1 }, { transform: `translate(${14 + dx}px, ${12 + dy}px)`, opacity: 0 }],
      { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    );
    animation.onfinish = () => chip.remove();
  };

  const start = (cx: number, cy: number) => {
    const p = press.current;
    const area = areaRef.current;
    if (!p || !area || dragRef.current) return;
    const { view: base } = latest.current;
    const at = findPanel(base, p.front);
    if (!at) return;
    const store = useWorkspaceStore.getState();
    store.setPanelHint(null);
    // The last change's toast sits at the foot of the workspace, over where drops land. Ctrl+Z still
    // takes that change back.
    toast.dismiss(LAYOUT_TOAST_ID);
    const { m, pad } = measureArea(area, base);
    m.gaps = m.gaps.map((g) => {
      const next = movePanel(base, p.source, { kind: 'column', before: g.before }, box(), { recent: store.recentPanels });
      return { ...g, next, refusal: next ? checkLayout(next, box()) : null };
    });
    const keys = 'panel' in p.source ? [p.source.panel] : [...findCell(base, p.source.cell)!.cell.tabs];
    const chip = makeChip(p.front, keys.length);
    live.current = { m, pad, region: null, startX: p.x, startY: p.y, chip };
    document.documentElement.classList.add('dock-dragging');
    area.setAttribute('data-dock-dragging', '');
    const view: DragView = { source: p.source, keys, front: p.front, sourceCell: at.cell.id, target: null, next: null, refusal: null, behind: null, bars: m.gaps.filter((g) => g.next) };
    dragRef.current = view;
    setDrag(view);
    moveDrag(cx, cy);
  };

  // Window listeners for a press, so the pointer is followed wherever it goes. The handlers close
  // over this render's functions, so they are replaced on every render; the listeners stay the same.
  const handlers = useRef<{ move: (e: PointerEvent) => void; up: () => void; cancel: () => void; key: (e: KeyboardEvent) => void }>({
    move: () => {},
    up: () => {},
    cancel: () => {},
    key: () => {},
  });
  handlers.current.move = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (!dragRef.current) {
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.touch) {
        // A touch that moves before the long press is a scroll or a swipe, not a drag.
        if (moved > 8) {
          if (p.timer) clearTimeout(p.timer);
          press.current = null;
          detach();
        }
        return;
      }
      if (moved < DRAG_THRESHOLD) return;
      start(e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    moveDrag(e.clientX, e.clientY);
  };
  handlers.current.up = () => finish(true);
  handlers.current.cancel = () => finish(false);
  handlers.current.key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dragRef.current) {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };

  const listeners = useRef({
    move: (e: PointerEvent) => handlers.current.move(e),
    up: () => handlers.current.up(),
    cancel: () => handlers.current.cancel(),
    key: (e: KeyboardEvent) => handlers.current.key(e),
  });
  const attach = () => {
    window.addEventListener('pointermove', listeners.current.move, { passive: false });
    window.addEventListener('pointerup', listeners.current.up);
    window.addEventListener('pointercancel', listeners.current.cancel);
    window.addEventListener('keydown', listeners.current.key, true);
  };
  function detach() {
    window.removeEventListener('pointermove', listeners.current.move);
    window.removeEventListener('pointerup', listeners.current.up);
    window.removeEventListener('pointercancel', listeners.current.cancel);
    window.removeEventListener('keydown', listeners.current.key, true);
  }
  useEffect(() => () => {
    detach();
    live.current?.chip.remove();
    document.documentElement.classList.remove('dock-dragging');
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>, panelKey: string, group: boolean) => {
    if (event.button !== 0 || dragRef.current || press.current || resizing.current) return;
    const store = useWorkspaceStore.getState();
    if (store.maximizedCell) return;
    const at = findPanel(latest.current.view, panelKey as PanelKey);
    if (!at) return;
    const source: DragSource = group && at.cell.tabs.length > 1 ? { cell: at.cell.id } : { panel: panelKey as PanelKey };
    const touch = event.pointerType === 'touch';
    const p: Press = {
      source,
      front: group ? at.cell.active : (panelKey as PanelKey),
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      touch,
      timer: null,
    };
    press.current = p;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
    if (touch) {
      // On a touch screen a long press starts the drag, so a tap or a swipe never moves anything.
      p.timer = setTimeout(() => {
        if (press.current === p && !dragRef.current) start(p.lastX, p.lastY);
      }, LONG_PRESS_MS);
    }
    attach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ header context
  const onActivate = useCallback((panelKey: string) => {
    if (!findPanel(latest.current.view, panelKey as PanelKey)) return;
    // Every panel in a group draws the strip, and only the front one's is on screen: the tab that had
    // focus goes inert with its panel, so focus follows to the same tab in the new front's strip.
    const fromStrip = !!document.activeElement?.closest('[role="tablist"]');
    useWorkspaceStore.getState().activatePanel(panelKey as PanelKey);
    setTimeout(() => {
      const tab = areaRef.current?.querySelector<HTMLElement>(`[data-panel-id="${panelKey}"] [data-panel-tab="${panelKey}"]`);
      if (fromStrip && tab) tab.focus({ preventScroll: true });
      else keepWorkspaceFocus();
    }, 0);
  }, []);
  const onToggleMaximize = useCallback((panelKey: string) => {
    if (dragRef.current) return;
    const at = findPanel(latest.current.view, panelKey as PanelKey);
    if (at) useWorkspaceStore.getState().toggleMaximize(at.cell.id);
    keepWorkspaceFocus();
  }, []);
  const consumeClick = useCallback(() => suppressClick.current, []);

  const tabOf = useCallback((key: PanelKey) => ({
    key,
    title: titles[key],
    icon: PANEL_INFO[key].icon,
    color: PANEL_INFO[key].color,
    badge: badges[key] ?? null,
  }), [titles, badges]);

  const dock = useMemo<PanelDockContext | null>(() => {
    if (quick) return null;
    const header = (panelKey: string): PanelDockHeader | null => {
      const at = findPanel(shown, panelKey as PanelKey);
      if (!at) return null;
      let tabs: PanelKey[] = at.cell.tabs;
      let active: PanelKey = at.cell.active;
      let ghosts: PanelKey[] = [];
      if (drag?.behind && drag.behind.cell === at.cell.id) {
        tabs = drag.behind.tabs;
        active = drag.behind.active;
      }
      if (drag?.target?.kind === 'tab' && drag.target.cell === at.cell.id && drag.next && !drag.refusal) {
        const into = findPanel(drag.next, drag.front);
        if (into) {
          tabs = into.cell.tabs;
          ghosts = drag.keys;
        }
      }
      return {
        tabs: tabs.map(tabOf),
        active,
        ghosts,
        dragging: drag ? drag.keys : [],
        maximized: maximizedCell === at.cell.id,
      };
    };
    return { header, onPointerDown, onActivate, onToggleMaximize, Menu: PanelMenu, consumeClick };
  }, [quick, shown, drag, tabOf, maximizedCell, onPointerDown, onActivate, onToggleMaximize, consumeClick]);

  // ------------------------------------------------------------------ keyboard
  const splitRightCurrent = useRef<() => void>(() => {});
  const currentCell = useRef<string | null>(null);
  splitRightCurrent.current = () => {
    const store = useWorkspaceStore.getState();
    const base = layoutView(store);
    // The panel with focus, else the one last pressed, else the first.
    const focused = document.activeElement?.closest('[data-panel-id]')?.getAttribute('data-panel-id');
    const focusedCell = focused ? findPanel(base, focused as PanelKey)?.cell : null;
    const cell = focusedCell || (currentCell.current && findCell(base, currentCell.current)?.cell) || base.columns[0]?.cells[0];
    if (!cell) return;
    const key = cell.active;
    const target = splitRightTarget(base, key)!;
    const next = movePanel(base, { panel: key }, target, box(), { recent: store.recentPanels });
    const refusal = next ? checkLayout(next, box()) : null;
    if (next && !refusal) commands.move({ panel: key }, target, t('toast.movedToColumn', { panel: titles[key] }));
    else commands.say(refusal ? text.refusal(refusal) : t('toast.alreadyOwnColumn', { panel: titles[key] }));
  };

  useEffect(() => {
    if (quick) return;
    const onKey = (e: KeyboardEvent) => {
      const action = layoutShortcut(e, document.activeElement, isMac());
      if (action === 'restore') {
        const store = useWorkspaceStore.getState();
        if (!dragRef.current && store.maximizedCell) {
          e.preventDefault();
          store.toggleMaximize(null);
        }
      } else if (action === 'undo') {
        e.preventDefault();
        commands.undo();
      } else if (action === 'split-right') {
        e.preventDefault();
        splitRightCurrent.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quick, commands]);

  const trackCell = useCallback((event: React.PointerEvent) => {
    const panel = (event.target as HTMLElement).closest?.('[data-panel-id]')?.getAttribute('data-panel-id');
    const at = panel ? findPanel(latest.current.view, panel as PanelKey) : null;
    if (at) currentCell.current = at.cell.id;
  }, []);

  // ------------------------------------------------------------------ previews
  const [measured, setMeasured] = useState<{ m: Measure; pad: Pad; key: string } | null>(null);
  const measureKey = `${groupKey}|${workspaceBox?.w ?? 0}x${workspaceBox?.h ?? 0}|${panelHint ? `${panelHint.kind}:${panelHint.panel}` : ''}|${hintDone ? 1 : 0}|${landed?.at ?? 0}`;
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || quick) return;
    const needs = !!panelHint || !hintDone || !!landed;
    if (!needs) {
      if (measured) setMeasured(null);
      return;
    }
    const { m, pad } = measureArea(area, shown);
    setMeasured({ m, pad, key: measureKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureKey, quick]);

  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), 800);
    return () => clearTimeout(timer);
  }, [landed]);

  const cellRect = (m: Measure, id: string): Rect | null => {
    const c = m.cells.find((x) => x.cell.id === id);
    return c ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
  };

  /**
   * Where the drop puts the panel. A tab joins the panel under the pointer, so that panel is the
   * preview. A stack's height and place come from the layout the drop makes, since a panel moved
   * within its own column hands its height back to the column before the split. Its width stays the
   * column's, as it is now. A new column is the column in that layout. A refused drop makes no
   * layout, so it greys the cell.
   */
  const dropRect = (m: Measure, pad: Pad, next: WorkspaceLayout, front: PanelKey, target: DropTarget, refused: boolean): Rect | null => {
    if (target.kind !== 'column' && (refused || target.kind === 'tab')) return cellRect(m, target.cell);
    const landedAt = findPanel(next, front);
    const c = landedAt ? geometry(next, box()).cells.get(landedAt.cell.id) : undefined;
    if (!c) return null;
    if (target.kind === 'column') return { x: c.x + pad.x, y: c.y + pad.y, w: c.w, h: c.h };
    const r = cellRect(m, target.cell);
    return r ? { x: r.x, y: c.y + pad.y, w: r.w, h: c.h } : null;
  };

  let preview: Preview | null = null;
  let barPreview: BarPreview | null = null;
  const runM = live.current?.m;
  if (drag && runM) {
    const hotBefore = drag.target?.kind === 'column' ? drag.target.before : undefined;
    const top = runM.cells.length ? Math.min(...runM.cells.map((c) => c.y)) : PAD;
    const bottom = runM.cells.length ? Math.max(...runM.cells.map((c) => c.y + c.h)) : runM.height - PAD;
    const hot = drag.bars.find((g) => g.before === hotBefore);
    barPreview = {
      top,
      height: bottom - top,
      bars: drag.bars.map((g) => ({ x: g.x, hot: g.before === hotBefore && !g.refusal, refused: !!g.refusal })),
      label: hot && drag.target ? {
        x: hot.x,
        text: hot.refusal ? text.refusal(hot.refusal) : text.target(latest.current.view, drag.target, drag.source),
        panel: drag.front,
        refused: !!hot.refusal,
      } : null,
    };
    if (drag.target && drag.target.kind !== 'column' && drag.next) {
      const rect = dropRect(runM, live.current!.pad, drag.next, drag.front, drag.target, !!drag.refusal);
      const frontAfter = drag.behind ? { cell: drag.behind.cell, panel: drag.behind.active } : null;
      if (rect) {
        preview = {
          rect,
          panel: drag.front,
          text: drag.refusal ? text.refusal(drag.refusal) : text.target(latest.current.view, drag.target, drag.source, frontAfter),
          mode: drag.refusal ? 'refused' : drag.target.kind === 'tab' ? 'tab' : 'stack',
        };
      }
    }
  } else if (panelHint && measured && !quick) {
    const m = measured.m;
    const store = useWorkspaceStore.getState();
    const key = panelHint.panel;
    const at = findPanel(shown, key);
    const hiddenByMax = !at && !!findPanel(view, key);
    if (at && (at.cell.active === key || panelHint.kind === 'outline')) {
      const rect = cellRect(m, at.cell.id);
      if (rect) {
        preview = panelHint.kind === 'rail' && at.cell.active === key
          ? { rect, panel: key, text: t('rail.close', { panel: titles[key] }), mode: 'outline' }
          : { rect, panel: key, text: null, mode: 'outline' };
      }
    } else if (at || hiddenByMax) {
      const cell = at ? at.cell.id : findPanel(view, key)!.cell.id;
      const rect = cellRect(m, cell) ?? (shown.columns[0] ? cellRect(m, shown.columns[0].cells[0].id) : null);
      if (rect && panelHint.kind !== 'outline') preview = { rect, panel: key, text: t('rail.front', { panel: titles[key] }), mode: 'tab' };
    } else if (panelHint.kind !== 'outline') {
      const plan = planOpen(view, key, box(), { lastPlace: store.lastPlace[key], recent: store.recentPanels });
      const target = plan?.target;
      if (plan && target?.kind === 'column') {
        const gap = m.gaps.find((g) => g.before === target.before);
        const top = m.cells.length ? Math.min(...m.cells.map((c) => c.y)) : PAD;
        const bottom = m.cells.length ? Math.max(...m.cells.map((c) => c.y + c.h)) : m.height - PAD;
        if (gap) barPreview = { top, height: bottom - top, bars: [{ x: gap.x, hot: true, refused: false }], label: { x: gap.x, text: t('rail.openColumn'), panel: key, refused: false } };
      } else if (plan && target) {
        const rect = dropRect(m, measured.pad, plan.layout, key, target, plan.refused);
        const name = target.kind !== 'column' ? titles[findCell(view, target.cell)?.cell.active ?? key] : '';
        const label = target.kind === 'tab' ? t('rail.openTab', { panel: name }) : target.kind === 'stack' ? t(target.side === 'above' ? 'rail.openAbove' : 'rail.openBelow', { panel: name }) : t('rail.openColumn');
        if (rect) preview = { rect, panel: key, text: label, mode: target.kind === 'tab' ? 'tab' : 'stack' };
      } else if (plan && !target) {
        const { pad } = measured;
        preview = { rect: { x: pad.x, y: pad.y, w: m.width - 2 * pad.x, h: m.height - 2 * pad.y }, panel: key, text: t('rail.openColumn'), mode: 'stack' };
      }
    }
  }

  const sourceRect = drag && runM ? cellRect(runM, drag.sourceCell) : null;
  const landedRect = landed && measured ? cellRect(measured.m, landed.cell) : null;

  // The one-time tip, while two or more cells are on screen. It hangs under a panel's title, and so
  // covers the top of that panel: never the chat's conversation, and the preview's toolbar only when
  // nothing else is on screen.
  const cellCount = shown.columns.reduce((n, col) => n + col.cells.length, 0);
  const tipCandidates = measured ? measured.m.cells.filter((c) => c.cell.active !== 'chat') : [];
  const tipCell = !quick && !hintDone && !drag && !maximizedCell && cellCount >= 2
    ? tipCandidates.find((c) => c.cell.active !== 'preview') ?? tipCandidates[0] ?? null
    : null;

  return (
    <div
      ref={areaRef}
      className="relative flex-1 p-2 overflow-hidden"
      data-tour-id="workspace-panels"
      data-dock-area=""
      onPointerDownCapture={quick ? undefined : trackCell}
    >
      <ResizablePanelGroup
        key={groupKey}
        direction="horizontal"
        autoSaveId={quick ? 'quick-edit-slots' : undefined}
        onLayout={quick ? undefined : onColumns}
      >
        {shown.columns.map((col, i) => {
          const usableW = (workspaceBox?.w ?? 1200) - (shown.columns.length - 1) * HANDLE_PX;
          const minWidth = Math.min((MIN_COLUMN_PX / usableW) * 100, 100 / shown.columns.length);
          const usableH = (workspaceBox?.h ?? 700) - (col.cells.length - 1) * HANDLE_PX;
          return (
            <Fragment key={col.id}>
              {i > 0 && <ResizableHandle withHandle onDragging={onResizeDragging} />}
              <ResizablePanel
                // Quick edit keeps the ids its saved sizes ('quick-edit-slots') are keyed by.
                id={quick ? `panel-${col.cells[0].active}` : col.id}
                order={i + 1}
                defaultSize={col.size}
                minSize={minWidth}
              >
                {/* A vertical group even for one cell, so a stack can be added without rebuilding the column. */}
                <ResizablePanelGroup direction="vertical" onLayout={quick ? undefined : (sizes) => onCells(col.id, sizes)}>
                  {col.cells.map((cell, j) => (
                    <Fragment key={cell.id}>
                      {j > 0 && <ResizableHandle withHandle onDragging={onResizeDragging} />}
                      <ResizablePanel
                        id={cell.id}
                        order={j + 1}
                        defaultSize={cell.size}
                        minSize={col.cells.length > 1 ? Math.min((minHeight(cell) / usableH) * 100, 100 / col.cells.length) : undefined}
                      >
                        <div className="h-full" data-cell-slot={cell.id} />
                      </ResizablePanel>
                    </Fragment>
                  ))}
                </ResizablePanelGroup>
              </ResizablePanel>
            </Fragment>
          );
        })}
      </ResizablePanelGroup>

      <PanelDockProvider value={dock}>
        <PanelLayer
          panels={panels}
          shown={shown}
          motionKey={groupKey}
          areaRef={areaRef}
          behind={drag?.behind ? { cell: drag.behind.cell, active: drag.behind.active } : null}
          initialRect={initialRect}
          flipFrom={flipFrom}
        />
      </PanelDockProvider>

      {drag && <div className="absolute inset-0 z-30" aria-hidden="true" />}

      {sourceRect && (
        <div
          className={cn('absolute z-40 pointer-events-none rounded-xl border border-dashed', drag?.next ? 'border-muted-foreground' : 'border-primary')}
          style={{ left: sourceRect.x, top: sourceRect.y, width: sourceRect.w, height: sourceRect.h }}
        />
      )}

      {preview && (
        <div
          className={cn(
            'absolute z-40 pointer-events-none flex items-center justify-center rounded-xl border border-dashed motion-safe:transition-[left,top,width,height] motion-safe:duration-[120ms] ease-out',
            preview.mode === 'stack' && 'border-primary/65 bg-primary/15',
            preview.mode === 'tab' && 'border-primary/65 bg-primary/5',
            preview.mode === 'refused' && 'border-muted-foreground bg-muted/70',
            preview.mode === 'outline' && 'border-primary bg-transparent',
          )}
          style={{ left: preview.rect.x, top: preview.rect.y, width: preview.rect.w, height: preview.rect.h }}
        >
          {preview.text && <DropChip panel={preview.panel} text={preview.text} refused={preview.mode === 'refused'} />}
        </div>
      )}

      {barPreview && (
        <div className="absolute inset-0 z-40 pointer-events-none" aria-hidden="true">
          {barPreview.bars.map((bar) => (
            <div key={bar.x} className="absolute flex w-4 justify-center" style={{ left: bar.x - 8, top: barPreview!.top, height: barPreview!.height }}>
              <div
                className={cn(
                  'h-full shrink-0 rounded-[3px] border border-dashed animate-expand-indicator',
                  bar.hot ? 'bg-primary/40 border-primary/60' : 'bg-muted/50 border-muted-foreground',
                  bar.refused && 'opacity-45',
                )}
              />
            </div>
          ))}
          {barPreview.label && (
            <div
              className="absolute"
              style={{
                left: barPreview.label.x,
                top: drag ? barY : barPreview.top + barPreview.height / 2,
                transform: barPreview.label.x > (runM?.width ?? measured?.m.width ?? 0) / 2 ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
              }}
            >
              <DropChip panel={barPreview.label.panel} text={barPreview.label.text} refused={barPreview.label.refused} free />
            </div>
          )}
        </div>
      )}

      {landedRect && (
        <div
          className="absolute z-40 pointer-events-none rounded-xl ring-2 ring-primary/65 animate-[dock-landed_700ms_ease-out_forwards] motion-reduce:hidden"
          style={{ left: landedRect.x, top: landedRect.y, width: landedRect.w, height: landedRect.h }}
        />
      )}

      {tipCell && (
        <div
          role="note"
          className="absolute z-20 flex max-w-[300px] items-start gap-2 rounded-md border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))] px-3 py-1.5 text-xs text-primary shadow-md animate-in fade-in-0"
          style={{ left: tipCell.x + 12, top: tipCell.y + tipCell.head + 10 }}
        >
          <p className="flex-1 leading-snug text-balance">{t('hint')}</p>
          <Tip label={t('hintDismiss')}>
            <button
              type="button"
              onClick={() => useWorkspaceStore.getState().dismissLayoutHint()}
              aria-label={t('hintDismiss')}
              className="-mr-1 shrink-0 rounded p-0.5 opacity-80 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tip>
          <span aria-hidden="true" className="absolute bottom-full left-5 size-2.5 translate-y-1/2 rotate-45 rounded-[2px] border-l border-t border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))]" />
        </div>
      )}
    </div>
  );
}

/**
 * A drop's label. Inside a preview it is kept within the preview's width; beside a bar its box is
 * sized by the chip itself, so a percentage limit there would only clip it (`free`).
 */
function DropChip({ panel, text, refused, free = false }: { panel: PanelKey; text: string; refused: boolean; free?: boolean }) {
  const Icon = PANEL_INFO[panel].icon;
  return (
    <span data-drop-chip="" className={cn(
      'inline-flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-[5px] text-xs font-medium leading-tight shadow-[0_6px_18px_-8px_rgb(0_0_0/0.35)]',
      !free && 'max-w-[calc(100%-16px)]',
      refused ? 'text-muted-foreground' : 'text-popover-foreground',
    )}>
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: refused ? 'var(--muted-foreground)' : PANEL_INFO[panel].color }} />
      <span className="truncate">{text}</span>
    </span>
  );
}
