'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { LayoutGrid } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { LAYOUT_PRESETS, presetOf } from '@/lib/workspace-layout';
import { useLayoutCommands } from './use-layout-commands';

/** The Layout button at the foot of the rail: the preset arrangements, and Reset layout. */
export function LayoutMenu() {
  const t = useTranslations('workspace.layout');
  const layout = useWorkspaceStore((s) => s.layout);
  const commands = useLayoutCommands();
  const current = presetOf(layout);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Tip label={t('presets.tip')} side="right">
          <button
            type="button"
            className="mt-auto h-6 w-6 px-1 rounded-sm flex items-center justify-center transition-all bg-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
            aria-label={t('presets.button')}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8}>
        <DropdownMenuLabel>{t('presets.button')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LAYOUT_PRESETS.map((name) => (
          <DropdownMenuCheckboxItem key={name} checked={current === name} onSelect={() => commands.preset(name)}>
            {t(`presets.${name}`)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={commands.reset}>{t('presets.reset')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
