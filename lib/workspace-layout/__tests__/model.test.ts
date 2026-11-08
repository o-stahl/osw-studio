import { describe, it, expect } from 'vitest';
import {
  checkLayout, findPanel, geometry, insertPanel, movePanel, openPanels, removePanel, shapeOf, validateLayout,
  HANDLE_PX, MIN_COLUMN_PX, type PanelKey, type WorkspaceLayout,
} from '..';

/** Columns of cells of tabs; the first tab in each cell is in front unless marked with `*`. */
function layout(spec: [number, [number, string[]][]][]): WorkspaceLayout {
  let n = 0;
  return {
    v: 1,
    columns: spec.map(([size, cells]) => ({
      id: `col${++n}`,
      size,
      cells: cells.map(([cellSize, tabs]) => {
        const keys = tabs.map((t) => t.replace('*', '')) as PanelKey[];
        const starred = tabs.find((t) => t.endsWith('*'));
        return { id: `cell${++n}`, size: cellSize, tabs: keys, active: (starred ? starred.replace('*', '') : keys[0]) as PanelKey };
      }),
    })),
  };
}

const BOX = { w: 1182, h: 629 };
const today = () => layout([[30, [[100, ['chat']]]], [40, [[100, ['preview']]]], [30, [[100, ['files']]]]]);
const sizes = (L: WorkspaceLayout) => L.columns.map((c) => Math.round(c.size));
const cellId = (L: WorkspaceLayout, key: PanelKey) => findPanel(L, key)!.cell.id;
const colId = (L: WorkspaceLayout, key: PanelKey) => findPanel(L, key)!.col.id;

describe('movePanel onto a tab target', () => {
  it('joins the cell at the end of the strip and comes to the front', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'tab', cell: cellId(today(), 'chat'), index: null }, BOX)!;
    expect(shapeOf(L)).toBe('chat,files>files|preview>preview');
  });

  it('gives the emptied column to its left neighbour, leaving the rest as they were', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'tab', cell: cellId(today(), 'chat'), index: null }, BOX)!;
    expect(sizes(L)).toEqual([30, 70]);
  });

  it('goes to the position in the strip it was dropped on', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'tab', cell: cellId(today(), 'chat'), index: 0 }, BOX)!;
    expect(L.columns[0].cells[0].tabs).toEqual(['files', 'chat']);
  });

  it('reorders within its own strip, counting the slot it leaves', () => {
    const L0 = layout([[100, [[100, ['chat', 'files', 'skills']]]]]);
    const L = movePanel(L0, { panel: 'chat' }, { kind: 'tab', cell: 'cell2', index: 2 }, BOX)!;
    expect(L.columns[0].cells[0].tabs).toEqual(['files', 'chat', 'skills']);
  });

  it('does nothing when dropped on the middle of its own cell', () => {
    const L0 = layout([[100, [[100, ['chat', 'files']]]]]);
    expect(movePanel(L0, { panel: 'files' }, { kind: 'tab', cell: 'cell2', index: null }, BOX)).toBeNull();
  });

  it('moves a whole group, keeping which tab is in front', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[100, ['files', 'skills*']]]]]);
    const L = movePanel(L0, { cell: 'cell4' }, { kind: 'tab', cell: 'cell2', index: null }, BOX)!;
    expect(shapeOf(L)).toBe('chat,files,skills>skills');
  });
});

describe('the tab that comes forward when the front one leaves', () => {
  const L0 = layout([[50, [[100, ['chat', 'checkpoints', 'debug']]]], [50, [[100, ['preview']]]]]);

  it('is the one most recently in front', () => {
    const L = movePanel(L0, { panel: 'chat' }, { kind: 'tab', cell: 'cell4', index: null }, BOX, { recent: ['chat', 'debug', 'checkpoints'] })!;
    expect(L.columns[0].cells[0].active).toBe('debug');
  });

  it('is its left neighbour, or the first, when nothing has been in front', () => {
    const L = movePanel(L0, { panel: 'chat' }, { kind: 'tab', cell: 'cell4', index: null }, BOX)!;
    expect(L.columns[0].cells[0].active).toBe('checkpoints');
  });
});

describe('movePanel onto a stack target', () => {
  it('splits the cell, giving each half its height', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'stack', cell: cellId(today(), 'preview'), side: 'below' }, BOX)!;
    expect(shapeOf(L)).toBe('chat>chat|preview>preview/files>files');
    expect(L.columns[1].cells.map((c) => Math.round(c.size))).toEqual([50, 50]);
  });

  it('keeps the chat at its minimum height when an even split would take it under', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'stack', cell: cellId(today(), 'chat'), side: 'below' }, BOX)!;
    const g = geometry(L, BOX);
    expect(g.cells.get(cellId(L, 'chat'))!.h).toBeGreaterThanOrEqual(419.5);
    expect(checkLayout(L, BOX)).toBeNull();
  });

  it('splits a group in two when a tab is dropped on its own cell', () => {
    const L0 = layout([[100, [[100, ['chat', 'files']]]]]);
    const L = movePanel(L0, { panel: 'files' }, { kind: 'stack', cell: 'cell2', side: 'below' }, BOX)!;
    expect(shapeOf(L)).toBe('chat>chat/files>files');
  });

  it('does nothing for a lone panel dropped on its own cell', () => {
    expect(movePanel(today(), { panel: 'files' }, { kind: 'stack', cell: cellId(today(), 'files'), side: 'above' }, BOX)).toBeNull();
  });
});

describe('movePanel onto a column target', () => {
  it('moves a lone column whole, keeping every width', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'column', before: colId(today(), 'chat') }, BOX)!;
    expect(shapeOf(L)).toBe('files>files|chat>chat|preview>preview');
    expect(sizes(L)).toEqual([30, 30, 40]);
  });

  it('keeps the ids of a column moved whole, which key what renders it', () => {
    const L0 = today();
    const L = movePanel(L0, { panel: 'files' }, { kind: 'column', before: colId(L0, 'chat') }, BOX)!;
    expect([colId(L, 'files'), cellId(L, 'files')]).toEqual([colId(L0, 'files'), cellId(L0, 'files')]);
    const grouped = layout([[50, [[100, ['chat']]]], [50, [[100, ['files', 'skills']]]]]);
    const G = movePanel(grouped, { cell: 'cell4' }, { kind: 'column', before: 'col1' }, BOX)!;
    expect(G.columns.map((c) => [c.id, c.cells[0].id])).toEqual([['col3', 'cell4'], ['col1', 'cell2']]);
  });

  it('does nothing on the bars beside its own column', () => {
    expect(movePanel(today(), { panel: 'files' }, { kind: 'column', before: null }, BOX)).toBeNull();
    expect(movePanel(today(), { panel: 'chat' }, { kind: 'column', before: colId(today(), 'preview') }, BOX)).toBeNull();
  });

  it('takes the new column\'s width from the columns beside it first', () => {
    const L0 = layout([[25, [[100, ['chat']]]], [45, [[100, ['preview', 'files']]]], [30, [[100, ['editor']]]]]);
    const before = geometry(L0, BOX).columns.get('col1')!.w;
    const L = movePanel(L0, { panel: 'files' }, { kind: 'column', before: 'col5' }, BOX)!;
    expect(shapeOf(L)).toBe('chat>chat|preview>preview|files>files|editor>editor');
    const g = geometry(L, BOX);
    const widths = L.columns.map((c) => g.columns.get(c.id)!.w);
    // The chat column is not beside the new one, so it gives nothing: it only pays its share of the new handle.
    expect(Math.abs(widths[0] - before)).toBeLessThan(HANDLE_PX / 2);
    expect(widths.every((w) => w >= MIN_COLUMN_PX - 0.5)).toBe(true);
  });

  it('takes a neighbour down to an even share before taking from further out', () => {
    const L0 = layout([[50, [[100, ['preview']]]], [50, [[100, ['chat']]]]]);
    const L = insertPanel(L0, 'editor', { kind: 'column', before: null }, BOX)!;
    expect(sizes(L)).toEqual([33, 33, 33]);
  });

  it('takes a neighbour down to an even share before a column further out that also has room', () => {
    // The order shows only when a column is already under an even share: the others then have more
    // to give than the new column needs. Taken from everyone at once, the last two would end at 28.
    const L0 = layout([[20, [[100, ['chat']]]], [40, [[100, ['preview']]]], [40, [[100, ['files']]]]]);
    const L = insertPanel(L0, 'editor', { kind: 'column', before: null }, { w: 1600, h: 629 })!;
    expect(sizes(L)).toEqual([20, 30, 25, 25]);
  });

  it('is refused by checkLayout when there is no room for another 240 px column', () => {
    const narrow = { w: 900, h: 629 }; // room for three 240 px columns, not four
    const L = movePanel(today(), { panel: 'files' }, { kind: 'column', before: colId(today(), 'preview') }, narrow);
    // files moves whole, so the row still has three columns: allowed. A fourth from a tab is not.
    expect(L && checkLayout(L, narrow)).toBeNull();
    const grouped = layout([[33, [[100, ['chat', 'skills']]]], [34, [[100, ['preview']]]], [33, [[100, ['files']]]]]);
    const fourth = movePanel(grouped, { panel: 'skills' }, { kind: 'column', before: null }, narrow)!;
    expect(checkLayout(fourth, narrow)).toEqual({ code: 'width', px: MIN_COLUMN_PX });
  });
});

describe('checkLayout', () => {
  it('names the panel that is too short', () => {
    const L = layout([[100, [[70, ['preview']], [30, ['chat']]]]]);
    expect(checkLayout(L, BOX)).toEqual({ code: 'height', panel: 'chat', px: 420 });
  });

  it('refuses the Inspector and the preview in one tab group, and allows them stacked', () => {
    expect(checkLayout(layout([[100, [[100, ['preview', 'elements']]]]]), BOX)).toEqual({ code: 'inspector-preview' });
    expect(checkLayout(layout([[100, [[50, ['preview']], [50, ['elements']]]]]), BOX)).toBeNull();
  });
});

describe('insertPanel and removePanel', () => {
  it('opens into an empty workspace as one full column', () => {
    const L = insertPanel({ v: 1, columns: [] }, 'chat', { kind: 'column', before: null }, BOX)!;
    expect(shapeOf(L)).toBe('chat>chat');
    expect(sizes(L)).toEqual([100]);
  });

  it('will not open a panel twice', () => {
    expect(insertPanel(today(), 'chat', { kind: 'column', before: null }, BOX)).toBeNull();
  });

  it('removes a panel and says where it was', () => {
    const result = removePanel(today(), 'preview')!;
    expect(shapeOf(result.layout)).toBe('chat>chat|files>files');
    expect(result.place).toMatchObject({ alone: true, before: colId(today(), 'files'), index: 0, cellIndex: 0 });
    expect(sizes(result.layout)).toEqual([70, 30]);
  });
});

describe('openPanels', () => {
  it('lists every open panel, background tabs included, left to right and top to bottom', () => {
    const L = layout([[50, [[60, ['chat', 'debug*']], [40, ['console']]]], [50, [[100, ['preview']]]]]);
    expect(openPanels(L)).toEqual(['chat', 'debug', 'console', 'preview']);
  });
});

describe('geometry', () => {
  it('leaves a handle\'s width between columns and cells', () => {
    const L = layout([[50, [[50, ['chat']], [50, ['console']]]], [50, [[100, ['preview']]]]]);
    const g = geometry(L, { w: 1016, h: 516 });
    expect(g.columns.get('col4')!.x).toBe(500 + HANDLE_PX);
    expect(g.cells.get('cell3')!.y).toBe(250 + HANDLE_PX);
  });
});

describe('validateLayout', () => {
  it('accepts a layout and scales sizes to 100', () => {
    const L = validateLayout({ v: 1, columns: [{ id: 'a', size: 1, cells: [{ id: 'b', size: 3, tabs: ['chat'], active: 'chat' }] }, { id: 'c', size: 3, cells: [{ id: 'd', size: 1, tabs: ['files'], active: 'files' }] }] })!;
    expect(sizes(L)).toEqual([25, 75]);
    expect(L.columns[0].cells[0].size).toBe(100);
  });

  it('repairs an active tab that is not in the strip', () => {
    const L = validateLayout({ v: 1, columns: [{ id: 'a', size: 100, cells: [{ id: 'b', size: 100, tabs: ['chat', 'files'], active: 'preview' }] }] })!;
    expect(L.columns[0].cells[0].active).toBe('chat');
  });

  it.each([
    ['not an object', 'nope'],
    ['another version', { v: 2, columns: [] }],
    ['an unknown panel', { v: 1, columns: [{ id: 'a', size: 100, cells: [{ id: 'b', size: 100, tabs: ['terminal'], active: 'terminal' }] }] }],
    ['a panel twice', { v: 1, columns: [{ id: 'a', size: 50, cells: [{ id: 'b', size: 100, tabs: ['chat'], active: 'chat' }] }, { id: 'c', size: 50, cells: [{ id: 'd', size: 100, tabs: ['chat'], active: 'chat' }] }] }],
    ['a repeated id', { v: 1, columns: [{ id: 'a', size: 100, cells: [{ id: 'a', size: 100, tabs: ['chat'], active: 'chat' }] }] }],
    ['an empty cell', { v: 1, columns: [{ id: 'a', size: 100, cells: [{ id: 'b', size: 100, tabs: [], active: 'chat' }] }] }],
    ['a zero size', { v: 1, columns: [{ id: 'a', size: 0, cells: [{ id: 'b', size: 100, tabs: ['chat'], active: 'chat' }] }] }],
  ])('rejects %s', (_label, raw) => {
    expect(validateLayout(raw)).toBeNull();
  });

  it('accepts an empty workspace', () => {
    expect(validateLayout({ v: 1, columns: [] })).toEqual({ v: 1, columns: [] });
  });
});

describe('new ids', () => {
  it('never repeat one the layout has', () => {
    const L = movePanel(today(), { panel: 'files' }, { kind: 'stack', cell: cellId(today(), 'preview'), side: 'below' }, BOX)!;
    const ids = L.columns.flatMap((c) => [c.id, ...c.cells.map((x) => x.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
