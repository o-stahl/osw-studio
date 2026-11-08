'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { layoutView } from '@/lib/stores/slices/layout';
import { usePanelTitles } from '@/lib/i18n/use-panel-titles';
import { findCell, isPanelKey, type DragSource, type DropTarget, type LayoutPreset, type PanelKey } from '@/lib/workspace-layout';

/** One toast at a time: a new layout change replaces the last one's. */
export const LAYOUT_TOAST_ID = 'workspace-layout';

/** The desktop workspace, which takes focus so that Ctrl+Z reaches the layout. */
export const WORKSPACE_FOCUS_ATTR = 'data-workspace-desktop';

/**
 * A change that took away the element with focus (a tab, a menu item, the toast) gives focus back to
 * the workspace, so Ctrl+Z still applies. Run after React has committed the change. A toast's Undo
 * button still has focus then, and the toast leaves with it a moment later, so focus on a toast moves too.
 */
export function keepWorkspaceFocus() {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest('[data-sonner-toaster]')) return;
    document.querySelector<HTMLElement>(`[${WORKSPACE_FOCUS_ATTR}]`)?.focus({ preventScroll: true });
  }, 0);
}

/** Monaco, the chat composer and every field keep their own keys. */
const inField = (el: Element | null) => !!el?.closest('.monaco-editor, input, textarea, select, [contenteditable=""], [contenteditable="true"]');

/** A key the layout answers to. */
export type LayoutShortcut = 'restore' | 'undo' | 'split-right';

/**
 * What a key does to the layout, by where the focus is: only while the desktop workspace has focus
 * outside a field, Esc restores a maximized cell, Ctrl/Cmd+Z undoes and Ctrl/Cmd+\ splits right. In
 * the editor, the chat or a field the key stays theirs, as Ctrl+S already defers to Monaco.
 */
export function layoutShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  active: Element | null,
  mac: boolean,
): LayoutShortcut | null {
  if (!active?.closest(`[${WORKSPACE_FOCUS_ATTR}]`) || inField(active)) return null;
  if (event.key === 'Escape') return 'restore';
  if (!(mac ? event.metaKey : event.ctrlKey) || event.altKey) return null;
  if (event.key.toLowerCase() === 'z' && !event.shiftKey) return 'undo';
  if (event.key === '\\') return 'split-right';
  return null;
}

export interface LayoutCommands {
  /** The rail: opens, brings to the front, or closes. */
  toggle: (panel: string) => void;
  close: (panel: PanelKey) => void;
  closeGroup: (cellId: string) => void;
  /** False when the move changes nothing or the layout can't be shown. `text` overrides the toast. */
  move: (source: DragSource, target: DropTarget, text?: string) => boolean;
  preset: (name: LayoutPreset) => void;
  reset: () => void;
  ungroup: (cellId: string) => void;
  undo: () => void;
  /** A toast with no Undo, for a command that could not run. */
  say: (text: string) => void;
}

/** The layout's store actions, each with the toast it shows: every move, open, close, preset and ungroup can be undone from it. */
export function useLayoutCommands(): LayoutCommands {
  const t = useTranslations('workspace.layout');
  const titles = usePanelTitles();

  return useMemo(() => {
    const store = () => useWorkspaceStore.getState();

    const undo = () => {
      if (store().undoLayout()) {
        toast.dismiss(LAYOUT_TOAST_ID);
        keepWorkspaceFocus();
      } else {
        toast(t('toast.nothingToUndo'), { id: LAYOUT_TOAST_ID, duration: 3000 });
      }
    };

    const notify = (text: string) => {
      toast(text, { id: LAYOUT_TOAST_ID, duration: 6000, action: { label: t('toast.undo'), onClick: undo } });
      keepWorkspaceFocus();
    };

    const say = (text: string) => {
      toast(text, { id: LAYOUT_TOAST_ID, duration: 3000 });
      keepWorkspaceFocus();
    };

    /** A group by its front panel: "Console and 2 more". */
    const groupOf = (cellId: string): [PanelKey, number] | null => {
      const at = findCell(layoutView(store()), cellId);
      return at ? [at.cell.active, at.cell.tabs.length - 1] : null;
    };

    return {
      toggle(panel) {
        if (!isPanelKey(panel)) return;
        const change = store().togglePanel(panel);
        if (change === 'opened') notify(t('toast.opened', { panel: titles[panel] }));
        else if (change === 'closed') notify(t('toast.closed', { panel: titles[panel] }));
        else if (change === 'front') keepWorkspaceFocus();
      },
      close(panel) {
        if (store().closePanel(panel)) notify(t('toast.closed', { panel: titles[panel] }));
      },
      closeGroup(cellId) {
        const group = groupOf(cellId);
        if (!group || !store().closeGroup(cellId)) return;
        const [front, more] = group;
        notify(more ? t('toast.groupClosed', { panel: titles[front], count: more }) : t('toast.closed', { panel: titles[front] }));
      },
      move(source, target, text) {
        const group = 'cell' in source ? groupOf(source.cell) : null;
        if (!store().movePanel(source, target)) return false;
        if (text) notify(text);
        else if ('panel' in source) notify(t('toast.moved', { panel: titles[source.panel] }));
        else if (group) notify(group[1] ? t('toast.groupMoved', { panel: titles[group[0]], count: group[1] }) : t('toast.moved', { panel: titles[group[0]] }));
        return true;
      },
      preset(name) {
        store().applyLayoutPreset(name);
        notify(t('toast.preset', { name: t(`presets.${name}`) }));
      },
      reset() {
        store().resetPanelLayout();
        notify(t('toast.reset'));
      },
      ungroup(cellId) {
        const result = store().ungroupCell(cellId);
        if (!result) say(t('toast.ungroupNoRoom'));
        else if (result.stayed.length) notify(t('toast.ungroupedPartly', { count: result.stayed.length }));
        else notify(t('toast.ungrouped'));
      },
      undo,
      say,
    };
  }, [t, titles]);
}
