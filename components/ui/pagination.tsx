'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * Optional scroll container to reset to top on page change. Defaults to
   * window scroll when omitted. Passing `null` disables scroll-to-top.
   */
  scrollTarget?: React.RefObject<HTMLElement | null> | null;
  className?: string;
}

export interface PaginationRangeProps {
  total: number;
  rangeStart: number;
  rangeEnd: number;
  totalPages: number;
  className?: string;
}

/**
 * Build a compact page list with ellipsis:
 *   1  ... 4 5 6 ...  12
 * Always includes first, last, current ±1.
 */
function buildPageList(page: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const set = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const pages = Array.from(set)
    .filter(p => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  const out: Array<number | 'ellipsis'> = [];
  for (let i = 0; i < pages.length; i++) {
    out.push(pages[i]);
    if (i < pages.length - 1 && pages[i + 1] - pages[i] > 1) {
      out.push('ellipsis');
    }
  }
  return out;
}

/**
 * Small "N–M of T" range label. Renders nothing when the list fits on a
 * single page — lets callers place it unconditionally without a guard.
 */
export function PaginationRange({
  total,
  rangeStart,
  rangeEnd,
  totalPages,
  className,
}: PaginationRangeProps) {
  // Above the early return: a hook called after it would change the hook order between renders.
  const t = useTranslations('common.pagination');
  if (totalPages <= 1) return null;
  return (
    <p className={cn('text-[11px] text-muted-foreground', className)}>
      {t('range', { start: rangeStart, end: rangeEnd, total })}
    </p>
  );
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  scrollTarget,
  className,
}: PaginationProps) {
  const t = useTranslations('common.pagination');
  if (totalPages <= 1) return null;

  const pageList = buildPageList(page, totalPages);
  const canPrev = page > 1;
  const canNext = page < totalPages;

  const handleChange = (p: number) => {
    if (p === page) return;
    onPageChange(p);
    // Default: scroll window. Explicit null disables. Ref → scroll that element.
    if (scrollTarget === null) return;
    const el = scrollTarget?.current;
    try {
      if (el) {
        el.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch {
      // Older browsers: ignore.
    }
  };

  const navBtn = "h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40 disabled:pointer-events-none transition-colors";
  const pageBtn = "h-6 min-w-6 px-1.5 inline-flex items-center justify-center rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors";
  const pageBtnActive = "h-6 min-w-6 px-1.5 inline-flex items-center justify-center rounded text-[11px] font-medium text-foreground bg-muted";

  return (
    <div className={cn('flex items-center justify-center gap-0.5 pt-4 pb-1', className)}>
      <button
        type="button"
        className={navBtn}
        onClick={() => handleChange(page - 1)}
        disabled={!canPrev}
        aria-label={t('previous')}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      {pageList.map((p, i) =>
        p === 'ellipsis' ? (
          <span key={`e-${i}`} className="px-1 text-[11px] text-muted-foreground/60">…</span>
        ) : (
          <button
            key={p}
            type="button"
            className={p === page ? pageBtnActive : pageBtn}
            onClick={() => handleChange(p)}
            aria-label={t('page', { page: p })}
            aria-current={p === page ? 'page' : undefined}
          >
            {p}
          </button>
        )
      )}

      <button
        type="button"
        className={navBtn}
        onClick={() => handleChange(page + 1)}
        disabled={!canNext}
        aria-label={t('next')}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
