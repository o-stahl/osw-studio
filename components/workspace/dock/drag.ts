import { HANDLE_PX, type DragSource, type DropTarget, type LayoutCell, type LayoutRefusal, type WorkspaceLayout } from '@/lib/workspace-layout';

/**
 * Where a drag would drop, from the pointer and the geometry measured when it started. Kept free of
 * the DOM so the regions can be tested on their own.
 */

/** The top and bottom 30% of a panel's body stack above or below it; the middle and the header make a tab. */
export const EDGE = 0.3;
/** A region boundary has to be crossed by this much before the target changes. */
export const HYSTERESIS = 8;
/** A tab dragged within this far of its own strip only reorders. */
export const STRIP_STICK = 20;
/** The pointer counts as on a bar within its gap plus 24 px either side. */
export const BAR_REACH = 32;
/** Mouse: the pointer has to move this far before a press becomes a drag. */
export const DRAG_THRESHOLD = 5;
/** Touch: a press has to be held this long before it becomes a drag. */
export const LONG_PRESS_MS = 350;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A cell as measured on screen, relative to the panel area. */
export interface MeasuredCell extends Rect {
  cell: LayoutCell;
  /** The header's height. */
  head: number;
  /** The tabs' (or the lone title's) left and right edges, for the insert position in the strip. */
  tabs: { l: number; r: number }[];
}

/** The gap before a column (or after the last, `before: null`), where a bar makes a new column. */
export interface Gap {
  before: string | null;
  /** The middle of the gap. */
  x: number;
  /** The layout a drop here makes, or null when it would change nothing (no bar is drawn then). */
  next: WorkspaceLayout | null;
  refusal: LayoutRefusal | null;
}

export interface Measure {
  width: number;
  height: number;
  cells: MeasuredCell[];
  gaps: Gap[];
}

type CellRegion = 'head' | 'above' | 'middle' | 'below';
export type Region =
  | { kind: 'strip' }
  | { kind: 'bar'; before: string | null }
  | { kind: 'cell'; id: string; region: CellRegion }
  | null;

const ORDER: CellRegion[] = ['head', 'above', 'middle', 'below'];

/** Where in a strip a tab dropped at `x` goes. */
export function tabIndexAt(cell: MeasuredCell, x: number): number {
  for (let i = 0; i < cell.tabs.length; i++) if (x < (cell.tabs[i].l + cell.tabs[i].r) / 2) return i;
  return cell.tabs.length;
}

export interface TargetInput {
  source: DragSource;
  /** The cell the drag started from. */
  sourceCell: string;
  /** The region the last move was in, for hysteresis. */
  prev: Region;
}

/**
 * The target under the pointer at (x, y), relative to the panel area. Inside a panel combines with
 * it: the header and the middle make a tab, the top and bottom 30% of the body stack. Between panels,
 * the bars make a new column. Null when the pointer is over nothing that takes a drop.
 */
export function targetAt(m: Measure, x: number, y: number, input: TargetInput): { target: DropTarget | null; region: Region } {
  const prev = input.prev;
  // A tab dragged along its own strip only reorders, until it leaves the strip by 20 px.
  if ('panel' in input.source) {
    const own = m.cells.find((c) => c.cell.id === input.sourceCell);
    if (own && own.cell.tabs.length > 1 && x >= own.x && x <= own.x + own.w && y >= own.y - STRIP_STICK && y <= own.y + own.head + STRIP_STICK) {
      return { target: { kind: 'tab', cell: own.cell.id, index: tabIndexAt(own, x) }, region: { kind: 'strip' } };
    }
  }

  // Between panels, the bars. Over a header a bar reaches only across its gap, so a tab can still go
  // first or last in the strip.
  const inHead = m.cells.some((c) => x >= c.x - 2 && x <= c.x + c.w + 2 && y >= c.y && y < c.y + c.head);
  let gap: Gap | null = null;
  for (const g of m.gaps) {
    const held = prev && prev.kind === 'bar' && prev.before === g.before ? HYSTERESIS : 0;
    const reach = (inHead ? HANDLE_PX / 2 + 2 : BAR_REACH) + held;
    if (Math.abs(x - g.x) <= reach && (!gap || Math.abs(x - g.x) < Math.abs(x - gap.x))) gap = g;
  }
  if (gap && y >= -8 && y <= m.height + 8) {
    return { target: gap.next ? { kind: 'column', before: gap.before } : null, region: { kind: 'bar', before: gap.before } };
  }

  let best: MeasuredCell | null = null;
  let bestDistance = Infinity;
  for (const c of m.cells) {
    const dx = x < c.x ? c.x - x : x > c.x + c.w ? x - (c.x + c.w) : 0;
    const dy = y < c.y ? c.y - y : y > c.y + c.h ? y - (c.y + c.h) : 0;
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  if (!best || bestDistance > 24) return { target: null, region: null };
  const c = best;
  const px = Math.min(Math.max(x, c.x), c.x + c.w);
  const py = Math.min(Math.max(y, c.y), c.y + c.h);
  const top = c.y + c.head;
  const body = c.h - c.head;
  const lines: Record<Exclude<CellRegion, 'below'>, number> = { head: top, above: top + body * EDGE, middle: top + body * (1 - EDGE) };
  let region: CellRegion = py < lines.head ? 'head' : py < lines.above ? 'above' : py <= lines.middle ? 'middle' : 'below';
  if (prev && prev.kind === 'cell' && prev.id === c.cell.id && prev.region !== region) {
    // Hold the previous region until the pointer is 8 px past the boundary it crossed.
    const a = ORDER.indexOf(prev.region);
    const b = ORDER.indexOf(region);
    const line = ORDER[Math.min(a, b)] as Exclude<CellRegion, 'below'>;
    if (Math.abs(a - b) === 1 && Math.abs(py - lines[line]) < HYSTERESIS) region = prev.region;
  }
  const at: Region = { kind: 'cell', id: c.cell.id, region };
  if (region === 'head') return { target: { kind: 'tab', cell: c.cell.id, index: tabIndexAt(c, px) }, region: at };
  if (region === 'middle') return { target: { kind: 'tab', cell: c.cell.id, index: null }, region: at };
  return { target: { kind: 'stack', cell: c.cell.id, side: region }, region: at };
}

export const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean => JSON.stringify(a) === JSON.stringify(b);
