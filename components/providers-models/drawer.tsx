'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type DrawerMode = 'pick' | 'connect-choose' | 'connect-config' | 'connect-custom' | 'save-template' | null;

export interface DrawerProps {
  open: boolean;
  mode: DrawerMode;
  /** Label shown above the title (e.g. "Model for"). */
  label?: string;
  /** When set, the label becomes a clickable back action (e.g. "← Back"). */
  onLabelClick?: () => void;
  /** Primary title shown in the drawer header. */
  title?: string;
  /** Secondary scope / description line below the title. */
  scope?: string;
  onClose: () => void;
  children?: React.ReactNode;
}

/**
 * Controlled right-side slide-in drawer.
 *
 * Renders a fixed panel that slides in from the right with a scrim overlay.
 * Escape key and scrim click both call onClose.
 * Focus is trapped inside while open (via the panel's own auto-focus behaviour).
 *
 * The header (label / title / scope / close button) is rendered here.
 * Callers pass the body content as children.
 * Footer is intentionally left to children so each mode can own its actions.
 */
export function Drawer({ open, label, onLabelClick, title, scope, onClose, children }: DrawerProps) {
  const t = useTranslations('connections');
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  if (!mounted) return null;

  // Portal to <body> so the fixed overlay escapes any transformed/overflow-hidden
  // ancestor (the Radix Popover/Dialog this drawer is opened from clips fixed children).
  return createPortal(
    <>
      {/* Scrim */}
      <div
        aria-hidden="true"
        data-models-drawer=""
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm transition-opacity duration-200',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />

      {/* Panel */}
      <aside
        ref={panelRef}
        data-models-drawer=""
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t('drawer')}
        className={cn(
          // Layout
          'fixed top-5 right-5 bottom-5 z-[70]',
          // Explicit pointer-events: when this drawer is opened from inside a Radix
          // Dialog (the workspace "Providers & models" modal), Radix sets
          // pointer-events:none on <body>; without this the portaled panel inherits
          // it and clicks fall through to the scrim beneath.
          'pointer-events-auto',
          'w-[480px] max-w-[calc(100vw-40px)]',
          // Appearance — matches prototype's .drawer
          'flex flex-col overflow-hidden',
          'bg-background border border-border rounded-xl',
          'shadow-[0_24px_80px_rgba(0,0,0,0.6)]',
          // Slide transition
          'transition-transform duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
          open ? 'translate-x-0' : 'translate-x-[calc(100%+28px)]',
        )}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-[22px] pt-5 pb-0">
          <div className="flex items-start justify-between">
            <div>
              {label && (
                onLabelClick ? (
                  <button
                    type="button"
                    onClick={onLabelClick}
                    className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    {label}
                  </button>
                ) : (
                  <p className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
                    {label}
                  </p>
                )
              )}
              {title && (
                <h2 className="mt-0.5 text-lg font-semibold tracking-[-0.01em] text-foreground">
                  {title}
                </h2>
              )}
              {scope && (
                <p className="mt-1 text-xs text-muted-foreground">{scope}</p>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className={cn(
                'flex-shrink-0 w-[30px] h-[30px] rounded-lg grid place-items-center',
                'bg-transparent border-none text-muted-foreground',
                'hover:bg-muted hover:text-foreground',
                'transition-colors cursor-pointer',
              )}
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Body — scrollable, owned by children */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-thumb-[var(--border)] scrollbar-track-transparent">
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}
