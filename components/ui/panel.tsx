import React, { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, GripVertical, Ellipsis, Loader2, Minimize } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** One tab in a docked panel's header. */
export interface PanelDockTab {
  key: string;
  title: string;
  icon: LucideIcon;
  color: string;
  /** What a background tab has to say: output nobody has seen, or a run going on. */
  badge?: 'unread' | 'busy' | null;
}

/** What a docked panel's header shows, from the workspace layout. */
export interface PanelDockHeader {
  /** The tabs in the panel's cell, in strip order. A lone panel has only itself and shows its title. */
  tabs: PanelDockTab[];
  /** The tab in front. */
  active: string;
  /** Tabs a drop would bring in, drawn dashed in the strip where they would land. */
  ghosts?: readonly string[];
  /** Tabs being dragged, drawn faded. */
  dragging?: readonly string[];
  maximized: boolean;
}

/** The workspace's docking, as the panel headers reach it. Absent on mobile and in quick edit. */
export interface PanelDockContext {
  header: (panelKey: string) => PanelDockHeader | null;
  /** A press on the title, a tab, or the grip. The grip of a tabbed group moves the whole group. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>, panelKey: string, group: boolean) => void;
  onActivate: (panelKey: string) => void;
  onToggleMaximize: (panelKey: string) => void;
  /** Gives its child the panel's menu on right-click. */
  Menu: React.ComponentType<{ panelKey: string; children: React.ReactElement }>;
  /** True for the click that ends a drag, which must not also activate a tab. */
  consumeClick: () => boolean;
}

const PanelDockCtx = createContext<PanelDockContext | null>(null);
export const PanelDockProvider = PanelDockCtx.Provider;

/** One of a header's actions. A list rather than nodes, so each can be a button or, short of room, a menu item. */
export interface PanelAction {
  id: string;
  icon: LucideIcon;
  /** Its name: the tooltip and the menu item. */
  label: string;
  /** The tooltip, where it says more than the label: a shortcut, or why the action is off. */
  tip?: string;
  /** The text beside the icon on mobile, and on desktop too when `labelled`; `label` by default. */
  text?: string;
  /** Shows its text on desktop as well (Save, Run, Clear). */
  labelled?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Choices under it instead of a single action (Import's sources). */
  items?: { id: string; icon: LucideIcon; label: string; onSelect: () => void }[];
  tourId?: string;
}

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
  /** The header's actions, before the grip and close button; see {@link PanelAction}. */
  actions?: PanelAction[];
  /** Which panel this is; with the workspace's docking present, it makes the header a handle and a tab strip. */
  panelKey?: string;
}

const PILL = 'h-6 rounded-full border border-border/60 bg-muted/50 px-2.5 gap-1.5 md:h-5 md:border-0 md:bg-transparent md:rounded-md';
const ICON_ONLY = `${PILL} md:w-5 md:px-0`;
const LABELLED = `${PILL} md:px-2`;

export function PanelHeader({ icon: Icon, title, color, onClose, children, actions, panelKey }: PanelHeaderProps) {
  const tt = useTranslations('tooltips');
  const tl = useTranslations('workspace.layout');
  const dock = useContext(PanelDockCtx);
  const info = dock && panelKey ? dock.header(panelKey) : null;
  const strip = info && info.tabs.length > 1 ? info.tabs : null;
  const draggable = Boolean(info) && !info?.maximized;
  const list = actions ?? [];

  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const actionRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const moreRef = useRef<HTMLButtonElement>(null);
  /** How many actions, counted from the right, are in the ⋯ menu. */
  const [overflow, setOverflow] = useState(0);
  const [compact, setCompact] = useState(false);

  /**
   * A narrowing header gives way in this order: the actions move into the ⋯ menu one at a time from
   * the right, then background tabs drop to their icons, and only then does the title truncate. It is
   * worked out from scratch at each width, so a given width always looks the same.
   */
  const fit = useCallback(() => {
    const header = headerRef.current;
    if (!header || !header.clientWidth) return;
    const els = actionRefs.current.slice(0, list.length);
    for (const el of els) if (el) el.hidden = false;
    if (moreRef.current) moreRef.current.hidden = true;
    stripRef.current?.removeAttribute('data-compact');
    // Any overflow counts: the title's ellipsis shows for a single pixel.
    const tight = () => {
      const s = stripRef.current;
      if (s?.offsetParent) return s.scrollWidth > s.clientWidth;
      const t = titleRef.current;
      if (t?.offsetParent) return t.scrollWidth > t.clientWidth;
      // On a phone there is no title: the actions are the row, which overflows off its start.
      const inner = header.getBoundingClientRect().left + parseFloat(getComputedStyle(header).paddingLeft || '0');
      const lefts = Array.from(header.children).filter((el) => (el as HTMLElement).offsetParent).map((el) => el.getBoundingClientRect().left);
      return lefts.length > 0 && Math.min(...lefts) < inner - 0.5;
    };
    let hidden = 0;
    if (els.length && tight()) {
      if (moreRef.current) moreRef.current.hidden = false;
      for (let i = els.length - 1; i >= 0 && tight(); i--) {
        if (els[i]) els[i]!.hidden = true;
        hidden++;
      }
    }
    const squeezed = !!stripRef.current?.offsetParent && tight();
    if (squeezed) stripRef.current!.setAttribute('data-compact', '');
    setOverflow(hidden);
    setCompact(squeezed);
  }, [list.length]);

  const signature = `${title}|${list.map((a) => `${a.id}:${a.disabled ? 1 : 0}:${a.text ?? ''}`).join(',')}|${strip ? strip.map((t) => t.key).join(',') : ''}|${info?.active ?? ''}`;
  useLayoutEffect(() => { fit(); }, [fit, signature]);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(header);
    return () => observer.disconnect();
  }, [fit]);

  const menu = (key: string, child: React.ReactElement) => (dock ? <dock.Menu panelKey={key}>{child}</dock.Menu> : child);
  const hint = draggable ? tl('handleHint') : tl('maximizedHint');
  const dragging = info?.dragging ?? [];
  const ghosts = info?.ghosts ?? [];
  const hasActions = list.length > 0 || Boolean(children);
  const overflowed = list.slice(list.length - overflow);

  /**
   * Shift+F10 and the Menu key open the panel's menu where right-click does. Windows turns them into a
   * contextmenu event itself; a Mac does not, so the event is made here, at the element.
   */
  const menuKey = (event: React.KeyboardEvent<HTMLElement>): boolean => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
    event.preventDefault();
    const r = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.bottom }));
    return true;
  };

  const onTabKey = (event: React.KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (menuKey(event)) return;
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([data-ghost])') ?? []);
    const i = tabs.indexOf(event.currentTarget);
    const j = event.key === 'ArrowRight' ? (i + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : -1;
    if (j >= 0) {
      event.preventDefault();
      tabs[j]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dock?.onActivate(key);
    }
  };

  return (
    <div
      ref={headerRef}
      data-panel-header=""
      className={`flex items-center justify-end md:justify-between gap-2 px-3 py-1.5 md:py-2 border-b border-border bg-muted/30 shrink-0 ${!hasActions ? 'md:flex hidden' : ''}`}
    >
      {strip ? (
        <div
          ref={stripRef}
          role="tablist"
          aria-label={tl('tabs')}
          data-compact={compact || undefined}
          className="group/strip hidden md:flex items-stretch self-stretch gap-0.5 min-w-0 flex-1 -my-2 -ml-2 overflow-hidden"
        >
          {strip.map((tab) => {
            const front = tab.key === info!.active;
            const ghost = ghosts.includes(tab.key);
            const TabIcon = tab.icon;
            const note = front || ghost ? null : tab.badge === 'unread' ? tl('unread') : tab.badge === 'busy' ? tl('running') : null;
            const button = (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={front}
                tabIndex={front && !ghost ? 0 : -1}
                aria-hidden={ghost || undefined}
                data-ghost={ghost || undefined}
                data-panel-tab={tab.key}
                style={{ '--tab-color': tab.color } as React.CSSProperties}
                className={cn(
                  'group/tab relative isolate inline-flex flex-none items-center gap-2 h-9 px-2 border-b-2 border-transparent text-sm whitespace-nowrap select-none touch-none outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring',
                  'before:absolute before:inset-y-1.5 before:inset-x-0.5 before:-z-10 before:rounded-md before:transition-colors',
                  front ? 'text-foreground font-semibold border-b-[color:var(--tab-color)] group-data-[compact]/strip:flex-[0_1_auto] group-data-[compact]/strip:min-w-0' : 'text-muted-foreground font-medium hover:text-foreground',
                  draggable && !ghost ? 'cursor-grab hover:before:bg-accent dark:hover:before:bg-accent/50' : 'cursor-default',
                  ghost && 'h-7 self-center rounded-md border border-dashed border-primary/65 bg-primary/15 text-primary',
                  dragging.includes(tab.key) && !ghost && 'opacity-50',
                )}
                onPointerDown={ghost || !draggable ? undefined : (e) => dock!.onPointerDown(e, tab.key, false)}
                onClick={ghost ? undefined : () => { if (!dock!.consumeClick()) dock!.onActivate(tab.key); }}
                onDoubleClick={ghost ? undefined : () => dock!.onToggleMaximize(tab.key)}
                onKeyDown={ghost ? undefined : (e) => onTabKey(e, tab.key)}
              >
                <TabIcon data-panel-icon="" className={cn('h-4 w-4 shrink-0', ghost ? 'text-primary' : front ? 'text-[color:var(--tab-color)]' : 'text-muted-foreground group-hover/tab:text-[color:var(--tab-color)]')} />
                <span className={cn('truncate', !front && !ghost && 'group-data-[compact]/strip:hidden')}>{tab.title}</span>
                {!front && !ghost && tab.badge === 'unread' && (
                  <>
                    <span aria-hidden="true" className="-ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--button-terminal-active,#22c55e)]" />
                    <span className="sr-only">{tl('unread')}</span>
                  </>
                )}
                {!front && !ghost && tab.badge === 'busy' && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-label={tl('running')} />
                )}
              </button>
            );
            if (ghost) return button;
            return (
              <React.Fragment key={tab.key}>
                {menu(tab.key, <Tip label={<HandleTip title={tab.title} note={note} hint={hint} />} side="bottom">{button}</Tip>)}
              </React.Fragment>
            );
          })}
        </div>
      ) : (
        menu(panelKey ?? '', (
          <div
            data-panel-title=""
            className={cn(
              'hidden md:flex items-center gap-2 min-w-0',
              draggable && 'cursor-grab touch-none select-none rounded-md -mx-1.5 -my-[3px] px-1.5 py-[3px] transition-colors hover:bg-accent dark:hover:bg-accent/50',
              dragging.includes(panelKey ?? '') && 'opacity-50',
            )}
            onPointerDown={draggable ? (e) => dock!.onPointerDown(e, panelKey!, false) : undefined}
            onDoubleClick={info ? () => dock!.onToggleMaximize(panelKey!) : undefined}
          >
            {/* The tooltip is the name's, so what follows it (Debug's memory, a run's badge) can have its own. */}
            <Tip label={info ? <HandleTip title={title} hint={hint} /> : undefined} side="bottom">
              <span className="flex items-center gap-2 min-w-0">
                <Icon data-panel-icon="" className="h-4 w-4 shrink-0" style={color ? { color } : undefined} />
                <span ref={titleRef} className="font-semibold text-sm truncate">{title}</span>
              </span>
            </Tip>
            {children}
          </div>
        ))
      )}
      {strip && children && <div className="hidden md:flex items-center gap-2 shrink-0">{children}</div>}
      {children && <div className="flex md:hidden items-center gap-2">{children}</div>}
      <div className="flex shrink-0 items-center gap-1.5 md:gap-1">
        {list.map((action, i) => (
          <ActionButton
            key={action.id}
            action={action}
            hidden={i >= list.length - overflow}
            slotRef={(el) => { actionRefs.current[i] = el; }}
          />
        ))}
        {list.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tip label={tl('moreActions')} side="bottom">
                <Button
                  ref={moreRef}
                  size="sm"
                  variant="ghost"
                  hidden={overflow === 0}
                  className={ICON_ONLY}
                  aria-label={tl('moreActions')}
                >
                  <Ellipsis className="h-2.5 w-2.5 md:h-3 md:w-3" />
                </Button>
              </Tip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{title}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {overflowed.map((action) => {
                const ActionIcon = action.icon;
                if (action.items) {
                  return (
                    <React.Fragment key={action.id}>
                      <DropdownMenuLabel className="font-normal text-muted-foreground">{action.label}</DropdownMenuLabel>
                      {action.items.map((item) => {
                        const ItemIcon = item.icon;
                        return (
                          <DropdownMenuItem key={item.id} inset onSelect={item.onSelect}>
                            <ItemIcon />
                            {item.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </React.Fragment>
                  );
                }
                return (
                  <DropdownMenuItem
                    key={action.id}
                    disabled={action.disabled}
                    variant={action.destructive ? 'destructive' : 'default'}
                    onSelect={action.onSelect}
                  >
                    <ActionIcon />
                    {action.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="hidden md:flex items-center gap-0.5 ml-1 pl-1 border-l border-border/50">
          {info?.maximized && (
            <Tip label={tl('restoreHint')} side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                aria-label={tl('restore')}
                onClick={() => dock!.onToggleMaximize(panelKey!)}
              >
                <Minimize className="h-3 w-3" />
              </Button>
            </Tip>
          )}
          {draggable && menu(panelKey!, (
            <Tip label={strip ? tl('dragGroup') : tl('dragToMove')} side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 cursor-grab active:cursor-grabbing touch-none"
                aria-label={strip ? tl('dragGroup') : tl('dragToMove')}
                onPointerDown={(e) => dock!.onPointerDown(e, panelKey!, strip !== null)}
                onClick={(e) => e.preventDefault()}
                onKeyDown={menuKey}
              >
                <GripVertical className="h-3 w-3" />
              </Button>
            </Tip>
          ))}
          {onClose && (
            <Tip label={tt('closePanel', { title })} side="bottom">
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-5 w-5"
                aria-label={tt('closePanel', { title })}
              >
                <X className="h-3 w-3" />
              </Button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  );
}

/** A panel's tooltip on its title or a tab: the name, what a background tab has to say, and what the handle does. */
function HandleTip({ title, note, hint }: { title: string; note?: string | null; hint: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">
        {title}
        {note && <span className="font-normal"> · {note}</span>}
      </span>
      <span className="opacity-80">{hint}</span>
    </span>
  );
}

/**
 * One action, in a slot of its own that the header hides when the action goes into the ⋯ menu. The
 * slot, not the button, so that a disabled action's tooltip wrapper goes with it.
 */
function ActionButton({ action, hidden, slotRef }: { action: PanelAction; hidden: boolean; slotRef: (el: HTMLSpanElement | null) => void }) {
  const ActionIcon = action.icon;
  const button = (
    <Tip label={action.tip ?? (action.labelled ? undefined : action.label)} side="bottom">
      <Button
        size="sm"
        variant="ghost"
        disabled={action.disabled}
        className={cn(action.labelled ? LABELLED : ICON_ONLY, action.destructive && 'text-destructive hover:text-destructive')}
        onClick={action.items ? undefined : action.onSelect}
        aria-label={action.labelled ? undefined : action.label}
        data-tour-id={action.tourId}
      >
        <ActionIcon className="h-2.5 w-2.5 md:h-3 md:w-3" />
        <span className={action.labelled ? 'text-xs' : 'text-xs md:hidden'}>{action.text ?? action.label}</span>
      </Button>
    </Tip>
  );
  return (
    <span ref={slotRef} data-panel-action={action.id} hidden={hidden} className="inline-flex">
      {action.items ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {action.items.map((item) => {
              const ItemIcon = item.icon;
              return (
                <DropdownMenuItem key={item.id} onSelect={item.onSelect}>
                  <ItemIcon className="h-4 w-4 mr-2" />
                  {item.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : button}
    </span>
  );
}
