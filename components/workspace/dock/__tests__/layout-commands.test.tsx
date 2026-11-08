// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTranslator } from 'next-intl';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import en from '@/messages/en.json';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { shapeOf, type WorkspaceLayout } from '@/lib/workspace-layout';
import { LAYOUT_TOAST_ID, layoutShortcut, useLayoutCommands, WORKSPACE_FOCUS_ATTR, type LayoutCommands } from '../use-layout-commands';

/**
 * The layout's commands as the menus, the rail and the keys reach them: each change toasts what it
 * did, with an Undo, and a key acts on the layout only where the focus leaves it to the layout.
 */

const t = createTranslator({ locale: 'en', messages: en });

const start = (): WorkspaceLayout => ({ v: 1, columns: [
  { id: 'col1', size: 34, cells: [{ id: 'cell2', size: 100, tabs: ['chat'], active: 'chat' }] },
  { id: 'col3', size: 33, cells: [{ id: 'cell4', size: 100, tabs: ['preview'], active: 'preview' }] },
  { id: 'col5', size: 33, cells: [{ id: 'cell6', size: 100, tabs: ['console', 'debug'], active: 'console' }] },
] });
const shape = () => shapeOf(useWorkspaceStore.getState().layout);
const lastToast = () => toast.mock.calls.at(-1) as [string, { action?: { label: string; onClick: () => void } }];

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
    useWorkspaceStore.setState({ layout: start(), layoutHistory: [], maximizedCell: null, lastPlace: {}, recentPanels: [], workspaceBox: null });
    toast.mockClear();
    toast.dismiss.mockClear();
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

  it('toasts what a move did, and the toast\'s Undo takes it back', () => {
    expect(commands.move({ panel: 'debug' }, { kind: 'tab', cell: 'cell2', index: null })).toBe(true);
    expect(shape()).toBe('chat,debug>debug|preview>preview|console>console');
    const [text, options] = lastToast();
    expect(text).toBe(t('workspace.layout.toast.moved', { panel: t('workspace.tabs.debugEvents') }));
    expect(options.action?.label).toBe(t('workspace.layout.toast.undo'));
    act(() => options.action!.onClick());
    expect(shape()).toBe(shapeOf(start()));
    expect(toast.dismiss).toHaveBeenCalledWith(LAYOUT_TOAST_ID);
  });

  it('answers false for a move that changes nothing, and says nothing', () => {
    expect(commands.move({ panel: 'chat' }, { kind: 'tab', cell: 'cell2', index: null })).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it('names a closed group by its front panel and how many more', () => {
    commands.closeGroup('cell6');
    expect(shape()).toBe('chat>chat|preview>preview');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.groupClosed', { panel: t('workspace.tabs.console'), count: 1 }));
  });

  it('toasts an open and a close from the rail, and nothing for bringing a tab forward', () => {
    commands.toggle('files');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.opened', { panel: t('workspace.tabs.fileExplorer') }));
    const toasts = toast.mock.calls.length;
    commands.toggle('debug');
    expect(toast.mock.calls.length).toBe(toasts);
    commands.toggle('debug');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.closed', { panel: t('workspace.tabs.debugEvents') }));
  });

  it('says there is nothing to undo, with no Undo of its own', () => {
    commands.undo();
    const [text, options] = lastToast();
    expect(text).toBe(t('workspace.layout.toast.nothingToUndo'));
    expect(options.action).toBeUndefined();
  });

  it('splits a group up with an Undo, and says so when it cannot', () => {
    commands.ungroup('cell6');
    expect(shape()).toBe('chat>chat|preview>preview|console>console/debug>debug');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.ungrouped'));
    expect(lastToast()[1].action).toBeDefined();
    commands.ungroup('cell2');
    expect(lastToast()[0]).toBe(t('workspace.layout.toast.ungroupNoRoom'));
    expect(lastToast()[1].action).toBeUndefined();
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

  it('leaves redo, and the key with other modifiers or none, alone', () => {
    expect(layoutShortcut(key('z', { ctrlKey: true, shiftKey: true }), el('tab'), false)).toBeNull();
    expect(layoutShortcut(key('z', { ctrlKey: true, altKey: true }), el('tab'), false)).toBeNull();
    expect(layoutShortcut(key('z'), el('tab'), false)).toBeNull();
  });

  it('leaves the keys to Monaco, the chat composer and fields', () => {
    for (const id of ['composer', 'field', 'monaco', 'editable']) {
      expect(layoutShortcut(key('z', { ctrlKey: true }), el(id), false), id).toBeNull();
      expect(layoutShortcut(key('Escape'), el(id), false), id).toBeNull();
    }
  });

  it('does nothing while the focus is outside the workspace', () => {
    expect(layoutShortcut(key('z', { ctrlKey: true }), el('outside'), false)).toBeNull();
    expect(layoutShortcut(key('Escape'), null, false)).toBeNull();
  });
});
