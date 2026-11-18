/**
 * The Canvas panel's model: every page of a project, at each width it is shown at, as an artboard on
 * one pan-and-zoom surface.
 */

/** What an artboard is holding. */
export type Tier =
  /** The page with its scripts, in a frame. */
  | 'live'
  /** The page's DOM without scripts, in a frame, from a settle or from the live page it was. */
  | 'still'
  /** A small image of the still. */
  | 'image'
  /** Its last known height and the page name, before anything else exists. */
  | 'placeholder'
  /** Off screen: nothing mounted. */
  | 'none';

export type CanvasDevice = 'phone' | 'tablet' | 'desktop';

/** Live Preview's three sizes: the artboard's width, and the screen height `vh` is pinned to. */
export const CANVAS_DEVICES: Record<CanvasDevice, { w: number; h: number }> = {
  phone: { w: 375, h: 667 },
  tablet: { w: 768, h: 1024 },
  desktop: { w: 1440, h: 900 },
};

/** The width toggles' order, narrowest first. */
export const CANVAS_DEVICE_ORDER: readonly CanvasDevice[] = ['phone', 'tablet', 'desktop'];

/** One page of the compiled project, as Canvas lays it out. */
export interface CanvasPage {
  /** The file the page was compiled from, `/about.html`; what artboards and snapshots are keyed by. */
  file: string;
  /** What the page picker shows. */
  title: string;
}

/** Where an artboard sits, in canvas pixels (an artboard pixel is a CSS pixel of its page). */
export interface ArtboardBox {
  id: string;
  page: string;
  device: CanvasDevice;
  /** The page's width at this size. */
  w: number;
  /** The device height: what `vh` means on this artboard, and where the first screen ends. */
  devH: number;
  x: number;
  y: number;
  /** The page's height, as last measured, or an estimate until it is. */
  h: number;
}

export const artboardId = (page: string, device: CanvasDevice): string => `${page}@${device}`;

/** The visible part of the canvas, in canvas pixels. */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pan and zoom: screen = canvas * z + p. */
export interface CanvasView {
  z: number;
  px: number;
  py: number;
}

export function viewRectOf(view: CanvasView, width: number, height: number): ViewRect {
  return { x: -view.px / view.z, y: -view.py / view.z, w: width / view.z, h: height / view.z };
}

/** How many pages may be live, how long one stays live after leaving view, and below which zoom nothing is. */
export interface LiveBudget {
  maxLive: number;
  graceMs: number;
  zLive: number;
}

/** At most 6 pages live at once, each staying live 8 s after it leaves the view, and none below 12% zoom. */
export const DEFAULT_BUDGET: LiveBudget = { maxLive: 6, graceMs: 8000, zLive: 0.12 };
