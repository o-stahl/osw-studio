'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Zap, ShieldQuestion, SlidersHorizontal, Cog, ChevronDown, ChevronUp } from 'lucide-react';
import { configManager } from '@/lib/config/storage';
import type { PermissionMode } from '@/lib/llm/permissions';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { PermissionMatrixModal } from './PermissionMatrixModal';

const MODE_CONFIG: Record<PermissionMode, { Icon: typeof Zap }> = {
  auto: { Icon: Zap },
  ask: { Icon: ShieldQuestion },
  custom: { Icon: SlidersHorizontal },
};

export function PermissionModeSelector() {
  const t = useTranslations('permissions');
  const [mode, setMode] = useState<PermissionMode>(() =>
    configManager.getPermissionMode()
  );
  const [open, setOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);

  const selectMode = (m: PermissionMode) => {
    configManager.setPermissionMode(m);
    setMode(m);
    setOpen(false);
  };

  const ActiveIcon = MODE_CONFIG[mode].Icon;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 p-0 gap-0 overflow-hidden text-xs rounded-t-lg rounded-b-none"
              >
                <span className="flex items-center gap-1 h-full px-2">
                  <ActiveIcon className="h-3 w-3" />
                  {t(mode)}
                </span>
                <span className="flex items-center h-full px-1.5 border-l border-border group/chev">
                  {open
                    ? <ChevronDown className="h-3 w-3 transition-transform group-hover/chev:translate-y-0.5" />
                    : <ChevronUp className="h-3 w-3 transition-transform group-hover/chev:-translate-y-0.5" />}
                </span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px]">
            <p className="font-semibold">{t('mode')}</p>
            <p className="mt-1 opacity-90">
              {t('tooltipIntro')}
            </p>
            <p className="mt-1">
              <span className="font-semibold">{t('serverModeLabel')}</span>
              <span className="opacity-90"> {t('serverModeNote')}</span>
            </p>
            <ul className="mt-1.5 space-y-0.5">
              <li><span className="font-semibold">{t('auto')}</span><span className="opacity-90">: {t('autoDesc')}</span></li>
              <li><span className="font-semibold">{t('ask')}</span><span className="opacity-90">: {t('askDesc')}</span></li>
              <li><span className="font-semibold">{t('custom')}</span><span className="opacity-90">: {t('customDesc')}</span></li>
            </ul>
          </TooltipContent>
        </Tooltip>
        <PopoverContent className="w-40 p-1" align="end" side="top">
          {(['auto', 'ask', 'custom'] as PermissionMode[]).map((m) => {
            const Icon = MODE_CONFIG[m].Icon;
            return (
              <button
                key={m}
                onClick={() => selectMode(m)}
                className={`flex items-center gap-2 w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted ${
                  m === mode ? 'font-semibold bg-muted/50' : ''
                }`}
              >
                <Icon className="h-3 w-3" />
                {t(m)}
              </button>
            );
          })}
          <div className="my-1 h-px bg-border" />
          <button
            onClick={() => {
              setOpen(false);
              setMatrixOpen(true);
            }}
            className="flex items-center gap-2 w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted"
          >
            <Cog className="h-3 w-3" />
            {t('customize')}
          </button>
        </PopoverContent>
      </Popover>

      <PermissionMatrixModal
        open={matrixOpen}
        onOpenChange={setMatrixOpen}
        onModeChange={() => setMode(configManager.getPermissionMode())}
      />
    </>
  );
}
