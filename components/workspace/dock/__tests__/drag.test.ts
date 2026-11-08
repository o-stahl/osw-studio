import { describe, it, expect } from 'vitest';
import { targetAt, tabIndexAt, BAR_REACH, type Measure, type MeasuredCell } from '../drag';
import type { LayoutCell, PanelKey, WorkspaceLayout } from '@/lib/workspace-layout';

/**
 * Where a drop lands, from the pointer: the header and the middle of a panel make a tab, its top and
 * bottom 30% stack, the bars between panels make a column.
 */

const cell = (id: string, tabs: PanelKey[]): LayoutCell => ({ id, size: 100, tabs, active: tabs[0] });
const NEXT: WorkspaceLayout = { v: 1, columns: [] };

/** Two panels side by side: chat (tabbed with checkpoints) on the left, preview on the right. */
function measure(): Measure {
  const left: MeasuredCell = { x: 8, y: 8, w: 490, h: 584, head: 37, cell: cell('a', ['chat', 'checkpoints']), tabs: [{ l: 8, r: 90 }, { l: 92, r: 210 }] };
  const right: MeasuredCell = { x: 514, y: 8, w: 478, h: 584, head: 37, cell: cell('b', ['preview']), tabs: [{ l: 520, r: 640 }] };
  return {
    width: 1000,
    height: 600,
    cells: [left, right],
    gaps: [
      { before: 'colA', x: 4, next: NEXT, refusal: null },
      { before: 'colB', x: 506, next: NEXT, refusal: null },
      { before: null, x: 996, next: null, refusal: null },
    ],
  };
}

const from = { source: { panel: 'files' as PanelKey }, sourceCell: 'elsewhere', prev: null };

describe('targetAt', () => {
  const m = measure();
  // The preview's body runs from y = 45 to 592: 547 px, so its top 30% ends at 209 and its bottom 30% starts at 428.
  const x = 750;

  it('makes a tab at the pointer\'s place in the strip over a header', () => {
    expect(targetAt(m, 100, 20, from).target).toEqual({ kind: 'tab', cell: 'a', index: 1 });
    expect(targetAt(m, 600, 20, from).target).toEqual({ kind: 'tab', cell: 'b', index: 1 });
  });

  it('stacks above in the top 30% of a panel, below in the bottom 30%, and makes a tab in between', () => {
    expect(targetAt(m, x, 100, from).target).toEqual({ kind: 'stack', cell: 'b', side: 'above' });
    expect(targetAt(m, x, 320, from).target).toEqual({ kind: 'tab', cell: 'b', index: null });
    expect(targetAt(m, x, 500, from).target).toEqual({ kind: 'stack', cell: 'b', side: 'below' });
  });

  it('holds a region for 8 px past its boundary, so the preview does not flicker', () => {
    const above = targetAt(m, x, 200, from).region;
    expect(targetAt(m, x, 214, { ...from, prev: above }).target).toEqual({ kind: 'stack', cell: 'b', side: 'above' });
    expect(targetAt(m, x, 220, { ...from, prev: above }).target).toEqual({ kind: 'tab', cell: 'b', index: null });
  });

  it('makes a column on a bar, within its reach of the gap', () => {
    expect(targetAt(m, 506 + BAR_REACH - 1, 300, from).target).toEqual({ kind: 'column', before: 'colB' });
    // Past the reach the panel under the pointer has it: the preview's middle.
    expect(targetAt(m, 506 + BAR_REACH + 10, 300, from).target).toEqual({ kind: 'tab', cell: 'b', index: null });
  });

  it('reaches only across the gap over a header, so a tab can still go first in a strip', () => {
    expect(targetAt(m, 525, 20, from).target).toEqual({ kind: 'tab', cell: 'b', index: 0 });
    expect(targetAt(m, 510, 20, from).target).toEqual({ kind: 'column', before: 'colB' });
  });

  it('claims a bar that would change nothing, without a target', () => {
    const r = targetAt(m, 990, 300, from);
    expect(r.target).toBeNull();
    expect(r.region).toEqual({ kind: 'bar', before: null });
  });

  it('only reorders a tab dragged along its own strip', () => {
    const own = { source: { panel: 'checkpoints' as PanelKey }, sourceCell: 'a', prev: null };
    // Down into the body, but within 20 px of the strip: the end of the strip.
    expect(targetAt(m, 200, 55, own).target).toEqual({ kind: 'tab', cell: 'a', index: 2 });
    // Further down it has left the strip, and the top of its own group splits it.
    expect(targetAt(m, 200, 70, own).target).toEqual({ kind: 'stack', cell: 'a', side: 'above' });
  });

  it('has no target far from every panel', () => {
    const narrow: Measure = { ...m, cells: [m.cells[0]], gaps: [] };
    expect(targetAt(narrow, 900, 300, from).target).toBeNull();
  });
});

describe('tabIndexAt', () => {
  it('counts the tabs whose middle is left of the pointer', () => {
    const c = measure().cells[0];
    expect(tabIndexAt(c, 40)).toBe(0);
    expect(tabIndexAt(c, 60)).toBe(1);
    expect(tabIndexAt(c, 300)).toBe(2);
  });
});
