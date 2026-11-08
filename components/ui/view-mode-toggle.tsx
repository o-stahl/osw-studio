'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { LayoutGrid, Table2 } from 'lucide-react';
import { Button } from './button';
import { Tip } from './tooltip';
import { configManager } from '@/lib/config/storage';

export type ViewMode = 'table' | 'grid';

/**
 * A listing's table/grid choice, remembered per page. Table is the default until the user picks.
 * The saved value is read in an effect rather than in the initial state so the server-rendered
 * markup and the first client render agree.
 */
export function useViewMode(page: string): [ViewMode, (mode: ViewMode) => void] {
  const [viewMode, setViewModeState] = useState<ViewMode>('table');

  useEffect(() => {
    const saved = configManager.getListViewMode(page);
    if (saved) setViewModeState(saved);
  }, [page]);

  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode);
    configManager.setListViewMode(page, mode);
  }, [page]);

  return [viewMode, setViewMode];
}

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export function ViewModeToggle({ value, onChange }: ViewModeToggleProps) {
  const t = useTranslations('common.viewMode');
  return (
    <div className="flex border rounded-full">
      <Tip label={t('table')}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange('table')}
          aria-label={t('table')}
          aria-pressed={value === 'table'}
          className={`rounded-r-none rounded-l-full ${value === 'table' ? 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary' : ''}`}
        >
          <Table2 className="h-4 w-4" />
        </Button>
      </Tip>
      <Tip label={t('grid')}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange('grid')}
          aria-label={t('grid')}
          aria-pressed={value === 'grid'}
          className={`rounded-l-none rounded-r-full ${value === 'grid' ? 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary' : ''}`}
        >
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </Tip>
    </div>
  );
}
