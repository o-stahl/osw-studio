import { artboardId, CANVAS_DEVICES, type ArtboardBox, type CanvasDevice, type CanvasPage, type ViewRect } from './types';

/** Space between the widths of one page, and between pages. */
export const BOARD_GAP = 72;
export const PAGE_GAP = 220;
/** The label above each artboard, which counts as part of it for visibility. */
const LABEL_HEIGHT = 30;

/**
 * Where each artboard sits: each page's widths side by side, pages left to right, tops aligned. A
 * height learnt later, or changed by an edit, then never moves another artboard.
 *
 * `heights` gives what is known for an artboard; anything else is estimated from another width of
 * the same page, else three screens.
 */
export function layoutArtboards(
  pages: readonly CanvasPage[],
  devices: readonly CanvasDevice[],
  heights: (id: string) => number | undefined,
): ArtboardBox[] {
  const boards: ArtboardBox[] = [];
  let x = 0;
  for (const page of pages) {
    const known = devices.map((device) => ({ device, h: heights(artboardId(page.file, device)) }));
    for (const { device, h } of known) {
      const { w, h: devH } = CANVAS_DEVICES[device];
      boards.push({ id: artboardId(page.file, device), page: page.file, device, w, devH, x, y: 0, h: h ?? estimateHeight(known, w, devH) });
      x += w + BOARD_GAP;
    }
    x += PAGE_GAP - BOARD_GAP;
  }
  return boards;
}

/** A page's height at a width it has not been measured at: a narrower width wraps more, so it is taller. */
function estimateHeight(known: { device: CanvasDevice; h: number | undefined }[], w: number, devH: number): number {
  const other = known.find((k) => k.h !== undefined);
  if (!other) return devH * 3;
  return Math.round(other.h! * (CANVAS_DEVICES[other.device].w / w) ** 0.6);
}

/** The artboards overlapping the view, widened by `margin` of its size on each side. */
export function visibleArtboards<T extends ArtboardBox>(boards: readonly T[], rect: ViewRect, margin = 0): T[] {
  const mx = rect.w * margin;
  const my = rect.h * margin;
  return boards.filter((b) =>
    b.x + b.w > rect.x - mx && b.x < rect.x + rect.w + mx && b.y + b.h + LABEL_HEIGHT > rect.y - my && b.y - LABEL_HEIGHT < rect.y + rect.h + my);
}

/** How far an artboard is from the middle of the view: 0 when the middle is on it. */
export function centreDistance(b: ArtboardBox, rect: ViewRect): number {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const bx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const by = Math.max(b.y, Math.min(cy, b.y + b.h));
  return Math.hypot(bx - cx, by - cy);
}

/** The artboard under a canvas point, label included. */
export function artboardAt<T extends ArtboardBox>(boards: readonly T[], x: number, y: number): T | null {
  return boards.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y - LABEL_HEIGHT && y <= b.y + b.h) ?? null;
}

/**
 * The view that shows these artboards side by side across a box's width, tops aligned under the
 * margin, at no more than 100%: what the page picker and Fit go to.
 */
export function fitView(boards: readonly ArtboardBox[], width: number, margin = 36): { z: number; px: number; py: number } | null {
  if (!boards.length || width <= margin * 2) return null;
  const x0 = Math.min(...boards.map((b) => b.x));
  const x1 = Math.max(...boards.map((b) => b.x + b.w));
  const y0 = Math.min(...boards.map((b) => b.y));
  const z = Math.max(0.02, Math.min(1, (width - margin * 2) / (x1 - x0)));
  return { z, px: margin - x0 * z, py: margin + LABEL_HEIGHT - y0 * z };
}
