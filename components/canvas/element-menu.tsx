'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { altShortcut, modAltShortcut, modShortcut } from '@/lib/platform';
import type { OverrideScope } from '@/lib/direct-edit/overrides-css';

/** What the element menu, the Canvas keys and the Elements tab's structure toolbar can do. */
export type ElementAction =
  | 'edit-text' | 'select-parent' | 'select-child'
  | 'move-up' | 'move-down' | 'wrap' | 'unwrap' | 'duplicate'
  | 'copy-style' | 'paste-style' | 'clear-scope' | 'toggle-hide'
  | 'include' | 'delete';

/** What decides which entries are offered. */
export interface ElementMenuFacts {
  /** `section.hero`. */
  name: string;
  /** The page and width it was picked at: `index.html @1440`. */
  where: string;
  /** `data-osw-lock` on it or around it: restyle only. */
  locked: boolean;
  /** A Canvas frame, which Unwrap takes apart. */
  frame: boolean;
  /** A leaf with text, which can be typed. */
  textLeaf: boolean;
  hasParent: boolean;
  hasChild: boolean;
  /** `display: none` here. */
  hidden: boolean;
  /** The width scope Clear and Hide act in. */
  scope: OverrideScope;
  /** Copy style found something, and Paste has it. */
  canPaste: boolean;
  /** The Styles tab is there to write styles through. */
  canStyle: boolean;
  /** It has a marker, so it may have override blocks to clear. */
  marked: boolean;
}

/**
 * The element menu: what right-clicking an element on Canvas or a row in the Elements tree offers.
 * Opened at a point (`at`); closes itself on a choice or outside.
 */
export function ElementMenu({ at, facts, onAction, onClose }: {
  at: { x: number; y: number } | null;
  facts: ElementMenuFacts | null;
  onAction: (action: ElementAction) => void;
  onClose: () => void;
}) {
  const t = useTranslations('canvas.menu');
  if (!at || !facts) return null;
  const width = facts.scope === 'all' ? null : facts.scope;
  const item = (action: ElementAction, label: string, hint: string | null, disabled: boolean, danger = false) => (
    <DropdownMenuItem key={action} disabled={disabled} variant={danger ? 'destructive' : 'default'} onSelect={() => onAction(action)}>
      {label}
      {hint && <DropdownMenuShortcut>{hint}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
  const structural = facts.locked;
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }} modal={false}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: at.x, top: at.y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2} className="min-w-60" data-osw-element-menu="">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="font-mono text-xs truncate">{facts.name}</span>
          <span className="text-[11px] font-normal text-muted-foreground truncate">{facts.where}</span>
        </DropdownMenuLabel>
        {facts.locked && <p className="px-2 pb-1 text-[11px] text-amber-700 dark:text-amber-400">{t('lockedNote')}</p>}
        <DropdownMenuSeparator />
        {item('edit-text', t('editText'), t('doubleClick'), !facts.textLeaf || structural)}
        {item('select-parent', t('selectParent'), 'Esc', !facts.hasParent)}
        {item('select-child', t('selectChild'), 'Enter', !facts.hasChild)}
        <DropdownMenuSeparator />
        {item('move-up', t('moveUp'), altShortcut('↑'), structural)}
        {item('move-down', t('moveDown'), altShortcut('↓'), structural)}
        {item('wrap', t('wrap'), modAltShortcut('G'), structural)}
        {facts.frame && item('unwrap', t('unwrap'), null, structural)}
        {item('duplicate', t('duplicate'), modShortcut('D'), structural)}
        <DropdownMenuSeparator />
        {item('copy-style', t('copyStyle'), modAltShortcut('C'), !facts.marked)}
        {item('paste-style', t('pasteStyle'), modAltShortcut('V'), !facts.canPaste || !facts.canStyle)}
        {item('clear-scope', width === null ? t('clearAll') : t('clearUpTo', { width }), null, !facts.marked || !facts.canStyle)}
        {item('toggle-hide', facts.hidden ? t('show') : width === null ? t('hideAll') : t('hideUpTo', { width }), null, !facts.canStyle)}
        <DropdownMenuSeparator />
        {item('include', t('include'), null, false)}
        {item('delete', t('delete'), '⌫', structural, true)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
