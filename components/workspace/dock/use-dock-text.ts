'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { usePanelTitles } from '@/lib/i18n/use-panel-titles';
import { findCell, type DragSource, type DropTarget, type LayoutRefusal, type PanelKey, type WorkspaceLayout } from '@/lib/workspace-layout';

/** The words for refusals and drop targets, shared by the drag preview and the menus. */
export function useDockText() {
  const t = useTranslations('workspace.layout');
  const titles = usePanelTitles();

  return useMemo(() => {
    const refusal = (r: LayoutRefusal): string => {
      if (r.code === 'width') return t('refusal.width', { px: r.px });
      if (r.code === 'height') return t('refusal.height', { panel: titles[r.panel], px: r.px });
      return t('refusal.inspectorPreview');
    };

    /**
     * Where a drop lands, by the panels around it. A cell is named by its front panel, or, for the
     * group a tab is leaving, by the one that will be in front once it has gone (`frontAfter`).
     */
    const target = (
      layout: WorkspaceLayout,
      to: DropTarget,
      source: DragSource,
      frontAfter?: { cell: string; panel: PanelKey } | null,
    ): string => {
      const cellTitle = (id: string) => {
        if (frontAfter && frontAfter.cell === id) return titles[frontAfter.panel];
        const at = findCell(layout, id);
        return at ? titles[at.cell.active] : '';
      };
      if (to.kind === 'tab') {
        const own = 'panel' in source && findCell(layout, to.cell)?.cell.tabs.includes(source.panel);
        return own ? t('target.reorder') : t('target.tabIn', { panel: cellTitle(to.cell) });
      }
      if (to.kind === 'stack') return t(to.side === 'above' ? 'target.above' : 'target.below', { panel: cellTitle(to.cell) });
      const cols = layout.columns;
      const i = to.before === null ? cols.length : cols.findIndex((c) => c.id === to.before);
      const name = (index: number) => titles[cols[index].cells[0].active];
      if (cols[i - 1] && cols[i]) return t('target.columnBetween', { left: name(i - 1), right: name(i) });
      if (cols[i]) return t('target.columnLeftOf', { panel: name(i) });
      if (cols[i - 1]) return t('target.columnRightOf', { panel: name(i - 1) });
      return t('target.column');
    };

    return { refusal, target, titles };
  }, [t, titles]);
}
