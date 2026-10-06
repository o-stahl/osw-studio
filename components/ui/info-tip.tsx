import * as React from 'react';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * A small info icon that reveals an explainer on hover/focus. For labelling controls whose purpose
 * isn't obvious from their label alone.
 */
export function InfoTip({
  children,
  className,
  side = 'top',
}: {
  children: React.ReactNode;
  className?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const tc = useTranslations('common');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={tc('labels.moreInformation')}
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground transition-colors shrink-0',
            className,
          )}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs text-xs leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
