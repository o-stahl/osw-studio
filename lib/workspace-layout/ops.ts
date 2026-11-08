import { HANDLE_PX, MIN_COLUMN_PX } from './types';
import type { Box, DropTarget, LayoutCell, PanelKey, WorkspaceLayout } from './types';
import {
  checkLayout,
  findCell,
  findColumn,
  findPanel,
  geometry,
  idMaker,
  insertPanel,
  movePanel,
  normalize,
  shapeOf,
  tabsConflict,
  type LastPlace,
} from './model';

/**
 * The operations behind the rail, the menus and narrow windows, built on the moves in `model.ts`.
 * Like those, each takes a layout and returns a new one.
 */

const copy = (layout: WorkspaceLayout): WorkspaceLayout => JSON.parse(JSON.stringify(layout));

/**
 * Which panels belong together. A panel the rail opens goes into a cell that already holds one of
 * its group before it takes a column of its own; chat, preview and editor each stand alone.
 */
export const PANEL_GROUP: Record<PanelKey, string> = {
  chat: 'chat',
  preview: 'preview',
  editor: 'editor',
  files: 'files',
  skills: 'files',
  elements: 'files',
  console: 'runs',
  debug: 'runs',
  checkpoints: 'runs',
};

/** The rail opens panels as columns up to this many, then as tabs. A drag can still make more. */
export const RAIL_COLUMNS = 3;

/** The rightmost cell, bottom first, that can take these tabs without a conflict. */
function lastCellWithout(columns: WorkspaceLayout['columns'], tabs: readonly PanelKey[]): LayoutCell | null {
  for (let i = columns.length - 1; i >= 0; i--) {
    for (let j = columns[i].cells.length - 1; j >= 0; j--) {
      if (!tabsConflict([...columns[i].cells[j].tabs, ...tabs])) return columns[i].cells[j];
    }
  }
  return null;
}

/** Most recently in front first. */
export function bumpRecent(recent: readonly PanelKey[], key: PanelKey): PanelKey[] {
  return [key, ...recent.filter((k) => k !== key)];
}

/** Brings an open panel to the front of its cell; null when it is already there or not open. */
export function activatePanel(layout: WorkspaceLayout, key: PanelKey): WorkspaceLayout | null {
  const at = findPanel(layout, key);
  if (!at || at.cell.active === key) return null;
  const next = copy(layout);
  findPanel(next, key)!.cell.active = key;
  return next;
}

/** Closes a cell and everything in it. Each of its panels remembers the cell's place. */
export function closeCell(layout: WorkspaceLayout, cellId: string): { layout: WorkspaceLayout; places: Partial<Record<PanelKey, LastPlace>> } | null {
  const at = findCell(layout, cellId);
  if (!at) return null;
  const columnIndex = layout.columns.indexOf(at.col);
  const after = layout.columns[columnIndex + 1];
  const places: Partial<Record<PanelKey, LastPlace>> = {};
  at.cell.tabs.forEach((key, index) => {
    places[key] = {
      cell: at.cell.id,
      column: at.col.id,
      index,
      cellIndex: at.index,
      alone: at.col.cells.length === 1,
      before: after ? after.id : null,
    };
  });
  const next = copy(layout);
  const col = next.columns[columnIndex];
  const [gone] = col.cells.splice(at.index, 1);
  if (col.cells.length) col.cells[Math.max(0, at.index - 1)].size += gone.size;
  else {
    next.columns.splice(columnIndex, 1);
    if (next.columns.length) next.columns[Math.max(0, columnIndex - 1)].size += col.size;
  }
  return { layout: normalize(next), places };
}

/** Where a closed panel opens, and the layout with it there; `target` is null for an empty workspace. */
export interface OpenPlan {
  layout: WorkspaceLayout;
  target: DropTarget | null;
  /** The layout can't be shown as it is (see `checkLayout`): every place was refused, and this is the last. */
  refused: boolean;
}

/**
 * Where the rail opens a closed panel. Opening never closes anything: it goes to its last place (its
 * cell if that still exists, otherwise its column), then into a cell holding its group, then into a
 * new column while there are fewer than `RAIL_COLUMNS`, then into the rightmost cell as a tab. The
 * first of those the layout can show wins.
 */
export function planOpen(
  layout: WorkspaceLayout,
  key: PanelKey,
  box: Box,
  memory: { lastPlace?: LastPlace; recent?: readonly PanelKey[] } = {},
): OpenPlan | null {
  if (findPanel(layout, key)) return null;
  if (!layout.columns.length) {
    const fresh = insertPanel(layout, key, { kind: 'column', before: null }, box);
    return fresh ? { layout: fresh, target: null, refused: false } : null;
  }
  const tries: DropTarget[] = [];
  const mem = memory.lastPlace;
  if (mem && findCell(layout, mem.cell)) {
    tries.push({ kind: 'tab', cell: mem.cell, index: mem.index });
  } else if (mem && findColumn(layout, mem.column)) {
    const col = findColumn(layout, mem.column)!.col;
    const i = Math.min(mem.cellIndex, col.cells.length);
    tries.push(i < col.cells.length
      ? { kind: 'stack', cell: col.cells[i].id, side: 'above' }
      : { kind: 'stack', cell: col.cells[col.cells.length - 1].id, side: 'below' });
  } else if (mem && mem.alone) {
    tries.push({ kind: 'column', before: mem.before && findColumn(layout, mem.before) ? mem.before : null });
  }

  const rank = (k: PanelKey) => {
    const i = memory.recent?.indexOf(k) ?? -1;
    return i < 0 ? Infinity : i;
  };
  const group = layout.columns
    .flatMap((col) => col.cells)
    .filter((cell) => cell.tabs.some((k) => PANEL_GROUP[k] === PANEL_GROUP[key]) && !tabsConflict([...cell.tabs, key]))
    .sort((a, b) => rank(a.active) - rank(b.active));
  if (group.length) tries.push({ kind: 'tab', cell: group[0].id, index: null });

  if (layout.columns.length < RAIL_COLUMNS) tries.push({ kind: 'column', before: null });

  const rightmost = lastCellWithout(layout.columns, [key]);
  if (rightmost) tries.push({ kind: 'tab', cell: rightmost.id, index: null });
  else tries.push({ kind: 'column', before: null });

  for (const target of tries) {
    const next = insertPanel(layout, key, target, box);
    if (next && !checkLayout(next, box)) return { layout: next, target, refused: false };
  }
  const target = tries[tries.length - 1];
  const next = insertPanel(layout, key, target, box);
  return next ? { layout: next, target, refused: true } : null;
}

/**
 * Ungroup all: the group's tabs stack in its column while each still gets its minimum height, the
 * rest go to new columns to the right while there is width, and whatever is left stays tabbed.
 * Null when the cell is not a group or nothing can come out.
 */
export function ungroup(
  layout: WorkspaceLayout,
  cellId: string,
  box: Box,
  recent: readonly PanelKey[] = [],
): { layout: WorkspaceLayout; stayed: PanelKey[] } | null {
  const at0 = findCell(layout, cellId);
  if (!at0 || at0.cell.tabs.length < 2) return null;
  const rank = (k: PanelKey) => {
    const i = recent.indexOf(k);
    return i < 0 ? Infinity : i;
  };
  const order = [at0.cell.active, ...at0.cell.tabs.filter((k) => k !== at0.cell.active).sort((a, b) => rank(a) - rank(b))];
  for (let k = order.length; k >= 1; k--) {
    let next = copy(layout);
    const newId = idMaker(next);
    const at = findCell(next, cellId)!;
    const stacked = order.slice(0, k);
    const rest = order.slice(k);
    const size = at.cell.size / k;
    const cells: LayoutCell[] = stacked.map((key, i) => ({
      id: i === 0 ? at.cell.id : newId('cell'),
      size,
      tabs: i === 0 ? [key, ...rest] : [key],
      active: key,
    }));
    at.col.cells.splice(at.index, 1, ...cells);
    next.seq = newId.seq;
    normalize(next);
    if (checkLayout(next, box)) continue;
    const stayed: PanelKey[] = [];
    let anchor = at.col.id;
    for (const key of rest) {
      const i = next.columns.findIndex((col) => col.id === anchor);
      const after = next.columns[i + 1];
      const moved = movePanel(next, { panel: key }, { kind: 'column', before: after ? after.id : null }, box);
      if (moved && !checkLayout(moved, box)) {
        next = moved;
        anchor = findPanel(next, key)!.col.id;
      } else stayed.push(key);
    }
    return shapeOf(next) === shapeOf(layout) ? null : { layout: next, stayed };
  }
  return null;
}

/**
 * What a window too narrow for the layout shows: the rightmost columns as tabs in the column before
 * them. A view only: the saved layout is not changed, and comes back when the window widens.
 */
export function fold(layout: WorkspaceLayout, box: Box): { layout: WorkspaceLayout; folded: number } {
  const widthOk = (l: WorkspaceLayout) => {
    const g = geometry(l, box);
    return l.columns.every((col) => g.columns.get(col.id)!.w >= MIN_COLUMN_PX - 0.5);
  };
  if (!layout.columns.length || widthOk(layout)) return { layout, folded: 0 };
  const next = copy(layout);
  let folded = 0;
  while (next.columns.length > 1 && !widthOk(next)) {
    const usable = box.w - (next.columns.length - 1) * HANDLE_PX;
    if (usable >= next.columns.length * MIN_COLUMN_PX) {
      // They all fit: the narrow ones get their minimum, from the others in proportion to what they
      // have over it, and no panel has to go.
      const sum = next.columns.reduce((a, col) => a + col.size, 0) || 100;
      const widths = next.columns.map((col) => (usable * col.size) / sum);
      const deficit = widths.reduce((a, w) => a + Math.max(0, MIN_COLUMN_PX - w), 0);
      const spare = widths.reduce((a, w) => a + Math.max(0, w - MIN_COLUMN_PX), 0);
      next.columns.forEach((col, i) => {
        const w = widths[i] < MIN_COLUMN_PX ? MIN_COLUMN_PX : widths[i] - (deficit * (widths[i] - MIN_COLUMN_PX)) / spare;
        col.size = (w / usable) * 100;
      });
      break;
    }
    const last = next.columns.pop()!;
    const prev = next.columns[next.columns.length - 1];
    const tabs = last.cells.flatMap((cell) => cell.tabs);
    const into = lastCellWithout(next.columns, tabs) ?? prev.cells[prev.cells.length - 1];
    into.tabs.push(...tabs);
    prev.size += last.size;
    folded += tabs.length;
  }
  return { layout: normalize(next), folded };
}

/** One cell filling the workspace: what a maximized cell shows. Null when the cell is gone. */
export function maximizedView(layout: WorkspaceLayout, cellId: string): WorkspaceLayout | null {
  const at = findCell(layout, cellId);
  if (!at) return null;
  return { v: 1, columns: [{ id: at.col.id, size: 100, cells: [{ ...at.cell, size: 100 }] }], seq: layout.seq };
}

export type LayoutPreset = 'columns' | 'stacked' | 'tabbed';
export const LAYOUT_PRESETS: readonly LayoutPreset[] = ['columns', 'stacked', 'tabbed'];

/** Columns of [width, cells of [height, tabs, front tab]]. */
type Spec = [number, [number, PanelKey[], PanelKey?][]][];
const PRESET_SPECS: Record<LayoutPreset, Spec> = {
  columns: [[100 / 3, [[100, ['chat']]]], [100 / 3, [[100, ['preview']]]], [100 / 3, [[100, ['files']]]]],
  stacked: [[28, [[100, ['chat']]]], [38, [[62, ['preview']], [38, ['console']]]], [34, [[42, ['files']], [58, ['editor']]]]],
  tabbed: [[30, [[100, ['chat', 'checkpoints', 'debug']]]], [40, [[100, ['preview']]]], [30, [[100, ['editor', 'files', 'skills'], 'editor']]]],
};

/** A preset arrangement, with ids numbered past `seq` so none of them names an earlier cell. */
export function presetLayout(name: LayoutPreset, seq = 0): WorkspaceLayout {
  const newId = idMaker({ v: 1, columns: [], seq });
  const columns = PRESET_SPECS[name].map(([size, cells]) => ({
    id: newId('col'),
    size,
    cells: cells.map(([cellSize, tabs, active]) => ({ id: newId('cell'), size: cellSize, tabs: [...tabs], active: active ?? tabs[0] })),
  }));
  return normalize({ v: 1, columns, seq: newId.seq });
}

/** The preset a layout is arranged as, whatever its sizes; null for any other arrangement. */
export function presetOf(layout: WorkspaceLayout): LayoutPreset | null {
  const shape = shapeOf(layout);
  return LAYOUT_PRESETS.find((name) => shapeOf(presetLayout(name)) === shape) ?? null;
}

/** The layout a workspace starts with, and goes back to on Reset layout. */
export const defaultLayout = (seq = 0): WorkspaceLayout => presetLayout('columns', seq);
