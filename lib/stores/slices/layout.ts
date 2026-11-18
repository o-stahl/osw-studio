import { StateCreator } from 'zustand';
import {
  activatePanel as activateInLayout,
  addTabBehind,
  bumpRecent,
  checkLayout,
  closeCell,
  defaultLayout,
  findCell,
  findPanel,
  fold,
  isPanelKey,
  layoutFromLegacy,
  maximizedView,
  movePanel as moveInLayout,
  openPanels,
  planOpen,
  presetLayout,
  removePanel,
  ungroup,
  validateLayout,
  type Box,
  type PanelFilter,
  type DragSource,
  type DropTarget,
  type LastPlace,
  type LayoutPreset,
  type PanelKey,
  type WorkspaceLayout,
} from '@/lib/workspace-layout';

type MobilePanelType = 'chat' | 'files' | 'editor' | 'preview' | 'elements' | 'checkpoints' | 'console' | 'skills' | 'debug';

const LAYOUT_KEY = 'osw-workspace-layout';
const HINT_KEY = 'osw-workspace-layout-hint';
/** Set once Canvas has been offered: added to a layout saved before it existed, or there from the start. */
const CANVAS_OFFERED_KEY = 'osw-workspace-canvas-offered';

/** Used until the workspace reports the size of its panel area. */
const FALLBACK_BOX: Box = { w: 1200, h: 700 };

/** How many layout changes Undo can take back. */
const HISTORY_MAX = 40;

type LastPlaces = Partial<Record<PanelKey, LastPlace>>;

/** What an Undo or a Redo puts back. */
interface LayoutSnapshot {
  layout: WorkspaceLayout;
  lastPlace: LastPlaces;
  recentPanels: PanelKey[];
  /**
   * When it was taken: in the history, when the change after it was made; in the future, when it was
   * undone. One key undoes whichever of the layout and the Inspector's edits changed last.
   */
  at: number;
}

/**
 * What the workspace draws for a control under the pointer: `rail`, what a rail button would do (open
 * the panel somewhere, bring it to the front, or close it); `reveal`, what putting it on screen would
 * do, which for a panel already in front is its outline; `outline`, the panel's outline alone.
 */
export type PanelHint = { kind: 'outline' | 'rail' | 'reveal'; panel: PanelKey };

/** What a rail button did. */
export type PanelChange = 'opened' | 'closed' | 'front' | null;

export interface LayoutSlice {
  showChat: boolean;
  showFiles: boolean;
  showEditor: boolean;
  showPreview: boolean;
  showCanvas: boolean;
  showCheckpoints: boolean;
  showConsole: boolean;
  showSkillsPanel: boolean;
  showDebugPanel: boolean;
  showElements: boolean;
  /**
   * Where the open panels are: columns of cells of tabs. Saved under `osw-workspace-layout`; the
   * show flags above are derived from it in the same `set()`, so their readers see one state. A flag
   * says a panel is open, which for a background tab is not the same as on screen.
   */
  layout: WorkspaceLayout;
  /**
   * Counts the changes to the layout other than divider drags. The workspace keys its splitters by it:
   * they take their sizes from the layout only when they mount.
   */
  layoutEpoch: number;
  /** Where each closed panel was, so the rail can open it there again. Saved with the layout. */
  lastPlace: LastPlaces;
  /** Panels by how recently they were in front, most recent first. Saved with the layout. */
  recentPanels: PanelKey[];
  /** The cell filling the workspace, or null. A view: never saved. */
  maximizedCell: string | null;
  /**
   * The open project's runtime can show Canvas. Presets and Reset layout leave Canvas out where it
   * can't, and the rail's button is disabled. Set by `initLayout` and `setCanvasAvailable`.
   */
  canvasAvailable: boolean;
  /** The layouts Undo goes back to, oldest first. This session only. */
  layoutHistory: LayoutSnapshot[];
  /** The layouts Redo brings back, the next one last. Filled by Undo, emptied by any other change. */
  layoutFuture: LayoutSnapshot[];
  /**
   * The panel area's size in pixels, reported by the workspace. Opening a column works out its width
   * in pixels, so that no column is squeezed under its minimum while another has room to give.
   */
  workspaceBox: Box | null;
  panelHint: PanelHint | null;
  /** The one-time "drag to rearrange" tip has been dismissed, or a panel dragged. */
  layoutHintDone: boolean;
  showProjectSettingsModal: boolean;
  /**
   * A section of the project settings dialog to bring into view once it opens, or null.
   *
   * Cleared by the dialog after it scrolls, so opening the dialog again by any other route does not
   * jump to whatever was last requested.
   */
  projectSettingsSection: string | null;
  fullscreenPreview: boolean;
  activeMobilePanel: MobilePanelType;
  mobileOverflowOpen: boolean;
  hasUnreadConsole: boolean;
  placedBlocks: any[];
  paletteOpen: boolean;
  /**
   * In the store (not useState) because both the preview crosshair and the Inspector's
   * Select element button need to read and write it.
   */
  focusToolArmed: boolean;
  /**
   * Hint for the crosshair tint while hovering the Select element button.
   * Cleared on press, unmount, and leave.
   */
  focusToolHinted: boolean;

  /** The rail: opens a closed panel, brings a background tab to the front, closes the front panel. */
  togglePanel: (panel: string) => PanelChange;
  /** Puts a panel on screen: opens it if closed, brings it to the front if behind. Never closes. */
  revealPanel: (panel: string) => PanelChange;
  closePanel: (panel: PanelKey) => boolean;
  /** Closes a cell and every panel in it. */
  closeGroup: (cellId: string) => boolean;
  /** Brings a background tab to the front. Not on the Undo stack. */
  activatePanel: (panel: PanelKey) => boolean;
  /** Moves a panel or a tab group; false when the move would change nothing or can't be shown. */
  movePanel: (source: DragSource, target: DropTarget) => boolean;
  applyLayoutPreset: (name: LayoutPreset) => void;
  /** The layout a workspace starts with, forgetting closed panels' places. */
  resetPanelLayout: () => void;
  /** Ungroup all; null when nothing could come out of the group. */
  ungroupCell: (cellId: string) => { stayed: PanelKey[] } | null;
  /** False when there is nothing to undo. */
  undoLayout: () => boolean;
  /** False when there is nothing to redo. */
  redoLayout: () => boolean;
  /** Maximizes a cell, or restores the layout when it is the maximized one or null. */
  toggleMaximize: (cellId: string | null) => void;
  /**
   * The column widths in percent, as the panel group reports them after a resize. A resize someone
   * made has a `step`, one per drag or per run of key presses on a divider: its first change goes on
   * the Undo stack and the rest join it. Without one (the group fitting its sizes to new minimums by
   * itself), the change is not undoable.
   */
  setColumnSizes: (sizes: number[], step?: string) => void;
  /** A column's cell heights in percent, as its panel group reports them after a resize; `step` as above. */
  setCellSizes: (columnId: string, sizes: number[], step?: string) => void;
  setWorkspaceBox: (box: Box) => void;
  setCanvasAvailable: (available: boolean) => void;
  setPanelHint: (hint: PanelHint | null) => void;
  dismissLayoutHint: () => void;
  setActiveMobilePanel: (panel: MobilePanelType) => void;
  setFullscreenPreview: (v: boolean) => void;
  setShowProjectSettingsModal: (v: boolean, section?: string) => void;
  clearProjectSettingsSection: () => void;
  setHasUnreadConsole: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;
  setMobileOverflowOpen: (v: boolean) => void;
  setFocusToolArmed: (armed: boolean) => void;
  setFocusToolHinted: (hinted: boolean) => void;
  /**
   * Loads the saved layout for a project being opened. `canvas` says whether its runtime can show
   * Canvas: the first time it can, a layout saved before Canvas existed gets it as a background tab
   * behind Live Preview, so nothing on screen changes on its own. `front` is the surface the project
   * opens on (`Project.settings.opensIn`): it comes forward for this visit where the two share a
   * group, and the saved layout is left as it was.
   */
  initLayout: (opts?: { canvas?: boolean; front?: 'canvas' | 'preview' }) => void;
  resetLayout: () => void;
}

export const PANEL_MAP: Record<string, keyof LayoutSlice> = {
  chat: 'showChat', files: 'showFiles', editor: 'showEditor', console: 'showConsole',
  preview: 'showPreview', canvas: 'showCanvas', elements: 'showElements', checkpoints: 'showCheckpoints',
  debug: 'showDebugPanel', skills: 'showSkillsPanel',
};

/** The panels a layout may hold for a runtime that can, or can't, show Canvas. */
export const panelFilter = (canvas: boolean): PanelFilter => (key) => canvas || key !== 'canvas';

/** The open panels, left to right. */
export function visiblePanelKeys(state: Pick<LayoutSlice, 'layout'>): string[] {
  return openPanels(state.layout);
}

/**
 * The layout as the workspace shows it: the saved one, or a narrow window's fold of it. Changes are
 * made to what is shown, since that is what the person acted on.
 */
export function layoutView(state: Pick<LayoutSlice, 'layout' | 'workspaceBox'>): WorkspaceLayout {
  return fold(state.layout, state.workspaceBox ?? FALLBACK_BOX).layout;
}

/** The size the layout operations work to: the panel area's, or a stand-in until it is measured. */
export const layoutBox = (state: Pick<LayoutSlice, 'workspaceBox'>): Box => state.workspaceBox ?? FALLBACK_BOX;

/** What is on screen: the view, or the maximized cell alone. */
export function shownLayout(state: Pick<LayoutSlice, 'layout' | 'workspaceBox' | 'maximizedCell'>): WorkspaceLayout {
  const view = layoutView(state);
  return (state.maximizedCell && maximizedView(view, state.maximizedCell)) || view;
}

/** The panel is on screen: open, in front of its cell, and not behind a maximized cell. */
export function panelOnScreen(state: Pick<LayoutSlice, 'layout' | 'workspaceBox' | 'maximizedCell'>, panel: PanelKey): boolean {
  const at = findPanel(shownLayout(state), panel);
  return !!at && at.cell.active === panel;
}

/** The show flags for a layout: a panel is shown when it is anywhere in it. */
function flagsFor(layout: WorkspaceLayout): Partial<LayoutSlice> {
  const open = new Set<string>(openPanels(layout));
  const flags: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(PANEL_MAP)) flags[flag] = open.has(key);
  return flags as Partial<LayoutSlice>;
}

function readJson(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

function validLastPlaces(raw: unknown): LastPlaces {
  const out: LastPlaces = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const p = value as Partial<LastPlace> | null;
    if (!isPanelKey(key) || !p || typeof p.cell !== 'string' || typeof p.column !== 'string') continue;
    if (typeof p.index !== 'number' || typeof p.cellIndex !== 'number' || typeof p.alone !== 'boolean') continue;
    if (p.before !== null && typeof p.before !== 'string') continue;
    out[key] = { cell: p.cell, column: p.column, index: p.index, cellIndex: p.cellIndex, alone: p.alone, before: p.before ?? null };
  }
  return out;
}

const validRecent = (raw: unknown): PanelKey[] => (Array.isArray(raw) ? [...new Set(raw.filter(isPanelKey))] : []);

interface Stored {
  layout: WorkspaceLayout;
  lastPlace: LastPlaces;
  recentPanels: PanelKey[];
}

/**
 * The saved layout with the closed panels' places and the recent order; for a workspace saved before
 * there was one, a layout built from the panel order, the open panels and the column widths
 * react-resizable-panels kept (the old keys are only read, never removed); for a new workspace, the
 * default layout, without the panels `has` refuses.
 */
function load(has: PanelFilter): Stored & { fresh: boolean } {
  const raw = readJson(LAYOUT_KEY) as { last?: unknown; recent?: unknown } | null;
  const layout = validateLayout(raw);
  if (layout) return { layout, lastPlace: validLastPlaces(raw?.last), recentPanels: validRecent(raw?.recent), fresh: false };
  const order = readJson('osw-workspace-panel-order');
  const open = readJson('osw-workspace-panels');
  const slots = readJson('react-resizable-panels:workspace-slots');
  if (order === null && open === null && slots === null) return { layout: defaultLayout(0, has), lastPlace: {}, recentPanels: [], fresh: true };
  return { layout: layoutFromLegacy(order, open, slots), lastPlace: {}, recentPanels: [], fresh: false };
}

function persist({ layout, lastPlace, recentPanels }: Stored) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...layout, last: lastPlace, recent: recentPanels }));
  } catch {}
}

/** Sizes change on every keypress of a keyboard resize, so they are written once they settle. */
let sizeTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(stored: Stored) {
  if (sizeTimer) clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    sizeTimer = null;
    persist(stored);
  }, 150);
}

const readFlag = (key: string) => {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
};
const writeFlag = (key: string) => {
  try { localStorage.setItem(key, '1'); } catch {}
};

/** What Undo or Redo puts back: the layout with the closed panels' places and the recent order. */
const snapshotOf = (s: Pick<LayoutSlice, 'layout' | 'lastPlace' | 'recentPanels'>): LayoutSnapshot =>
  ({ layout: s.layout, lastPlace: s.lastPlace, recentPanels: s.recentPanels, at: Date.now() });

/** When the change Undo would take back was made, or `null` with nothing to undo. */
export const layoutUndoAt = (s: Pick<LayoutSlice, 'layoutHistory'>): number | null =>
  s.layoutHistory[s.layoutHistory.length - 1]?.at ?? null;

/** When the change Redo would bring back was undone, or `null` with nothing to redo. */
export const layoutRedoAt = (s: Pick<LayoutSlice, 'layoutFuture'>): number | null =>
  s.layoutFuture[s.layoutFuture.length - 1]?.at ?? null;

const changed = (sizes: number[], items: { size: number }[]) =>
  sizes.length === items.length && sizes.some((size, i) => Math.abs(size - items[i].size) > 0.05);

interface CommitOptions {
  /** Goes on the Undo stack. */
  undoable?: boolean;
  /** A maximized cell stays maximized (a tab switch inside it). */
  keepMax?: boolean;
  lastPlace?: LastPlaces;
  recentPanels?: PanelKey[];
}

export const createLayoutSlice: StateCreator<LayoutSlice> = (set, get) => {
  const initial = load(panelFilter(true));
  const box = () => get().workspaceBox ?? FALLBACK_BOX;

  /** The resize step whose first change is the last one on the Undo stack; any other change ends it. */
  let resizeStep: string | null = null;

  const commit = (next: WorkspaceLayout, opts: CommitOptions = {}) => {
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = null; }
    resizeStep = null;
    const s = get();
    const lastPlace = opts.lastPlace ?? s.lastPlace;
    const recentPanels = opts.recentPanels ?? s.recentPanels;
    const history = opts.undoable ? [...s.layoutHistory, snapshotOf(s)].slice(-HISTORY_MAX) : s.layoutHistory;
    const keepMax = opts.keepMax && s.maximizedCell && findCell(next, s.maximizedCell) ? s.maximizedCell : null;
    set({
      layout: next,
      layoutEpoch: s.layoutEpoch + 1,
      ...flagsFor(next),
      lastPlace,
      recentPanels,
      layoutHistory: history,
      layoutFuture: [],
      maximizedCell: keepMax,
    } as Partial<LayoutSlice>);
    persist({ layout: next, lastPlace, recentPanels });
  };

  /** New sizes for the layout shown; the first of a step puts the layout before it on the Undo stack. */
  const resize = (next: WorkspaceLayout, step: string | undefined) => {
    const s = get();
    const record = !!step && step !== resizeStep;
    if (record) resizeStep = step;
    set(record
      ? { layout: next, layoutHistory: [...s.layoutHistory, snapshotOf(s)].slice(-HISTORY_MAX), layoutFuture: [] }
      : { layout: next });
    persistSoon({ layout: next, lastPlace: s.lastPlace, recentPanels: s.recentPanels });
  };

  /** Puts a layout from the Undo or Redo stack back, with the stacks it leaves. */
  const restore = (snapshot: LayoutSnapshot, stacks: Pick<LayoutSlice, 'layoutHistory' | 'layoutFuture'>) => {
    if (sizeTimer) { clearTimeout(sizeTimer); sizeTimer = null; }
    resizeStep = null;
    set({
      layout: snapshot.layout,
      layoutEpoch: get().layoutEpoch + 1,
      ...flagsFor(snapshot.layout),
      lastPlace: snapshot.lastPlace,
      recentPanels: snapshot.recentPanels,
      ...stacks,
      maximizedCell: null,
    } as Partial<LayoutSlice>);
    persist(snapshot);
  };

  /** Opens a closed panel where `planOpen` says. */
  const open = (panel: PanelKey, undoable: boolean): boolean => {
    const s = get();
    const plan = planOpen(layoutView(s), panel, box(), { lastPlace: s.lastPlace[panel], recent: s.recentPanels });
    if (!plan) return false;
    commit(plan.layout, { undoable, recentPanels: bumpRecent(s.recentPanels, panel) });
    return true;
  };

  /** Brings a panel forward; with a different cell maximized, the layout comes back so it shows. */
  const bringForward = (panel: PanelKey): boolean => {
    const s = get();
    const view = layoutView(s);
    const at = findPanel(view, panel);
    if (!at) return false;
    const hidden = s.maximizedCell !== null && s.maximizedCell !== at.cell.id;
    const next = activateInLayout(view, panel);
    if (next) {
      commit(next, { keepMax: !hidden, recentPanels: bumpRecent(s.recentPanels, panel) });
      return true;
    }
    if (hidden) {
      set({ maximizedCell: null });
      return true;
    }
    return false;
  };

  return {
    ...(flagsFor(initial.layout) as Pick<LayoutSlice, 'showChat' | 'showFiles' | 'showEditor' | 'showPreview' | 'showCanvas' | 'showCheckpoints' | 'showConsole' | 'showSkillsPanel' | 'showDebugPanel' | 'showElements'>),
    layout: initial.layout,
    layoutEpoch: 0,
    lastPlace: initial.lastPlace,
    recentPanels: initial.recentPanels,
    maximizedCell: null,
    canvasAvailable: true,
    layoutHistory: [],
    layoutFuture: [],
    workspaceBox: null,
    panelHint: null,
    layoutHintDone: readFlag(HINT_KEY),
    showProjectSettingsModal: false,
    projectSettingsSection: null,
    fullscreenPreview: false,
    activeMobilePanel: 'preview',
    mobileOverflowOpen: false,
    hasUnreadConsole: false,
    placedBlocks: [],
    paletteOpen: false,
    focusToolArmed: false,
    focusToolHinted: false,

    togglePanel: (panel) => {
      if (!isPanelKey(panel)) return null;
      const s = get();
      const at = findPanel(layoutView(s), panel);
      if (!at) return open(panel, true) ? 'opened' : null;
      const hidden = s.maximizedCell !== null && s.maximizedCell !== at.cell.id;
      if (at.cell.active !== panel || hidden) return bringForward(panel) ? 'front' : null;
      return get().closePanel(panel) ? 'closed' : null;
    },

    revealPanel: (panel) => {
      if (!isPanelKey(panel)) return null;
      if (!findPanel(layoutView(get()), panel)) return open(panel, false) ? 'opened' : null;
      return bringForward(panel) ? 'front' : null;
    },

    closePanel: (panel) => {
      const s = get();
      const removed = removePanel(layoutView(s), panel, { recent: s.recentPanels });
      if (!removed) return false;
      commit(removed.layout, { undoable: true, lastPlace: { ...s.lastPlace, [panel]: removed.place } });
      return true;
    },

    closeGroup: (cellId) => {
      const s = get();
      const closed = closeCell(layoutView(s), cellId);
      if (!closed) return false;
      commit(closed.layout, { undoable: true, lastPlace: { ...s.lastPlace, ...closed.places } });
      return true;
    },

    activatePanel: (panel) => bringForward(panel),

    movePanel: (source, target) => {
      const s = get();
      const view = layoutView(s);
      const next = moveInLayout(view, source, target, box(), { recent: s.recentPanels });
      if (!next || checkLayout(next, box())) return false;
      const front = 'panel' in source ? source.panel : findCell(view, source.cell)?.cell.active;
      commit(next, { undoable: true, recentPanels: front ? bumpRecent(s.recentPanels, front) : s.recentPanels });
      return true;
    },

    applyLayoutPreset: (name) => {
      const s = get();
      commit(presetLayout(name, s.layout.seq ?? 0, panelFilter(s.canvasAvailable)), { undoable: true });
    },

    resetPanelLayout: () => {
      const s = get();
      commit(defaultLayout(s.layout.seq ?? 0, panelFilter(s.canvasAvailable)), { undoable: true, lastPlace: {}, recentPanels: [] });
    },

    ungroupCell: (cellId) => {
      const s = get();
      const result = ungroup(layoutView(s), cellId, box(), s.recentPanels);
      if (!result) return null;
      commit(result.layout, { undoable: true });
      return { stayed: result.stayed };
    },

    undoLayout: () => {
      const s = get();
      const last = s.layoutHistory[s.layoutHistory.length - 1];
      if (!last) return false;
      restore(last, { layoutHistory: s.layoutHistory.slice(0, -1), layoutFuture: [...s.layoutFuture, snapshotOf(s)] });
      return true;
    },

    redoLayout: () => {
      const s = get();
      const next = s.layoutFuture[s.layoutFuture.length - 1];
      if (!next) return false;
      restore(next, { layoutHistory: [...s.layoutHistory, snapshotOf(s)].slice(-HISTORY_MAX), layoutFuture: s.layoutFuture.slice(0, -1) });
      return true;
    },

    toggleMaximize: (cellId) => {
      const s = get();
      const next = cellId && cellId !== s.maximizedCell && findCell(layoutView(s), cellId) ? cellId : null;
      if (next !== s.maximizedCell) set({ maximizedCell: next, panelHint: null });
    },

    setColumnSizes: (sizes, step) => {
      const view = layoutView(get());
      if (!changed(sizes, view.columns)) return;
      // A resize while a narrow window is folded saves what is shown, like any other change made then.
      resize({ ...view, columns: view.columns.map((col, i) => ({ ...col, size: sizes[i] })) }, step);
    },

    setCellSizes: (columnId, sizes, step) => {
      const view = layoutView(get());
      const col = view.columns.find((c) => c.id === columnId);
      if (!col || !changed(sizes, col.cells)) return;
      resize({
        ...view,
        columns: view.columns.map((c) => (c.id === columnId ? { ...c, cells: c.cells.map((cell, i) => ({ ...cell, size: sizes[i] })) } : c)),
      }, step);
    },

    setWorkspaceBox: (next) => {
      const current = get().workspaceBox;
      if (current && Math.abs(current.w - next.w) < 1 && Math.abs(current.h - next.h) < 1) return;
      set({ workspaceBox: next });
    },

    setCanvasAvailable: (available) => {
      if (get().canvasAvailable !== available) set({ canvasAvailable: available });
    },

    setPanelHint: (hint) => {
      const current = get().panelHint;
      if (current === hint || (current && hint && current.kind === hint.kind && current.panel === hint.panel)) return;
      set({ panelHint: hint });
    },

    dismissLayoutHint: () => {
      if (get().layoutHintDone) return;
      set({ layoutHintDone: true });
      writeFlag(HINT_KEY);
    },

    setActiveMobilePanel: (panel) => set({ activeMobilePanel: panel, mobileOverflowOpen: false }),

    setFullscreenPreview: (v) => set({ fullscreenPreview: v }),
    setShowProjectSettingsModal: (v, section) =>
      set({ showProjectSettingsModal: v, projectSettingsSection: v ? section ?? null : null }),
    clearProjectSettingsSection: () => set({ projectSettingsSection: null }),
    setHasUnreadConsole: (v) => set({ hasUnreadConsole: v }),
    setPaletteOpen: (v) => set({ paletteOpen: v }),
    setMobileOverflowOpen: (v) => set({ mobileOverflowOpen: v }),
    setFocusToolArmed: (armed) => set({ focusToolArmed: armed }),
    setFocusToolHinted: (hinted) => set({ focusToolHinted: hinted }),

    initLayout: (opts = {}) => {
      const canvas = opts.canvas ?? get().canvasAvailable;
      const next = load(panelFilter(canvas));
      if (canvas && !readFlag(CANVAS_OFFERED_KEY)) {
        writeFlag(CANVAS_OFFERED_KEY);
        const offered = next.fresh ? null : addTabBehind(next.layout, 'canvas', 'preview', box());
        if (offered) {
          next.layout = offered;
          persist(next);
        }
      }
      // The project's own surface (`Project.settings.opensIn`) comes forward where Canvas and Live
      // Preview are tabs of one group. For this visit only: the saved layout is the person's, and
      // the next project without a preference opens as they left it. A runtime without Canvas opens
      // on Live Preview, not on Canvas's note that it is unavailable.
      const front = canvas ? opts.front : 'preview';
      if (front) {
        const at = findPanel(next.layout, front);
        const other = front === 'canvas' ? 'preview' : 'canvas';
        if (at && at.cell.tabs.includes(other)) next.layout = activateInLayout(next.layout, front) ?? next.layout;
      }
      set({
        canvasAvailable: canvas,
        layout: next.layout,
        layoutEpoch: get().layoutEpoch + 1,
        ...flagsFor(next.layout),
        lastPlace: next.lastPlace,
        recentPanels: next.recentPanels,
        layoutHistory: [],
        layoutFuture: [],
        maximizedCell: null,
        layoutHintDone: readFlag(HINT_KEY),
      } as Partial<LayoutSlice>);
      resizeStep = null;
    },

    resetLayout: () => {
      set({
        panelHint: null,
        maximizedCell: null,
        mobileOverflowOpen: false,
        showProjectSettingsModal: false,
        fullscreenPreview: false,
        paletteOpen: false,
        focusToolArmed: false,
        focusToolHinted: false,
      });
    },
  };
};
