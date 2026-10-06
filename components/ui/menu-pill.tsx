'use client';

import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A menu trigger drawn as the chat panel's split pill: an icon (and optional label), then a chevron
 * pointing where the menu opens. Pass it as a Radix trigger's `asChild` child; the chevron flips while the trigger
 * reports `data-state="open"`.
 */
export const MenuPill = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & {
    icon: React.ElementType;
    /** Visible text. Without it, give the button an `aria-label`. */
    label?: React.ReactNode;
    opens?: 'up' | 'down';
  }
>(function MenuPill({ icon: Icon, label, opens = 'up', className, ...props }, ref) {
  const Chevron = opens === 'up' ? ChevronUp : ChevronDown;
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className={cn('group/pill h-7 p-0 gap-0 overflow-hidden rounded-full text-xs text-foreground', className)}
      {...props}
    >
      <span className="flex items-center gap-1.5 h-full px-2">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="flex items-center h-full px-1.5 border-l border-border">
        <Chevron className="h-3 w-3 transition-transform group-data-[state=open]/pill:rotate-180" />
      </span>
    </Button>
  );
});
