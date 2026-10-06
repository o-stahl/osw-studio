import React, { createContext, useContext } from 'react';
import { useTranslations } from 'next-intl';
import { X, GripVertical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Context for panel drag-to-reorder
interface PanelDragContext {
  onDragStart: (panelKey: string) => void;
  draggingPanel: string | null;
}
const PanelDragCtx = createContext<PanelDragContext | null>(null);
export const PanelDragProvider = PanelDragCtx.Provider;

interface PanelContainerProps {
  children: React.ReactNode;
  className?: string;
  dataTourId?: string;
}

export function PanelContainer({ children, className, dataTourId }: PanelContainerProps) {
  return (
    <div
      className={`h-full flex flex-col bg-card border border-border md:rounded-lg overflow-hidden ${className || ''}`}
      {...(dataTourId ? { 'data-tour-id': dataTourId } : {})}
    >
      {children}
    </div>
  );
}

interface PanelHeaderProps {
  icon: LucideIcon;
  title: string;
  color?: string;
  onClose?: () => void;
  /** Inline content after the title (e.g. counts, badges) */
  children?: React.ReactNode;
  /** Action buttons on the right side of the header (before the close button) */
  actions?: React.ReactNode;
  /** Panel key for drag-to-reorder (enables drag handle when PanelDragProvider is present) */
  panelKey?: string;
}

export function PanelHeader({ icon: Icon, title, color, onClose, children, actions, panelKey }: PanelHeaderProps) {
  const tt = useTranslations('tooltips');
  const dragCtx = useContext(PanelDragCtx);
  const isDragging = dragCtx && panelKey ? dragCtx.draggingPanel === panelKey : false;
  const canDrag = dragCtx && panelKey;

  const hasActions = Boolean(actions) || Boolean(children);

  return (
    <div className={`flex items-center justify-end md:justify-between px-3 py-1.5 md:py-2 border-b border-border bg-muted/30 shrink-0 ${isDragging ? 'opacity-50' : ''} ${!hasActions ? 'md:flex hidden' : ''}`}>
      <div className="hidden md:flex items-center gap-2">
        <Icon className="h-4 w-4" style={color ? { color } : undefined} />
        <span className="font-semibold text-sm">{title}</span>
        {children}
      </div>
      {children && <div className="flex md:hidden items-center gap-2">{children}</div>}
      <div className="flex items-center gap-1.5 md:gap-1">
        {actions}
        <div className="hidden md:flex items-center gap-0.5 ml-1 pl-1 border-l border-border/50">
          {canDrag && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 cursor-grab active:cursor-grabbing"
              title={tt('dragToReorder')}
              onMouseDown={() => {
                dragCtx.onDragStart(panelKey);
              }}
            >
              <GripVertical className="h-3 w-3" />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-5 w-5"
              title={tt('closePanel', { title })}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
