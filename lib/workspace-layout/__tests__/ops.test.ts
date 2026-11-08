import { describe, it, expect } from 'vitest';
import {
  activatePanel, checkLayout, closeCell, findPanel, fold, geometry, insertPanel, maximizedView, movePanel, openPanels,
  planOpen, presetLayout, presetOf, removePanel, shapeOf, ungroup,
  MIN_COLUMN_PX, type PanelKey, type WorkspaceLayout,
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

describe('planOpen', () => {
  it('opens into an empty workspace as its only column', () => {
    const plan = planOpen({ v: 1, columns: [] }, 'chat', BOX)!;
    expect(shapeOf(plan.layout)).toBe('chat>chat');
    expect(plan.target).toBeNull();
  });

  it('goes back into the cell it was closed from, at its place in the strip', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[100, ['console', 'debug', 'checkpoints']]]]]);
    const { layout: closed, place } = removePanel(L0, 'debug')!;
    const plan = planOpen(closed, 'debug', BOX, { lastPlace: place })!;
    expect(plan.layout.columns[1].cells[0].tabs).toEqual(['console', 'debug', 'checkpoints']);
    expect(plan.target).toEqual({ kind: 'tab', cell: 'cell4', index: 1 });
  });

  it('goes back to its place in the column when its cell has gone', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[60, ['preview']], [40, ['console']]]]]);
    const { layout: closed, place } = removePanel(L0, 'console')!;
    const plan = planOpen(closed, 'console', BOX, { lastPlace: place })!;
    expect(shapeOf(plan.layout)).toBe('chat>chat|preview>preview/console>console');
  });

  it('gets its own column back, beside the same neighbour, when it was alone in one', () => {
    const { layout: closed, place } = removePanel(today(), 'preview')!;
    const plan = planOpen(closed, 'preview', BOX, { lastPlace: place })!;
    expect(shapeOf(plan.layout)).toBe(shapeOf(today()));
  });

  it('joins a cell holding its group, the one in front most recently first', () => {
    const L0 = layout([[34, [[100, ['chat']]]], [33, [[100, ['files']]]], [33, [[100, ['elements']]]]]);
    const plan = planOpen(L0, 'skills', BOX, { recent: ['elements', 'files'] })!;
    expect(findPanel(plan.layout, 'skills')!.cell.id).toBe('cell6');
    expect(planOpen(L0, 'skills', BOX, { recent: ['files', 'elements'] })!.layout.columns[1].cells[0].tabs).toEqual(['files', 'skills']);
  });

  it('takes a new column while there are fewer than three', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[100, ['preview']]]]]);
    expect(shapeOf(planOpen(L0, 'editor', BOX)!.layout)).toBe('chat>chat|preview>preview|editor>editor');
  });

  it('opens as a tab in the rightmost cell at three columns, closing nothing', () => {
    const plan = planOpen(today(), 'editor', BOX)!;
    expect(shapeOf(plan.layout)).toBe('chat>chat|preview>preview|files,editor>editor');
    expect(openPanels(plan.layout)).toHaveLength(4);
  });

  it('never puts the Inspector in a tab group with the preview', () => {
    const L0 = layout([[34, [[100, ['chat']]]], [33, [[100, ['editor']]]], [33, [[50, ['console']], [50, ['preview']]]]]);
    const plan = planOpen(L0, 'elements', BOX)!;
    expect(findPanel(plan.layout, 'elements')!.cell.tabs).toEqual(['console', 'elements']);
  });

  it('looks further left when the rightmost cell is the preview', () => {
    const L0 = layout([[34, [[100, ['editor']]]], [33, [[100, ['console']]]], [33, [[100, ['preview']]]]]);
    const plan = planOpen(L0, 'elements', BOX)!;
    expect(findPanel(plan.layout, 'elements')!.cell.tabs).toEqual(['console', 'elements']);
    expect(plan.refused).toBe(false);
  });

  it('passes over a place the layout cannot show', () => {
    // The chat needs 420 px; its old cell is gone and the column is too short to stack it back.
    const L0 = layout([[50, [[100, ['files']]]], [50, [[100, ['preview']]]]]);
    const place = { cell: 'gone', column: 'col1', index: 0, cellIndex: 1, alone: false, before: null };
    const plan = planOpen(L0, 'chat', { w: 1182, h: 500 }, { lastPlace: place })!;
    expect(plan.refused).toBe(false);
    expect(checkLayout(plan.layout, { w: 1182, h: 500 })).toBeNull();
    expect(plan.layout.columns).toHaveLength(3);
  });
});

describe('activatePanel', () => {
  it('brings a background tab to the front', () => {
    const L0 = layout([[100, [[100, ['console', 'debug']]]]]);
    expect(activatePanel(L0, 'debug')!.columns[0].cells[0].active).toBe('debug');
  });

  it('changes nothing for the front tab or a closed panel', () => {
    const L0 = layout([[100, [[100, ['console', 'debug']]]]]);
    expect(activatePanel(L0, 'console')).toBeNull();
    expect(activatePanel(L0, 'chat')).toBeNull();
  });
});

describe('closeCell', () => {
  it('closes every tab in the cell, giving its height to the cell above', () => {
    const L0 = layout([[100, [[60, ['preview']], [40, ['console', 'debug']]]]]);
    const { layout: L, places } = closeCell(L0, 'cell3')!;
    expect(shapeOf(L)).toBe('preview>preview');
    expect(Object.keys(places).sort()).toEqual(['console', 'debug']);
    expect(places.debug).toMatchObject({ cell: 'cell3', column: 'col1', index: 1, cellIndex: 1, alone: false });
  });

  it('takes the column with it when it was the only cell, and its left neighbour takes the width', () => {
    const { layout: L } = closeCell(today(), 'cell4')!;
    expect(shapeOf(L)).toBe('chat>chat|files>files');
    expect(L.columns.map((c) => Math.round(c.size))).toEqual([70, 30]);
  });
});

describe('ungroup', () => {
  it('stacks the tabs in their column when each gets its minimum height', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[100, ['console', 'debug', 'checkpoints']]]]]);
    const r = ungroup(L0, 'cell4', BOX)!;
    expect(shapeOf(r.layout)).toBe('chat>chat|console>console/debug>debug/checkpoints>checkpoints');
    expect(r.stayed).toEqual([]);
  });

  it('makes new columns for what does not fit in the height', () => {
    // Three 420 px chats would not fit; two editors and a chat do not either, so some go right.
    const L0 = layout([[100, [[100, ['chat', 'preview', 'editor']]]]]);
    const r = ungroup(L0, 'cell2', BOX)!;
    expect(openPanels(r.layout).sort()).toEqual(['chat', 'editor', 'preview']);
    expect(checkLayout(r.layout, BOX)).toBeNull();
    expect(r.layout.columns.length).toBeGreaterThan(1);
  });

  it('leaves tabbed what has no room anywhere, and says which', () => {
    const tight = { w: 500, h: 500 };
    const L0 = layout([[100, [[100, ['chat', 'preview', 'files']]]]]);
    const r = ungroup(L0, 'cell2', tight)!;
    // No two fit stacked in 500 px, and the width takes two columns: the preview gets the second.
    expect(r.stayed).toEqual(['files']);
    expect(shapeOf(r.layout)).toBe('chat,files>chat|preview>preview');
    expect(checkLayout(r.layout, tight)).toBeNull();
  });

  it('does nothing to a cell that is not a group', () => {
    expect(ungroup(today(), 'cell2', BOX)).toBeNull();
  });
});

describe('fold', () => {
  it('shows the rightmost columns as tabs in the one before when the window is too narrow', () => {
    const narrow = { w: 600, h: 629 };
    const { layout: L, folded } = fold(today(), narrow);
    expect(shapeOf(L)).toBe('chat>chat|preview,files>preview');
    expect(folded).toBe(1);
    const g = geometry(L, narrow);
    expect(L.columns.every((c) => g.columns.get(c.id)!.w >= MIN_COLUMN_PX - 0.5)).toBe(true);
  });

  it('leaves a layout that fits as it is', () => {
    const L0 = today();
    expect(fold(L0, BOX)).toEqual({ layout: L0, folded: 0 });
  });

  it('lifts narrow columns to their minimum from the wide ones instead of folding, when that is enough', () => {
    const L0 = layout([[60, [[100, ['chat']]]], [25, [[100, ['preview']]]], [15, [[100, ['files']]]]]);
    const box = { w: 1200, h: 629 };
    const { layout: L, folded } = fold(L0, box);
    expect(folded).toBe(0);
    const g = geometry(L, box);
    const widths = L.columns.map((c) => Math.round(g.columns.get(c.id)!.w));
    // files was 175 px: it gets 240, and the 65 comes from chat and preview by what they have over 240.
    expect(widths[2]).toBe(240);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(1168);
  });

  it('folds into a column further left when the one before holds only the preview', () => {
    const L0 = layout([[34, [[100, ['chat']]]], [33, [[100, ['preview']]]], [33, [[100, ['elements']]]]]);
    const { layout: L } = fold(L0, { w: 600, h: 629 });
    expect(findPanel(L, 'elements')!.cell.tabs).toEqual(['chat', 'elements']);
  });

  it('keeps the Inspector out of the preview\'s tab group', () => {
    // The bottom cell is tried first, and it holds the preview.
    const L0 = layout([[34, [[100, ['chat']]]], [33, [[50, ['files']], [50, ['preview']]]], [33, [[100, ['elements']]]]]);
    const { layout: L } = fold(L0, { w: 600, h: 629 });
    expect(findPanel(L, 'elements')!.cell.tabs).toEqual(['files', 'elements']);
  });
});

describe('maximizedView', () => {
  it('is the one cell, filling the row', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[60, ['preview']], [40, ['console', 'debug*']]]]]);
    expect(shapeOf(maximizedView(L0, 'cell5')!)).toBe('console,debug>debug');
    expect(maximizedView(L0, 'nope')).toBeNull();
  });
});

describe('presets', () => {
  it('are recognised whatever their sizes and ids', () => {
    for (const name of ['columns', 'stacked', 'tabbed'] as const) {
      const L = presetLayout(name, 40);
      L.columns[0].size += 5;
      expect(presetOf(L)).toBe(name);
    }
    expect(presetOf(layout([[100, [[100, ['chat']]]]]))).toBeNull();
  });

  it('number their ids past the given counter', () => {
    const L = presetLayout('stacked', 40);
    const ids = L.columns.flatMap((c) => [c.id, ...c.cells.map((x) => x.id)]);
    expect(ids.every((id) => Number(id.replace(/\D/g, '')) > 40)).toBe(true);
    expect(L.seq).toBeGreaterThan(40);
  });
});

describe('ids', () => {
  it('are never handed out again after the cell that had them closes', () => {
    const L0 = layout([[50, [[100, ['chat']]]], [50, [[100, ['preview']]]]]);
    const opened = insertPanel(L0, 'files', { kind: 'column', before: null }, BOX)!;
    const filesCell = findPanel(opened, 'files')!.cell.id;
    const { layout: closed } = removePanel(opened, 'files')!;
    const again = insertPanel(closed, 'editor', { kind: 'column', before: null }, BOX)!;
    expect(findPanel(again, 'editor')!.cell.id).not.toBe(filesCell);
    const moved = movePanel(again, { panel: 'editor' }, { kind: 'tab', cell: 'cell2', index: null }, BOX)!;
    expect(moved.seq).toBe(again.seq);
  });
});
