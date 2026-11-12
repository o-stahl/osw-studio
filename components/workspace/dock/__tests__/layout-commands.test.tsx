// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast }));

import en from '@/messages/en.json';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { shapeOf, type WorkspaceLayout } from '@/lib/workspace-layout';
import { layoutShortcut, useLayoutCommands, WORKSPACE_FOCUS_ATTR, type LayoutCommands } from '../use-layout-commands';

/**
 * The layout's commands as the menus, the rail and the keys reach them: a change is made without a
 * toast and Undo and Redo take it back and forth; only a command that cannot run says why. A key acts
 * on the layout only where the focus leaves it to the layout.
 */

const t = createTranslator({ locale: 'en', messages: en });

const start = (): WorkspaceLayout => ({ v: 1, columns: [
  { id: 'col1', size: 34, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
  { id: 'col3', size: 33, cells: [{ id: 'cell4', size: 100, tabs: ['preview'], active: 'preview' }] },
  { id: 'col5', size: 33, cells: [{ id: 'cell6', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
] });
const shape = () => shapeOf(useWorkspaceStore.getState().layout);
const lastToast = () => toast.mock.calls.at(-1) as [string, { action?: unknown }];

describe('useLayoutCommands', () => {
  let commands: LayoutCommands;
  let container: HTMLDivElement;
  let root: Root;

  function Probe() {
    commands = useLayoutCommands();
    return null;
  }

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useWorkspaceStore.setState({ layout: start(), layoutHistory: [], layoutFuture: [], maximizedCell: null, lastPlace: {}, recentPanels: [], workspaceBox: null });
    toast.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(withMessages(<Probe />)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('moves a panel without a toast, and Undo and Redo take the move back and forth', () => {
    expect(commands.move({ panel: 'debug' }, { kind: 'tab', cell: 'cell2', index: null })).toBe(true);
    const moved = 'chat,debug>debug|preview>preview|console>console';
    expect(shape()).toBe(moved);
    act(() => commands.undo());
    expect(shape()).toBe(shapeOf(start()));
    act(() => commands.redo());
    expect(shape()).toBe(moved);
    expect(toast).not.toHaveBeenCalled();
  });

  it('answers false for a move that changes nothing', () => {
    expect(commands.move({ panel: 'chat' }, { kind: 'tab', cell: 'cell2', index: null })).toBe(false);
    expect(shape()).toBe(shapeOf(start()));
  });

  it('brings forward, closes a group, and opens and closes from the rail, without a toast', () => {
    commands.toggle('debug');
    expect(shape()).toBe('chat>chat|preview>preview|console,debug>debug');
    commands.closeGroup('cell6');
    expect(shape()).toBe('chat>chat|preview>preview');
    commands.toggle('files');
    expect(useWorkspaceStore.getState().showFiles).toBe(true);
    commands.toggle('files');
    expect(useWorkspaceStore.getState().showFiles).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('leaves the layout and says nothing for an Undo or Redo with nothing to take', () => {
    commands.undo();
    commands.redo();
    expect(shape()).toBe(shapeOf(start()));
    expect(toast).not.toHaveBeenCalled();
  });

  it('splits a group up without a toast, and says so when it cannot, or only in part', () => {
    commands.ungroup('cell6');
    expect(shape()).toBe('chat>chat|preview>preview|console>console/debug>debug');
    expect(toast).not.toHaveBeenCalled();
    commands.ungroup('cell2');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.ungroupNoRoom'));
    expect(lastToast()[1].action).toBeUndefined();

    // 500 px fits two columns and no stack: the preview gets the second column and the files stay.
    useWorkspaceStore.setState({ workspaceBox: { w: 500, h: 500 }, layout: { v: 1, columns: [
      { id: 'col1', size: 100, cells: [{ id: 'cell2', size: 100, tabs: ['chat', 'preview', 'files'], active: 'chat' }] },
    ] } });
    commands.ungroup('cell2');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.ungroupedPartly', { count: 1 }));
  });
});

describe('layoutShortcut', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  const el = (id: string) => document.getElementById(id);

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="workspace" ${WORKSPACE_FOCUS_ATTR} tabindex="-1">
        <button id="tab">Chat</button>
        <textarea id="composer"></textarea>
        <input id="field" />
        <div class="monaco-editor"><textarea id="monaco"></textarea></div>
        <div id="editable" contenteditable="true"></div>
      </div>
      <button id="outside">Projects</button>`;
  });

  it('undoes and splits right with Ctrl, or Cmd on a Mac, while the workspace has focus', () => {
    expect(layoutShortcut(key('z', { ctrlKey: true }), el('workspace'), false)).toBe('undo');
    expect(layoutShortcut(key('z', { ctrlKey: true }), el('tab'), false)).toBe('undo');
    expect(layoutShortcut(key('Z', { metaKey: true }), el('tab'), true)).toBe('undo');
    expect(layoutShortcut(key('z', { metaKey: true }), el('tab'), false)).toBeNull();
    expect(layoutShortcut(key('z', { ctrlKey: true }), el('tab'), true)).toBeNull();
    expect(layoutShortcut(key('\\', { ctrlKey: true }), el('workspace'), false)).toBe('split-right');
    expect(layoutShortcut(key('Escape'), el('tab'), false)).toBe('restore');
  });

  it('redoes with Ctrl+Shift+Z or Ctrl+Y, and with Cmd+Shift+Z on a Mac', () => {
    expect(layoutShortcut(key('Z', { ctrlKey: true, shiftKey: true }), el('tab'), false)).toBe('redo');
    expect(layoutShortcut(key('y', { ctrlKey: true }), el('tab'), false)).toBe('redo');
    expect(layoutShortcut(key('Z', { metaKey: true, shiftKey: true }), el('tab'), true)).toBe('redo');
    expect(layoutShortcut(key('y', { metaKey: true }), el('tab'), true)).toBeNull();
  });

  it('leaves the key with other modifiers or none alone', () => {
    expect(layoutShortcut(key('z', { ctrlKey: true, altKey: true }), el('tab'), false)).toBeNull();
    expect(layoutShortcut(key('Z', { ctrlKey: true, shiftKey: true, altKey: true }), el('tab'), false)).toBeNull();
    expect(layoutShortcut(key('z'), el('tab'), false)).toBeNull();
  });

  it('leaves the keys to Monaco, the chat composer and fields', () => {
    for (const id of ['composer', 'field', 'monaco', 'editable']) {
      expect(layoutShortcut(key('z', { ctrlKey: true }), el(id), false), id).toBeNull();
      expect(layoutShortcut(key('Z', { ctrlKey: true, shiftKey: true }), el(id), false), id).toBeNull();
      expect(layoutShortcut(key('Escape'), el(id), false), id).toBeNull();
    }
  });

  it('does nothing while the focus is outside the workspace', () => {
    expect(layoutShortcut(key('z', { ctrlKey: true }), el('outside'), false)).toBeNull();
    expect(layoutShortcut(key('Escape'), null, false)).toBeNull();
  });
});
