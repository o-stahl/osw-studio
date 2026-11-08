import { HANDLE_PX, MIN_COLUMN_PX, MIN_HEIGHT_PX, PANEL_KEYS } from './types';
import type { Box, DragSource, DropTarget, LayoutCell, LayoutColumn, LayoutRefusal, PanelKey, WorkspaceLayout } from './types';

/**
 * Operations on a workspace layout. Every one takes a layout and returns a new one, so a drop can be
 * tried out (to preview it or refuse it) before anything changes.
 */

export const isPanelKey = (key: unknown): key is PanelKey =>
  typeof key === 'string' && (PANEL_KEYS as readonly string[]).includes(key);

const copy = (layout: WorkspaceLayout): WorkspaceLayout => JSON.parse(JSON.stringify(layout));

const total = (list: { size: number }[]) => list.reduce((sum, item) => sum + item.size, 0);

export interface IdMaker {
  (prefix: 'col' | 'cell'): string;
  /** The highest number handed out so far. */
  readonly seq: number;
}

/** Ids for new columns and cells, numbered past the highest one the layout has or has had. */
export function idMaker(layout: WorkspaceLayout): IdMaker {
  let n = layout.seq ?? 0;
  const see = (id: string) => {
    const match = /(\d+)$/.exec(id);
    if (match) n = Math.max(n, Number(match[1]));
  };
  for (const col of layout.columns) {
    see(col.id);
    for (const cell of col.cells) see(cell.id);
  }
  const make = (prefix: 'col' | 'cell') => `${prefix}${++n}`;
  return Object.defineProperty(make, 'seq', { get: () => n }) as IdMaker;
}

export interface PanelPlace {
  col: LayoutColumn;
  cell: LayoutCell;
  /** The panel's position in the cell's strip. */
  index: number;
}

export function findPanel(layout: WorkspaceLayout, key: PanelKey): PanelPlace | null {
  for (const col of layout.columns) {
    for (const cell of col.cells) {
      const index = cell.tabs.indexOf(key);
      if (index >= 0) return { col, cell, index };
    }
  }
  return null;
}

export function findCell(layout: WorkspaceLayout, id: string): { col: LayoutColumn; cell: LayoutCell; index: number } | null {
  for (const col of layout.columns) {
    const index = col.cells.findIndex((cell) => cell.id === id);
    if (index >= 0) return { col, cell: col.cells[index], index };
  }
  return null;
}

export function findColumn(layout: WorkspaceLayout, id: string): { col: LayoutColumn; index: number } | null {
  const index = layout.columns.findIndex((col) => col.id === id);
  return index >= 0 ? { col: layout.columns[index], index } : null;
}

/** The open panels, left to right, top to bottom, tabs in strip order. */
export function openPanels(layout: WorkspaceLayout): PanelKey[] {
  return layout.columns.flatMap((col) => col.cells.flatMap((cell) => cell.tabs));
}

/** The Inspector picks elements in a visible preview, so the two may stack but never share a tab group. */
export const tabsConflict = (tabs: readonly PanelKey[]): boolean => tabs.includes('elements') && tabs.includes('preview');

/** A cell is as short as its tallest-needing panel allows. */
export const minHeight = (cell: LayoutCell): number => Math.max(...cell.tabs.map((key) => MIN_HEIGHT_PX[key]));

/** The tab that comes forward when the front one leaves: the one most recently in front, else its left neighbour. */
function nextFront(tabs: PanelKey[], leftIndex: number, recent: readonly PanelKey[] | undefined): PanelKey {
  if (recent) {
    const rank = (key: PanelKey) => {
      const i = recent.indexOf(key);
      return i < 0 ? Infinity : i;
    };
    const best = [...tabs].sort((a, b) => rank(a) - rank(b))[0];
    if (rank(best) !== Infinity) return best;
  }
  return tabs[Math.max(0, leftIndex - 1)];
}

/** Takes a column out. The column to its left takes its width, else the one to its right, unless it is moving whole. */
function removeColumn(layout: WorkspaceLayout, index: number, keepWidths: boolean): LayoutColumn {
  const [gone] = layout.columns.splice(index, 1);
  if (!keepWidths && layout.columns.length) layout.columns[Math.max(0, index - 1)].size += gone.size;
  return gone;
}

/** Takes a cell out. The cell above takes its height, else the one below; the last cell takes its column with it. */
function removeCell(layout: WorkspaceLayout, col: LayoutColumn, index: number, keepWidths: boolean): LayoutColumn | null {
  const [gone] = col.cells.splice(index, 1);
  if (col.cells.length) {
    col.cells[Math.max(0, index - 1)].size += gone.size;
    return null;
  }
  return removeColumn(layout, layout.columns.indexOf(col), keepWidths);
}

interface Detached {
  tabs: PanelKey[];
  active: PanelKey;
  /**
   * Set when the item was a whole column going to a column target. It keeps its width, and its ids,
   * which key what renders it: with new ones its panels would be mounted again and lose their state.
   */
  whole?: { column: string; cell: string; size: number };
}

/** Takes the dragged panel or cell out of the layout and returns it in cell shape. */
function detach(layout: WorkspaceLayout, source: DragSource, toColumn: boolean, recent: readonly PanelKey[] | undefined): Detached | null {
  if ('panel' in source) {
    const at = findPanel(layout, source.panel);
    if (!at) return null;
    at.cell.tabs.splice(at.index, 1);
    if (at.cell.active === source.panel && at.cell.tabs.length) at.cell.active = nextFront(at.cell.tabs, at.index, recent);
    let whole: Detached['whole'];
    if (!at.cell.tabs.length) {
      const goneColumn = removeCell(layout, at.col, at.col.cells.indexOf(at.cell), toColumn);
      if (goneColumn && toColumn) whole = { column: goneColumn.id, cell: at.cell.id, size: goneColumn.size };
    }
    return { tabs: [source.panel], active: source.panel, whole };
  }
  const at = findCell(layout, source.cell);
  if (!at) return null;
  const goneColumn = removeCell(layout, at.col, at.index, toColumn);
  const whole = goneColumn && toColumn ? { column: goneColumn.id, cell: at.cell.id, size: goneColumn.size } : undefined;
  return { tabs: [...at.cell.tabs], active: at.cell.active, whole };
}

/**
 * Puts a cell-shaped item at a target; false when the target is gone. Sizes are worked out in pixels
 * so that nothing is pushed under its minimum while there is room elsewhere, and the space comes from
 * the neighbours first. Whatever still doesn't fit is left for `checkLayout` to refuse.
 */
function place(layout: WorkspaceLayout, item: Detached, target: DropTarget, box: Box, newId: (prefix: 'col' | 'cell') => string): boolean {
  if (target.kind === 'tab') {
    const at = findCell(layout, target.cell);
    if (!at) return false;
    const index = target.index === null ? at.cell.tabs.length : Math.max(0, Math.min(target.index, at.cell.tabs.length));
    at.cell.tabs.splice(index, 0, ...item.tabs);
    at.cell.active = item.active;
    return true;
  }
  if (target.kind === 'stack') {
    const at = findCell(layout, target.cell);
    if (!at) return false;
    // Half the target's height, unless that would take the target under its minimum.
    const usable = box.h - at.col.cells.length * HANDLE_PX;
    const targetPx = (usable * at.cell.size) / total(at.col.cells);
    let newPx = Math.min(targetPx / 2, targetPx - minHeight(at.cell));
    newPx = Math.max(newPx, Math.max(...item.tabs.map((key) => MIN_HEIGHT_PX[key])));
    const share = Math.min((at.cell.size * newPx) / targetPx, at.cell.size * 0.95);
    at.cell.size -= share;
    at.col.cells.splice(at.index + (target.side === 'below' ? 1 : 0), 0, { id: newId('cell'), size: share, tabs: item.tabs, active: item.active });
    return true;
  }
  const index = target.before === null ? layout.columns.length : layout.columns.findIndex((col) => col.id === target.before);
  if (index < 0) return false;
  const sum = total(layout.columns) || 100;
  // A column moved whole keeps its width and the others keep theirs.
  let share = item.whole?.size;
  if (!share) {
    // An even share of the row, from the columns either side of it first, then the next ones out.
    // Each column gives down to an even share before any is taken further, towards its minimum, so a
    // neighbour is not squeezed while a column further out is still wide.
    const n = layout.columns.length;
    const usable = box.w - n * HANDLE_PX;
    const want = usable / (n + 1);
    const widths = layout.columns.map((col) => (usable * col.size) / sum);
    const give = widths.map(() => 0);
    let need = want;
    for (const floor of [Math.max(want, MIN_COLUMN_PX), MIN_COLUMN_PX]) {
      for (let d = 0; need > 0.5 && d < n; d++) {
        const ring = [index - 1 - d, index + d].filter((i) => i >= 0 && i < n);
        const spare = ring.map((i) => Math.max(0, widths[i] - floor - give[i]));
        const room = spare.reduce((a, b) => a + b, 0);
        if (room <= 0) continue;
        const take = Math.min(need, room);
        ring.forEach((i, j) => {
          give[i] += (take * spare[j]) / room;
        });
        need -= take;
      }
    }
    let takePx = want - Math.max(0, need);
    if (takePx < MIN_COLUMN_PX - 0.5) {
      // Not enough room above the minimums: an even share from all of them, which `checkLayout` refuses.
      takePx = want;
      widths.forEach((w, i) => {
        give[i] = (want * w) / usable;
      });
    }
    layout.columns.forEach((col, i) => {
      col.size = ((widths[i] - give[i]) / usable) * sum;
    });
    share = (takePx / usable) * sum;
  }
  layout.columns.splice(index, 0, {
    id: item.whole?.column ?? newId('col'),
    size: share,
    cells: [{ id: item.whole?.cell ?? newId('cell'), size: 100, tabs: item.tabs, active: item.active }],
  });
  return true;
}

/** Drops empty columns and scales sizes to 100 at each level. Changes the layout it is given. */
export function normalize(layout: WorkspaceLayout): WorkspaceLayout {
  layout.columns = layout.columns.filter((col) => col.cells.length);
  const even = (list: { size: number }[]) => {
    const sum = total(list) || 1;
    for (const item of list) item.size = (item.size * 100) / sum;
  };
  even(layout.columns);
  for (const col of layout.columns) even(col.cells);
  return layout;
}

/** The arrangement without ids or sizes: two layouts with the same shape show the same panels in the same places. */
export const shapeOf = (layout: WorkspaceLayout): string =>
  layout.columns.map((col) => col.cells.map((cell) => `${cell.tabs.join(',')}>${cell.active}`).join('/')).join('|');

export interface MoveOptions {
  /** Panels by how recently they were in front, most recent first: picks the tab that comes forward. */
  recent?: readonly PanelKey[];
}

/** The layout after a drop of a panel or a tab group, or null when the drop changes nothing or its target is gone. */
export function movePanel(layout: WorkspaceLayout, source: DragSource, target: DropTarget, box: Box, options: MoveOptions = {}): WorkspaceLayout | null {
  const next = copy(layout);
  const t: DropTarget = { ...target };
  if (t.kind === 'tab' && 'panel' in source) {
    const at = findPanel(layout, source.panel);
    if (at && at.cell.id === t.cell) {
      if (t.index === null) return null; // the middle of its own cell
      if (at.index < t.index) t.index -= 1;
    }
  }
  const newId = idMaker(layout);
  const item = detach(next, source, t.kind === 'column', options.recent);
  if (!item || !place(next, item, t, box, newId)) return null;
  normalize(next);
  next.seq = newId.seq;
  return shapeOf(next) === shapeOf(layout) ? null : next;
}

/** Adds a closed panel at a target; null when it is already open or the target is gone. */
export function insertPanel(layout: WorkspaceLayout, key: PanelKey, target: DropTarget, box: Box): WorkspaceLayout | null {
  if (findPanel(layout, key)) return null;
  const newId = idMaker(layout);
  if (!layout.columns.length) {
    const columns = [{ id: newId('col'), size: 100, cells: [{ id: newId('cell'), size: 100, tabs: [key], active: key }] }];
    return { v: 1, columns, seq: newId.seq };
  }
  const next = copy(layout);
  if (!place(next, { tabs: [key], active: key }, target, box, newId)) return null;
  next.seq = newId.seq;
  return normalize(next);
}

/** Where a closed panel was, so it can open there again. */
export interface LastPlace {
  cell: string;
  column: string;
  /** Its position in the cell's strip. */
  index: number;
  /** Its cell's position in the column. */
  cellIndex: number;
  /** It was the only panel in its column. */
  alone: boolean;
  /** The column after its own, or null when its column was the last. */
  before: string | null;
}

/** Takes a panel out of the layout, and says where it was. */
export function removePanel(layout: WorkspaceLayout, key: PanelKey, options: MoveOptions = {}): { layout: WorkspaceLayout; place: LastPlace } | null {
  const at = findPanel(layout, key);
  if (!at) return null;
  const columnIndex = layout.columns.indexOf(at.col);
  const after = layout.columns[columnIndex + 1];
  const place: LastPlace = {
    cell: at.cell.id,
    column: at.col.id,
    index: at.index,
    cellIndex: at.col.cells.indexOf(at.cell),
    alone: at.col.cells.length === 1 && at.cell.tabs.length === 1,
    before: after ? after.id : null,
  };
  const next = copy(layout);
  detach(next, { panel: key }, false, options.recent);
  return { layout: normalize(next), place };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each column and cell sits in a box, in pixels from its top left. */
export function geometry(layout: WorkspaceLayout, box: Box): { columns: Map<string, Rect>; cells: Map<string, Rect> } {
  const columns = new Map<string, Rect>();
  const cells = new Map<string, Rect>();
  const usableW = box.w - Math.max(0, layout.columns.length - 1) * HANDLE_PX;
  let x = 0;
  layout.columns.forEach((col, i) => {
    if (i) x += HANDLE_PX;
    const w = (usableW * col.size) / 100;
    columns.set(col.id, { x, y: 0, w, h: box.h });
    const usableH = box.h - Math.max(0, col.cells.length - 1) * HANDLE_PX;
    let y = 0;
    col.cells.forEach((cell, j) => {
      if (j) y += HANDLE_PX;
      const h = (usableH * cell.size) / 100;
      cells.set(cell.id, { x, y, w, h });
      y += h;
    });
    x += w;
  });
  return { columns, cells };
}

/** Why the layout can't be shown in the box, or null. */
export function checkLayout(layout: WorkspaceLayout, box: Box): LayoutRefusal | null {
  for (const col of layout.columns) {
    for (const cell of col.cells) {
      if (tabsConflict(cell.tabs)) return { code: 'inspector-preview' };
    }
  }
  const g = geometry(layout, box);
  for (const col of layout.columns) {
    if (g.columns.get(col.id)!.w < MIN_COLUMN_PX - 0.5) return { code: 'width', px: MIN_COLUMN_PX };
  }
  for (const col of layout.columns) {
    for (const cell of col.cells) {
      if (g.cells.get(cell.id)!.h >= minHeight(cell) - 0.5) continue;
      const panel = [...cell.tabs].sort((a, b) => MIN_HEIGHT_PX[b] - MIN_HEIGHT_PX[a])[0];
      return { code: 'height', panel, px: MIN_HEIGHT_PX[panel] };
    }
  }
  return null;
}

/**
 * A stored layout, checked: known panels, each at most once, ids unique, sizes positive. Null when
 * it isn't a layout; the active tab is repaired and sizes are scaled to 100.
 */
export function validateLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { v?: unknown; columns?: unknown; seq?: unknown };
  if (value.v !== 1 || !Array.isArray(value.columns)) return null;
  const seenPanels = new Set<PanelKey>();
  const seenIds = new Set<string>();
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const columns: LayoutColumn[] = [];
  for (const col of value.columns as unknown[]) {
    const c = col as { id?: unknown; size?: unknown; cells?: unknown };
    if (!c || typeof c.id !== 'string' || seenIds.has(c.id) || !ok(c.size) || !Array.isArray(c.cells) || !c.cells.length) return null;
    seenIds.add(c.id);
    const cells: LayoutCell[] = [];
    for (const cell of c.cells as unknown[]) {
      const x = cell as { id?: unknown; size?: unknown; tabs?: unknown; active?: unknown };
      if (!x || typeof x.id !== 'string' || seenIds.has(x.id) || !ok(x.size) || !Array.isArray(x.tabs) || !x.tabs.length) return null;
      seenIds.add(x.id);
      const tabs: PanelKey[] = [];
      for (const key of x.tabs) {
        if (!isPanelKey(key) || seenPanels.has(key)) return null;
        seenPanels.add(key);
        tabs.push(key);
      }
      cells.push({ id: x.id, size: x.size, tabs, active: isPanelKey(x.active) && tabs.includes(x.active) ? x.active : tabs[0] });
    }
    columns.push({ id: c.id, size: c.size, cells });
  }
  const seq = typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > 0 ? value.seq : undefined;
  return normalize(seq ? { v: 1, columns, seq } : { v: 1, columns });
}
