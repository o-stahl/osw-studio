import { MessageSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

/**
 * Unresolved review threads on a deployment.
 *
 * Icon plus count rather than "3 unresolved": this sits beside a deployment's name in a table row and
 * again on a card thumbnail, and in both the width matters more than the word. The icon carries the
 * meaning and the title carries the sentence.
 *
 * Geometry follows the sidebar's own count chip (`h-4 min-w-4 px-1`) rather than the Badge component,
 * whose padding and text size make it the widest thing in the row.
 *
 * Given `onClick` it renders as a button. The row underneath is itself a click target, so the handler
 * has to stop propagation; that is the caller's job, since only the caller knows what the row does.
 */
export function ReviewBadge({
  count,
  className,
  onClick,
}: {
  count: number;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
}) {
  const t = useTranslations('reviewBadge');
  if (!count) return null;

  const label = t('label', { count });
  const shape = cn(
    'inline-flex shrink-0 items-center justify-center gap-0.5 rounded-full border',
    'h-4 px-1 text-[10px] font-medium leading-none',
    'border-amber-500/50 text-amber-500',
    onClick && 'cursor-pointer transition-colors hover:bg-amber-500/15 hover:border-amber-500',
    className
  );

  const content = (
    <>
      <MessageSquare className="h-2.5 w-2.5" />
      {count}
    </>
  );

  if (!onClick) {
    return <span className={shape} title={label}>{content}</span>;
  }

  return (
    <button type="button" onClick={onClick} title={t('opensTab', { label })} className={shape}>
      {content}
    </button>
  );
}
