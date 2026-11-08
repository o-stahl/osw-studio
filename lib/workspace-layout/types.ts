/**
 * The workspace layout: a row of columns, each a stack of cells, each cell a group of panels shown
 * as tabs. The layout before docking is the case of one panel per cell and one cell per column.
 */

export const PANEL_KEYS = ['chat', 'files', 'editor', 'preview', 'elements', 'skills', 'console', 'checkpoints', 'debug'] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];

export interface LayoutCell {
  id: string;
  /** Percent of its column's height. */
  size: number;
  /** In strip order; never empty. */
  tabs: PanelKey[];
  /** The tab in front. */
  active: PanelKey;
}

export interface LayoutColumn {
  id: string;
  /** Percent of the row's width. */
  size: number;
  /** Top to bottom; never empty. */
  cells: LayoutCell[];
}

export interface WorkspaceLayout {
  v: 1;
  /** Left to right. */
  columns: LayoutColumn[];
  /**
   * The highest id number handed out. New ids count on from it, so a closed cell's id never comes
   * back on a new cell, where a panel's remembered last place would find the wrong one.
   */
  seq?: number;
}

/** What a drag picks up: one panel (a tab or a title), or a whole cell (a tabbed group's grip). */
export type DragSource = { panel: PanelKey } | { cell: string };

/** Where a drop lands. */
export type DropTarget =
  /** A tab in a cell: at `index` in its strip, or at the end when `index` is null. */
  | { kind: 'tab'; cell: string; index: number | null }
  /** A new cell above or below a cell. */
  | { kind: 'stack'; cell: string; side: 'above' | 'below' }
  /** A new column before the column `before`, or after the last one when it is null. */
  | { kind: 'column'; before: string | null };

/** The pixel size of the area the columns fill. */
export interface Box {
  w: number;
  h: number;
}

/** Why a layout can't be shown, as a code the UI words. */
export type LayoutRefusal =
  | { code: 'width'; px: number }
  | { code: 'height'; panel: PanelKey; px: number }
  | { code: 'inspector-preview' };

/** The space a resize handle takes between two columns or cells: `w-2` plus `mx-1` either side. */
export const HANDLE_PX = 16;

/** The narrowest a column may be; the panels' min-width. */
export const MIN_COLUMN_PX = 240;

/**
 * The shortest each panel may be. The chat's header and composer take about 230 px, so 420 leaves
 * room for one assistant card.
 */
export const MIN_HEIGHT_PX: Record<PanelKey, number> = {
  chat: 420,
  files: 140,
  editor: 160,
  preview: 200,
  elements: 160,
  skills: 140,
  console: 120,
  checkpoints: 140,
  debug: 140,
};
