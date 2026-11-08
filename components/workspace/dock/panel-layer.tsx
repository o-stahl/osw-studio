'use client';

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { findPanel, PANEL_KEYS, type PanelKey, type WorkspaceLayout } from '@/lib/workspace-layout';
import type { Rect } from './drag';

/**
 * Every open panel, rendered once and kept mounted, each positioned over its cell's slot.
 *
 * A panel that moved to another cell would otherwise remount, and four of the nine lose something
 * then: the editor its open files and unsaved edits, the chat its draft, the preview its page, the
 * console its output. And a browser reloads an iframe whose element moves in the document. So the
 * panels stay where they are in the DOM, in a fixed order, and only their boxes move. A background
 * tab stays mounted, hidden at its cell's size, so it shows again as it was.
 */
interface PanelLayerProps {
  panels: Partial<Record<PanelKey, React.ReactNode>>;
  /** What is on screen: which cell each panel is in and which tab is in front. */
  shown: WorkspaceLayout;
  /** Changes when the cells are rebuilt; the panels then slide from their old boxes to their new ones. */
  motionKey: string;
  areaRef: React.RefObject<HTMLDivElement | null>;
  /** While a tab is dragged off its group, the tab the group shows in its place. */
  behind: { cell: string; active: PanelKey } | null;
  /** Where a panel's box is before its slot has been measured: its cell's box from the layout. */
  initialRect: (panel: PanelKey) => Rect | null;
  /** A panel arriving from the drag chip grows out of it rather than appearing. */
  flipFrom: React.RefObject<{ panel: PanelKey; rect: Rect } | null>;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const moved = (a: Rect, b: Rect) => Math.abs(a.x - b.x) >= 1 || Math.abs(a.y - b.y) >= 1 || Math.abs(a.w - b.w) >= 1 || Math.abs(a.h - b.h) >= 1;

function slide(el: HTMLElement, from: Rect, to: Rect) {
  if (!to.w || !to.h || typeof el.animate !== 'function') return;
  el.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.w / to.w}, ${from.h / to.h})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  );
}

export function PanelLayer({ panels, shown, motionKey, areaRef, behind, initialRect, flipFrom }: PanelLayerProps) {
  const boxes = useRef(new Map<PanelKey, HTMLDivElement>());
  const placed = useRef(new Map<PanelKey, { rect: Rect; visible: boolean }>());
  const latest = useRef({ shown, behind });
  latest.current = { shown, behind };
  const lastMotion = useRef(motionKey);

  const place = useCallback((animate: boolean) => {
    const area = areaRef.current;
    if (!area) return;
    const origin = area.getBoundingClientRect();
    const slots = new Map<string, Rect>();
    area.querySelectorAll<HTMLElement>('[data-cell-slot]').forEach((slot) => {
      const r = slot.getBoundingClientRect();
      slots.set(slot.dataset.cellSlot!, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    });
    const { shown: layout, behind: held } = latest.current;
    const motion = animate && !reducedMotion();
    const from = flipFrom.current;
    flipFrom.current = null;
    for (const [key, el] of boxes.current) {
      const at = findPanel(layout, key);
      const rect = at ? slots.get(at.cell.id) : undefined;
      const front = !!at && !!rect && (held && held.cell === at.cell.id ? held.active === key : at.cell.active === key);
      const before = placed.current.get(key);
      if (rect) {
        el.style.left = `${rect.x}px`;
        el.style.top = `${rect.y}px`;
        el.style.width = `${rect.w}px`;
        el.style.height = `${rect.h}px`;
      }
      el.style.visibility = front ? 'visible' : 'hidden';
      el.inert = !front;
      if (motion && front && rect) {
        const start = from && from.panel === key ? from.rect : before?.visible ? before.rect : null;
        if (start && moved(start, rect)) slide(el, start, rect);
      }
      placed.current.set(key, { rect: rect ?? before?.rect ?? { x: 0, y: 0, w: 0, h: 0 }, visible: front });
    }
  }, [areaRef, flipFrom]);

  // When what is shown changes: what is in front can change without the slots moving (a tab switch,
  // a drag). Not on every render, which during a run is every streamed event.
  const keysKey = PANEL_KEYS.filter((key) => panels[key] !== undefined).join(',');
  useLayoutEffect(() => {
    const animate = lastMotion.current !== motionKey;
    lastMotion.current = motionKey;
    place(animate);
  }, [place, shown, behind?.cell, behind?.active, motionKey, keysKey]);

  const slotKey = shown.columns.map((col) => col.cells.map((cell) => cell.id).join(',')).join('|');
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === 'undefined') return;
    // A divider drag resizes the slots without a render, and a window resize the whole area.
    const observer = new ResizeObserver(() => place(false));
    observer.observe(area);
    area.querySelectorAll('[data-cell-slot]').forEach((slot) => observer.observe(slot));
    return () => observer.disconnect();
  }, [areaRef, place, motionKey, slotKey]);

  const register = useCallback((panel: PanelKey, el: HTMLDivElement | null) => {
    if (el) boxes.current.set(panel, el);
    else {
      boxes.current.delete(panel);
      placed.current.delete(panel);
    }
  }, []);

  return (
    <>
      {PANEL_KEYS.filter((key) => panels[key] !== undefined).map((key) => (
        <PanelBox key={key} panel={key} initial={initialRect(key)} register={register}>
          {panels[key]}
        </PanelBox>
      ))}
    </>
  );
}

/** One panel's box. Its style is set once at mount; after that the layer places it. */
function PanelBox({ panel, initial, register, children }: {
  panel: PanelKey;
  initial: Rect | null;
  register: (panel: PanelKey, el: HTMLDivElement | null) => void;
  children: React.ReactNode;
}) {
  const [style] = useState<React.CSSProperties>(() => ({
    left: initial?.x ?? 0,
    top: initial?.y ?? 0,
    width: initial?.w ?? 0,
    height: initial?.h ?? 0,
    visibility: 'hidden',
  }));
  const ref = useCallback((el: HTMLDivElement | null) => register(panel, el), [panel, register]);
  return (
    <div ref={ref} data-panel-id={panel} className="absolute" style={style}>
      {children}
    </div>
  );
}
