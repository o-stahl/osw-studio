'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { layoutBox, layoutView } from '@/lib/stores/slices/layout';
import { checkLayout, findPanel, isPanelKey, movePanel, type DropTarget, type PanelKey, type WorkspaceLayout } from '@/lib/workspace-layout';
import { useLayoutCommands } from './use-layout-commands';
import { useDockText } from './use-dock-text';
import { modShortcut } from '@/lib/platform';


/** Split right's target: a new column just after the panel's own. */
export function splitRightTarget(layout: WorkspaceLayout, panel: PanelKey): DropTarget | null {
  const at = findPanel(layout, panel);
  if (!at) return null;
  const after = layout.columns[layout.columns.indexOf(at.col) + 1];
  return { kind: 'column', before: after ? after.id : null };
}

/**
 * A panel's menu, on right-click of its title, its tab or its grip: the moves a drag can make, as
 * commands, for everyone who never finds the drag. A command that can't run says why.
 */
export function PanelMenu({ panelKey, children }: { panelKey: string; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open && isPanelKey(panelKey) && <PanelMenuItems panel={panelKey} />}
    </ContextMenu>
  );
}

function PanelMenuItems({ panel }: { panel: PanelKey }) {
  const t = useTranslations('workspace.layout');
  const text = useDockText();
  const commands = useLayoutCommands();
  const layout = useWorkspaceStore((s) => s.layout);
  const workspaceBox = useWorkspaceStore((s) => s.workspaceBox);
  const maximizedCell = useWorkspaceStore((s) => s.maximizedCell);
  const recent = useWorkspaceStore((s) => s.recentPanels);
  const view = layoutView({ layout, workspaceBox });
  const box = layoutBox({ workspaceBox });
  const at = findPanel(view, panel);
  if (!at) return null;
  const title = text.titles[panel];
  const maximized = maximizedCell === at.cell.id;

  const option = (label: string, target: DropTarget | null, toast: string, already: string, extra: { shortcut?: string; inset?: boolean } = {}) => {
    const next = target ? movePanel(view, { panel }, target, box, { recent }) : null;
    const refusal = next ? checkLayout(next, box) : null;
    const disabled = !next || !!refusal;
    const note = refusal ? text.refusal(refusal) : next ? extra.shortcut : already;
    return (
      <ContextMenuItem
        key={label}
        inset={extra.inset}
        disabled={disabled}
        onSelect={() => { if (target) commands.move({ panel }, target, toast); }}
      >
        {label}
        {note && <ContextMenuShortcut className={disabled ? 'pl-4 tracking-normal' : undefined}>{note}</ContextMenuShortcut>}
      </ContextMenuItem>
    );
  };

  const others = view.columns.flatMap((col) => col.cells).filter((cell) => cell.id !== at.cell.id);
  const grouped = at.cell.tabs.length > 1;

  return (
    <ContextMenuContent className="min-w-[14rem]">
      <ContextMenuLabel>{title}</ContextMenuLabel>
      <ContextMenuSeparator />
      {option(t('menu.splitRight'), splitRightTarget(view, panel), t('toast.movedToColumn', { panel: title }), t('menu.alreadyOwnColumn'), { shortcut: modShortcut('\\') })}
      {option(t('menu.splitBelow'), { kind: 'stack', cell: at.cell.id, side: 'below' }, t('toast.splitBelow', { panel: title }), t('menu.alreadyAlone'))}
      {option(t('menu.moveToNewColumn'), { kind: 'column', before: null }, t('toast.movedToColumn', { panel: title }), t('menu.alreadyLastColumn'))}
      {others.length > 0 && (
        <>
          <ContextMenuLabel className="font-normal text-muted-foreground">{t('menu.addAsTabTo')}</ContextMenuLabel>
          {others.map((cell) => option(
            text.titles[cell.active],
            { kind: 'tab', cell: cell.id, index: null },
            t('toast.addedTo', { panel: title, target: text.titles[cell.active] }),
            '',
            { inset: true },
          ))}
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => useWorkspaceStore.getState().toggleMaximize(at.cell.id)}>
        {maximized ? t('menu.restore') : t('menu.maximize')}
        <ContextMenuShortcut className="tracking-normal">{t('menu.doubleClick')}</ContextMenuShortcut>
      </ContextMenuItem>
      {grouped && <ContextMenuItem onSelect={() => commands.ungroup(at.cell.id)}>{t('menu.ungroupAll')}</ContextMenuItem>}
      <ContextMenuSeparator />
      <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => commands.close(panel)}>{t('menu.close')}</ContextMenuItem>
      {grouped && (
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => commands.closeGroup(at.cell.id)}>{t('menu.closeGroup')}</ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}
