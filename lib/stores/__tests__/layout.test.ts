import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLocalStorage: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mockLocalStorage[key] ?? null,
  setItem: (key: string, value: string) => { mockLocalStorage[key] = value; },
  removeItem: (key: string) => { delete mockLocalStorage[key]; },
});

import { createStore } from 'zustand/vanilla';
import { createLayoutSlice, LayoutSlice, PANEL_MAP, panelOnScreen, shownLayout, visiblePanelKeys } from '../slices/layout';
import { findPanel, layoutFromLegacy, openPanels, shapeOf, type PanelKey, type WorkspaceLayout } from '@/lib/workspace-layout';

/** One column per panel, left to right, at even widths. */
const columnsOf = (...keys: PanelKey[]): WorkspaceLayout => ({
  v: 1,
  columns: keys.map((key, i) => ({ id: `col${i + 1}`, size: 100 / keys.length, cells: [{ id: `cell${i + 1}`, size: 100, tabs: [key], active: key }] })),
});
const savedLayout = () => JSON.parse(mockLocalStorage['osw-workspace-layout']) as WorkspaceLayout;
const widths = (layout: WorkspaceLayout) => layout.columns.map((col) => Math.round(col.size));

function createLayoutStore() {
  return createStore<LayoutSlice>()((...a) => ({
    ...createLayoutSlice(...a),
  }));
}

describe('layout slice', () => {
  let store: ReturnType<typeof createLayoutStore>;

  beforeEach(() => {
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
    store = createLayoutStore();
  });

  it('starts with default panel visibility', () => {
    const s = store.getState();
    expect(s.showChat).toBe(true);
    expect(s.showFiles).toBe(true);
    expect(s.showEditor).toBe(false);
    expect(s.showPreview).toBe(true);
  });

  it('togglePanel flips visibility', () => {
    store.getState().togglePanel('editor');
    expect(store.getState().showEditor).toBe(true);
    store.getState().togglePanel('editor');
    expect(store.getState().showEditor).toBe(false);
  });

  it('movePanel moves a column whole, keeps every width, and saves it', () => {
    store.setState({ layout: { ...columnsOf('chat', 'preview', 'files'), columns: columnsOf('chat', 'preview', 'files').columns.map((col, i) => ({ ...col, size: [25, 50, 25][i] })) } });
    const moved = store.getState().movePanel({ panel: 'files' }, { kind: 'column', before: 'col1' });
    expect(moved).toBe(true);
    expect(visiblePanelKeys(store.getState())).toEqual(['files', 'chat', 'preview']);
    expect(widths(store.getState().layout)).toEqual([25, 25, 50]);
    expect(openPanels(savedLayout())).toEqual(['files', 'chat', 'preview']);
  });

  it('movePanel answers false and changes nothing for a drop where the panel already is', () => {
    const before = store.getState().layout;
    expect(store.getState().movePanel({ panel: 'files' }, { kind: 'column', before: null })).toBe(false);
    expect(store.getState().layout).toBe(before);
  });

  it('closing a panel gives its width to the column on its left', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'files') });
    store.getState().togglePanel('preview');
    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'files']);
    expect(widths(store.getState().layout)).toEqual([67, 33]);
  });

  it('opening a panel at three columns adds it as a tab in the rightmost cell and closes nothing', () => {
    store.setState({ layout: { ...columnsOf('chat', 'preview', 'files'), columns: columnsOf('chat', 'preview', 'files').columns.map((col, i) => ({ ...col, size: [25, 45, 30][i] })) } });
    expect(store.getState().togglePanel('editor')).toBe('opened');
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview>preview|files,editor>editor');
    expect(widths(store.getState().layout)).toEqual([25, 45, 30]);
    expect(store.getState().showFiles).toBe(true);
    expect(store.getState().showEditor).toBe(true);
  });

  it('the rail brings a background tab to the front, then closes it', () => {
    store.setState({ layout: { v: 1, columns: [{ id: 'col1', size: 100, cells: [{ id: 'cell1', size: 100, tabs: ['console', 'debug'], active: 'console' }] }] } });
    expect(store.getState().togglePanel('debug')).toBe('front');
    expect(store.getState().layout.columns[0].cells[0].active).toBe('debug');
    expect(store.getState().togglePanel('debug')).toBe('closed');
    expect(store.getState().showDebugPanel).toBe(false);
    expect(store.getState().showConsole).toBe(true);
  });

  it('revealPanel opens or brings forward, and never closes', () => {
    store.setState({ layout: { v: 1, columns: [{ id: 'col1', size: 100, cells: [{ id: 'cell1', size: 100, tabs: ['files', 'editor'], active: 'files' }] }] } });
    expect(store.getState().revealPanel('editor')).toBe('front');
    expect(store.getState().revealPanel('editor')).toBeNull();
    expect(store.getState().showEditor).toBe(true);
    expect(store.getState().revealPanel('chat')).toBe('opened');
    expect(store.getState().showChat).toBe(true);
  });

  it('a closed panel opens where it was', () => {
    store.setState({ layout: { v: 1, columns: [
      { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
      { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 60, tabs: ['preview'], active: 'preview' }, { id: 'cell5', size: 40, tabs: ['console'], active: 'console' }] },
    ] } });
    store.getState().closePanel('console');
    expect(store.getState().lastPlace.console).toMatchObject({ column: 'col3', cellIndex: 1 });
    store.getState().togglePanel('console');
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview>preview/console>console');
  });

  it('closeGroup closes every panel in the cell, and each remembers it', () => {
    store.setState({ layout: { v: 1, columns: [
      { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
      { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'debug' }] },
    ] } });
    expect(store.getState().closeGroup('cell4')).toBe(true);
    expect(openPanels(store.getState().layout)).toEqual(['chat']);
    expect(Object.keys(store.getState().lastPlace).sort()).toEqual(['console', 'debug']);
  });

  it('reopens a panel from a closed group in the column the group had to itself', () => {
    store.setState({ layout: { v: 1, columns: [
      { id: 'col1', size: 34, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
      { id: 'col3', size: 33, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'debug' }] },
      { id: 'col5', size: 33, cells: [{ id: 'cell6', size: 100, tabs: ['preview'], active: 'preview' }] },
    ] } });
    store.getState().closeGroup('cell4');
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview>preview');
    store.getState().togglePanel('console');
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|console>console|preview>preview');
  });

  it('movePanel refuses a layout that cannot be shown', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'elements') });
    const before = store.getState().layout;
    expect(store.getState().movePanel({ panel: 'elements' }, { kind: 'tab', cell: 'cell2', index: null })).toBe(false);
    expect(store.getState().layout).toBe(before);
  });

  describe('undo', () => {
    it('takes back moves, opens and closes, newest first', () => {
      store.setState({ layout: columnsOf('chat', 'preview', 'files') });
      const start = shapeOf(store.getState().layout);
      store.getState().movePanel({ panel: 'files' }, { kind: 'tab', cell: 'cell1', index: null });
      const moved = shapeOf(store.getState().layout);
      store.getState().closePanel('preview');
      expect(store.getState().undoLayout()).toBe(true);
      expect(shapeOf(store.getState().layout)).toBe(moved);
      expect(store.getState().undoLayout()).toBe(true);
      expect(shapeOf(store.getState().layout)).toBe(start);
      expect(store.getState().undoLayout()).toBe(false);
    });

    it('leaves out tab switches and resizes', () => {
      store.setState({ layout: { v: 1, columns: [
        { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
        { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
      ] } });
      store.getState().activatePanel('debug');
      store.getState().setColumnSizes([60, 40]);
      expect(store.getState().layoutHistory).toHaveLength(0);
      expect(store.getState().undoLayout()).toBe(false);
    });

    it('puts back the places the change forgot', () => {
      store.setState({ layout: columnsOf('chat', 'preview', 'files') });
      store.getState().closePanel('files');
      store.getState().resetPanelLayout();
      expect(store.getState().lastPlace).toEqual({});
      store.getState().undoLayout();
      expect(Object.keys(store.getState().lastPlace)).toEqual(['files']);
    });
  });

  describe('maximize', () => {
    const grouped = (): WorkspaceLayout => ({ v: 1, columns: [
      { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
      { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
    ] });

    it('toggles a cell, and is never saved', () => {
      store.setState({ layout: grouped() });
      store.getState().toggleMaximize('cell4');
      expect(store.getState().maximizedCell).toBe('cell4');
      store.getState().closePanel('chat');
      expect(store.getState().maximizedCell).toBeNull();
      store.getState().undoLayout();
      store.getState().toggleMaximize('cell4');
      store.getState().toggleMaximize('cell4');
      expect(store.getState().maximizedCell).toBeNull();
      expect(JSON.stringify(savedLayout())).not.toContain('maxim');
    });

    it('ends with an undo, so the change it takes back is on screen', () => {
      store.setState({ layout: grouped() });
      expect(store.getState().movePanel({ panel: 'debug' }, { kind: 'stack', cell: 'cell4', side: 'below' })).toBe(true);
      store.getState().toggleMaximize('cell2');
      expect(store.getState().maximizedCell).toBe('cell2');
      store.getState().undoLayout();
      expect(shapeOf(store.getState().layout)).toBe(shapeOf(grouped()));
      expect(store.getState().maximizedCell).toBeNull();
    });

    it('survives a tab switch inside the cell, and gives way to a panel in another', () => {
      store.setState({ layout: grouped() });
      store.getState().toggleMaximize('cell4');
      store.getState().activatePanel('debug');
      expect(store.getState().maximizedCell).toBe('cell4');
      expect(store.getState().togglePanel('chat')).toBe('front');
      expect(store.getState().maximizedCell).toBeNull();
      expect(store.getState().showChat).toBe(true);
    });
  });

  it('applies a preset and puts the old layout back on undo', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'files') });
    store.getState().applyLayoutPreset('tabbed');
    expect(shapeOf(store.getState().layout)).toBe('chat,checkpoints,debug>chat|preview>preview|editor,files,skills>editor');
    store.getState().undoLayout();
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview>preview|files>files');
  });

  it('ungroupCell takes a group apart', () => {
    store.setState({ layout: { v: 1, columns: [
      { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
      { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
    ] } });
    expect(store.getState().ungroupCell('cell4')).toEqual({ stayed: [] });
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|console>console/debug>debug');
    expect(store.getState().ungroupCell('cell2')).toBeNull();
  });

  it('counts layout changes, but not divider drags, so the splitters remount only for the first', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'files') });
    const epoch = store.getState().layoutEpoch;
    store.getState().setColumnSizes([40, 35, 25]);
    expect(store.getState().layoutEpoch).toBe(epoch);
    store.getState().closePanel('files');
    expect(store.getState().layoutEpoch).toBe(epoch + 1);
  });

  it('keeps closed panels\' places and the recent order across a reload', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'files') });
    store.getState().closePanel('files');
    store.getState().activatePanel('chat');
    const revived = createLayoutStore().getState();
    expect(revived.lastPlace.files).toMatchObject({ column: 'col3', alone: true });
    expect(revived.recentPanels).toEqual(store.getState().recentPanels);
  });

  it('saves what is shown when a folded window is resized', () => {
    store.setState({ layout: columnsOf('chat', 'preview', 'files'), workspaceBox: { w: 600, h: 700 } });
    store.getState().setColumnSizes([45, 55]);
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview,files>preview');
    expect(widths(store.getState().layout)).toEqual([45, 55]);
  });

  it('remembers that the drag tip was dismissed', () => {
    store.getState().dismissLayoutHint();
    expect(createLayoutStore().getState().layoutHintDone).toBe(true);
  });

  it('keeps a divider drag, and saves it once it settles', () => {
    vi.useFakeTimers();
    try {
      store.setState({ layout: columnsOf('chat', 'preview', 'files') });
      store.getState().setColumnSizes([40, 35, 25]);
      expect(widths(store.getState().layout)).toEqual([40, 35, 25]);
      expect(mockLocalStorage['osw-workspace-layout']).toBeUndefined();
      vi.advanceTimersByTime(200);
      expect(widths(savedLayout())).toEqual([40, 35, 25]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a cell height change for its own column only', () => {
    store.setState({ layout: { v: 1, columns: [
      { id: 'col1', size: 50, cells: [{ id: 'cell1', size: 50, tabs: ['chat'], active: 'chat' }, { id: 'cell2', size: 50, tabs: ['console'], active: 'console' }] },
      { id: 'col2', size: 50, cells: [{ id: 'cell3', size: 100, tabs: ['preview'], active: 'preview' }] },
    ] } });
    store.getState().setCellSizes('col1', [70, 30]);
    expect(store.getState().layout.columns[0].cells.map((c) => c.size)).toEqual([70, 30]);
    expect(store.getState().layout.columns[1].cells[0].size).toBe(100);
  });

  it('ignores sizes for a different number of columns', () => {
    const before = store.getState().layout;
    store.getState().setColumnSizes([50, 50]);
    expect(store.getState().layout).toBe(before);
  });

  it('setActiveMobilePanel sets panel and closes overflow', () => {
    store.setState({ mobileOverflowOpen: true });
    store.getState().setActiveMobilePanel('editor');
    expect(store.getState().activeMobilePanel).toBe('editor');
    expect(store.getState().mobileOverflowOpen).toBe(false);
  });

  it('setPanelHint holds one hint, and the same hint twice changes nothing', () => {
    store.getState().setPanelHint({ kind: 'rail', panel: 'editor' });
    const hint = store.getState().panelHint;
    store.getState().setPanelHint({ kind: 'rail', panel: 'editor' });
    expect(store.getState().panelHint).toBe(hint);
    store.getState().setPanelHint(null);
    expect(store.getState().panelHint).toBeNull();
  });

  it('resetLayout clears transient state but keeps panel visibility', () => {
    store.getState().togglePanel('editor');
    store.setState({ maximizedCell: 'cell1', panelHint: { kind: 'outline', panel: 'chat' }, mobileOverflowOpen: true });
    store.getState().resetLayout();
    expect(store.getState().maximizedCell).toBeNull();
    expect(store.getState().panelHint).toBeNull();
    expect(store.getState().mobileOverflowOpen).toBe(false);
    expect(store.getState().showEditor).toBe(true); // preserved
  });

  it('initLayout builds the layout from a stored order and open panels when there is no saved layout', () => {
    // An existing user's stored order was written before the Elements panel existed. The stored
    // sequence must survive, and opening the panel it predates must still work.
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(['preview', 'chat', 'files', 'editor', 'skills', 'console', 'checkpoints', 'debug']);
    mockLocalStorage['osw-workspace-panels'] = JSON.stringify({ chat: true, files: false, editor: true, preview: true });
    store.getState().initLayout();
    expect(visiblePanelKeys(store.getState())).toEqual(['preview', 'chat', 'editor']);
    expect(store.getState().showFiles).toBe(false);
    expect(store.getState().showEditor).toBe(true);
  });

  it('drops unknown keys from a stored order', () => {
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(['chat', 'ghost-panel', 'files']);
    store.getState().initLayout();
    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'files', 'preview']);
  });

  it('carries over the column widths the panel library saved for the open panels', () => {
    mockLocalStorage['react-resizable-panels:workspace-slots'] = JSON.stringify({
      'panel-chat,panel-files,panel-preview': { expandToSizes: {}, layout: [22, 48, 30] },
    });
    expect(widths(createLayoutStore().getState().layout)).toEqual([22, 48, 30]);
  });

  it('prefers a saved layout to the old keys', () => {
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(['files', 'chat', 'preview']);
    mockLocalStorage['osw-workspace-layout'] = JSON.stringify(columnsOf('editor', 'preview'));
    expect(visiblePanelKeys(createLayoutStore().getState())).toEqual(['editor', 'preview']);
  });

  it('falls back to the old keys when the saved layout is not one', () => {
    mockLocalStorage['osw-workspace-layout'] = JSON.stringify({ v: 1, columns: [{ id: 'a', size: 100, cells: [{ id: 'b', size: 100, tabs: ['ghost'], active: 'ghost' }] }] });
    expect(visiblePanelKeys(createLayoutStore().getState())).toEqual(['chat', 'preview', 'files']);
  });

  describe('elements panel registration', () => {
    it('is hidden by default and is a known panel', () => {
      expect(store.getState().showElements).toBe(false);
      expect(PANEL_MAP.elements).toBe('showElements');
    });

    it('togglePanel flips it and persists it', () => {
      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(true);
      expect(openPanels(savedLayout())).toContain('elements');

      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(false);
      expect(openPanels(savedLayout())).not.toContain('elements');
    });

    it('restores a persisted open state on a fresh store', () => {
      store.getState().togglePanel('elements');
      const revived = createLayoutStore();
      expect(revived.getState().showElements).toBe(true);
    });

    it('opening it joins the File Explorer and closes nothing', () => {
      // Defaults are chat + preview + files, three columns already: the Inspector's group is the
      // File Explorer's, so it opens as a tab there and the preview it reads stays where it is.
      store.getState().togglePanel('elements');

      expect(findPanel(store.getState().layout, 'elements')!.cell.tabs).toEqual(['files', 'elements']);
      expect(store.getState().showPreview).toBe(true);
      expect(visiblePanelKeys(store.getState())).toHaveLength(4);
    });

    it('never opens into a tab group with the preview', () => {
      // Three columns and no File Explorer: the rightmost cell gets it, unless that cell is the preview.
      store.setState({ layout: layoutFromLegacy(['editor', 'console', 'preview'], { chat: false, files: false, editor: true, console: true, preview: true }, null) });
      expect(visiblePanelKeys(store.getState())).toEqual(['editor', 'console', 'preview']);
      store.getState().togglePanel('elements');
      expect(findPanel(store.getState().layout, 'elements')!.cell.tabs).not.toContain('preview');
      expect(store.getState().showPreview).toBe(true);
    });

    it('closing it is always allowed and never evicts anything', () => {
      store.getState().togglePanel('elements');
      const before = visiblePanelKeys(store.getState()).filter(k => k !== 'elements');
      store.getState().togglePanel('elements');
      expect(store.getState().showElements).toBe(false);
      expect(visiblePanelKeys(store.getState())).toEqual(before);
    });
  });

  /**
   * The element picker's armed flag.
   *
   * It is here rather than in `multipage-preview`'s own `useState` so that a *second* control can arm
   * it — the Styles tab's `Select element` button, which cannot reach a ref that is still null at the
   * moment it opens the panel that mounts the preview. These assertions are what stop it drifting
   * back into being persisted layout or surviving a project switch.
   */
  describe('focusToolArmed', () => {
    it('starts disarmed and is set by setFocusToolArmed', () => {
      expect(store.getState().focusToolArmed).toBe(false);
      store.getState().setFocusToolArmed(true);
      expect(store.getState().focusToolArmed).toBe(true);
      store.getState().setFocusToolArmed(false);
      expect(store.getState().focusToolArmed).toBe(false);
    });

    it('is never persisted, so a reload does not come up armed', () => {
      store.getState().setFocusToolArmed(true);
      // Something else has to write the panels key, since arming must not write it itself.
      store.getState().togglePanel('editor');
      expect(JSON.parse(mockLocalStorage['osw-workspace-layout'])).not.toHaveProperty('focusToolArmed');
      expect(createLayoutStore().getState().focusToolArmed).toBe(false);
    });

    it('is cleared by resetLayout, so it cannot follow you to the next project', () => {
      // resetLayout runs unconditionally in the workspace's unmount cleanup. An armed picker left
      // behind would make the next project's preview swallow its first click.
      store.getState().setFocusToolArmed(true);
      store.getState().resetLayout();
      expect(store.getState().focusToolArmed).toBe(false);
    });
  });

  /**
   * The hover hint that links the Inspector's `Select element` button to the preview header's
   * crosshair — two controls for one tool, in components whose nearest common ancestor is the
   * workspace, which is why a hover has to travel through the store at all.
   *
   * Nothing behaves differently while it is true; it is a tint. That is exactly why it needs these
   * assertions: a stuck hint is invisible to every other test in the suite and shows up only as a
   * crosshair that is mysteriously highlighted with the pointer nowhere near it.
   */
  describe('focusToolHinted', () => {
    it('starts clear and is set by setFocusToolHinted', () => {
      expect(store.getState().focusToolHinted).toBe(false);
      store.getState().setFocusToolHinted(true);
      expect(store.getState().focusToolHinted).toBe(true);
      store.getState().setFocusToolHinted(false);
      expect(store.getState().focusToolHinted).toBe(false);
    });

    it('is never persisted — a reload cannot come up hinting at a pointer that is gone', () => {
      store.getState().setFocusToolHinted(true);
      // Something else has to write the panels key, since hinting must not write it itself.
      store.getState().togglePanel('editor');
      expect(JSON.parse(mockLocalStorage['osw-workspace-layout'])).not.toHaveProperty('focusToolHinted');
      expect(createLayoutStore().getState().focusToolHinted).toBe(false);
    });

    it('is cleared by resetLayout', () => {
      store.getState().setFocusToolHinted(true);
      store.getState().resetLayout();
      expect(store.getState().focusToolHinted).toBe(false);
    });

    it('is independent of the armed flag — arming is not hinting', () => {
      // They travel together through one handler but mean different things: one is a mode the next
      // click obeys, the other is a pointer's whereabouts. Tying them would tint the crosshair for
      // as long as the picker stayed armed.
      store.getState().setFocusToolHinted(true);
      expect(store.getState().focusToolArmed).toBe(false);
      store.getState().setFocusToolArmed(true);
      store.getState().setFocusToolHinted(false);
      expect(store.getState().focusToolArmed).toBe(true);
    });
  });

  describe('projectSettingsSection', () => {
    it('starts null, since nothing has asked for a section', () => {
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('holds the section the opener asked for', () => {
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      expect(store.getState().showProjectSettingsModal).toBe(true);
      expect(store.getState().projectSettingsSection).toBe('suggestions');
    });

    it('opens with no section when none was asked for', () => {
      store.getState().setShowProjectSettingsModal(true);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('does not carry a section into the next open by another route', () => {
      // The whole point of the field: a later open must not jump to what was last requested.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false);
      store.getState().setShowProjectSettingsModal(true);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared when the dialog closes', () => {
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false);
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared on close even when a section is passed with it', () => {
      // Closing owns the field regardless of arguments, so a stale section cannot outlive the
      // dialog by any call shape.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().setShowProjectSettingsModal(false, 'suggestions');
      expect(store.getState().projectSettingsSection).toBeNull();
    });

    it('is cleared by clearProjectSettingsSection while the dialog stays open', () => {
      // The dialog calls this once it has scrolled, so a re-render does not scroll again.
      store.getState().setShowProjectSettingsModal(true, 'suggestions');
      store.getState().clearProjectSettingsSection();
      expect(store.getState().projectSettingsSection).toBeNull();
      expect(store.getState().showProjectSettingsModal).toBe(true);
    });
  });

  describe('panelOnScreen', () => {
    it('is true for the tab in front only, and false for everything behind a maximized cell', () => {
      store.setState({ layout: { v: 1, columns: [
        { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
        { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
      ] } });
      expect(panelOnScreen(store.getState(), 'console')).toBe(true);
      expect(panelOnScreen(store.getState(), 'debug')).toBe(false);
      expect(panelOnScreen(store.getState(), 'files')).toBe(false);
      store.getState().toggleMaximize('cell2');
      expect(openPanels(shownLayout(store.getState()))).toEqual(['chat']);
      expect(panelOnScreen(store.getState(), 'chat')).toBe(true);
      expect(panelOnScreen(store.getState(), 'console')).toBe(false);
    });
  });

  describe('visiblePanelKeys', () => {
    it('lists open panels left to right', () => {
      store.setState({ layout: columnsOf('preview', 'chat', 'elements') });
      expect(visiblePanelKeys(store.getState())).toEqual(['preview', 'chat', 'elements']);
    });

    it('covers every registered panel, so the workspace cannot half-see one', () => {
      // The workspace sizes columns and computes drop indices from the layout. A panel that is in
      // PANEL_MAP but missing from it would desynchronise both.
      const keys = Object.keys(PANEL_MAP) as PanelKey[];
      store.setState({ layout: columnsOf(...keys) });
      expect(visiblePanelKeys(store.getState())).toEqual(keys);
    });

    it('derives every show flag from the layout', () => {
      store.setState({ layout: columnsOf('chat', 'preview', 'files') });
      // Opening the editor turns one flag on and leaves the rest shut, so every flag has something to say.
      store.getState().togglePanel('editor');
      const state = store.getState() as unknown as Record<string, boolean>;
      const open = new Set(visiblePanelKeys(store.getState()));
      for (const [key, flag] of Object.entries(PANEL_MAP)) expect(state[flag]).toBe(open.has(key));
    });
  });
});

/**
 * Where the three panels a fresh workspace opens with sit, and where a fourth goes.
 *
 * Chat and preview lead, and a fourth panel joins the rightmost cell as a tab, so none of the three
 * closes to make room for it.
 */
describe('the panels a fresh workspace opens with', () => {
  let store: ReturnType<typeof createLayoutStore>;

  beforeEach(() => {
    for (const key of Object.keys(mockLocalStorage)) delete mockLocalStorage[key];
    store = createLayoutStore();
  });

  it('are chat, preview and files, in that order', () => {
    // Asserted through visiblePanelKeys rather than the raw order, because that is what the
    // workspace renders from: the order also carries panels that start closed.
    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'preview', 'files']);
  });

  it('puts a fourth beside files, not over the preview', () => {
    store.getState().togglePanel('checkpoints');
    expect(shapeOf(store.getState().layout)).toBe('chat>chat|preview>preview|files,checkpoints>checkpoints');
  });

  it('leaves a saved order alone, so an existing arrangement is not rearranged', () => {
    mockLocalStorage['osw-workspace-panel-order'] = JSON.stringify(
      ['chat', 'files', 'editor', 'skills', 'console', 'preview', 'elements', 'checkpoints', 'debug'],
    );
    store.getState().initLayout();

    expect(visiblePanelKeys(store.getState())).toEqual(['chat', 'files', 'preview']);
  });
});
