'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { isPanelKey, type DragSource, type DropTarget, type LayoutPreset, type PanelKey } from '@/lib/workspace-layout';

/** One toast at a time: a command that could not run replaces the last one's. */
export const LAYOUT_TOAST_ID = 'workspace-layout';

/** The desktop workspace, which takes focus so that Ctrl+Z reaches the layout. */
export const WORKSPACE_FOCUS_ATTR = 'data-workspace-desktop';

/**
 * A change that took away the element with focus (a tab, a menu item) gives focus back to the
 * workspace, so Ctrl+Z still applies. Run after React has committed the change.
 */
export function keepWorkspaceFocus() {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>(`[${WORKSPACE_FOCUS_ATTR}]`)?.focus({ preventScroll: true });
  }, 0);
}

/** Monaco, the chat composer and every field keep their own keys. */
const inField = (el: Element | null) => !!el?.closest('.monaco-editor, input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/** A key the layout answers to. */
export type LayoutShortcut = 'restore' | 'undo' | 'redo' | 'split-right';

/**
 * What a key does to the layout, by where the focus is: only while the desktop workspace has focus
 * outside a field, Esc restores a maximized cell, Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (and Ctrl+Y off
 * a Mac) redoes and Ctrl/Cmd+\ splits right. In the editor, the chat or a field the key stays theirs,
 * as Ctrl+S already defers to Monaco.
 */
export function layoutShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  active: Element | null,
  mac: boolean,
): LayoutShortcut | null {
  if (!active?.closest(`[${WORKSPACE_FOCUS_ATTR}]`) || inField(active)) return null;
  if (event.key === 'Escape') return 'restore';
  if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return null;
  if (event.key.toLowerCase() === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (event.key.toLowerCase() === 'y' && !mac && !event.shiftKey) return 'redo';
  if (event.key === '\\') return 'split-right';
  return null;
}

export interface LayoutCommands {
  /** The rail: opens, brings to the front, or closes. */
  toggle: (panel: string) => void;
  close: (panel: PanelKey) => void;
  closeGroup: (cellId: string) => void;
  /** False when the move changes nothing or the layout can't be shown. */
  move: (source: DragSource, target: DropTarget) => boolean;
  preset: (name: LayoutPreset) => void;
  reset: () => void;
  ungroup: (cellId: string) => void;
  undo: () => void;
  redo: () => void;
  /** A toast for a command that could not run, saying why. */
  say: (text: string) => void;
}

/**
 * The layout's store actions as the menus, the rail and the keys use them. A change shows nothing
 * beyond itself and keeps focus in the workspace, so Ctrl/Cmd+Z can take it back; only a command that
 * could not run says why, in a toast.
 */
export function useLayoutCommands(): LayoutCommands {
  const t = useTranslations('workspace.layout');

  return useMemo(() => {
    const store = () => useWorkspaceStore.getState();

    const say = (text: string) => {
      toast(text, { id: LAYOUT_TOAST_ID, duration: 3000 });
      keepWorkspaceFocus();
    };

    return {
      toggle(panel) {
        if (!isPanelKey(panel)) return;
        if (store().togglePanel(panel)) keepWorkspaceFocus();
      },
      close(panel) {
        if (store().closePanel(panel)) keepWorkspaceFocus();
      },
      closeGroup(cellId) {
        if (store().closeGroup(cellId)) keepWorkspaceFocus();
      },
      move(source, target) {
        if (!store().movePanel(source, target)) return false;
        keepWorkspaceFocus();
        return true;
      },
      preset(name) {
        store().applyLayoutPreset(name);
        keepWorkspaceFocus();
      },
      reset() {
        store().resetPanelLayout();
        keepWorkspaceFocus();
      },
      ungroup(cellId) {
        const result = store().ungroupCell(cellId);
        if (!result) say(t('toast.ungroupNoRoom'));
        else if (result.stayed.length) say(t('toast.ungroupedPartly', { count: result.stayed.length }));
        else keepWorkspaceFocus();
      },
      undo() {
        if (store().undoLayout()) keepWorkspaceFocus();
      },
      redo() {
        if (store().redoLayout()) keepWorkspaceFocus();
      },
      say,
    };
  }, [t]);
}
