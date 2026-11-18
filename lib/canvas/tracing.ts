/**
 * How much of a settled page the Canvas can work on.
 *
 * An element is selectable and stylable by hand when it is written in a project file: the compile
 * stamps those with their source position. What a page's script builds at run time carries none,
 * and a `<canvas>` is one element however much it draws. The settle frame counts both
 * (`__cvTraced`, `lib/canvas/bridge.ts`), and a project whose pages are mostly of that kind (a
 * game, an app that renders itself) is told that Live Preview is the surface for it.
 */

/** One settled page: its visible elements by where they came from, and how much of its first screen is a drawing surface. */
export interface Traced {
  /** Visible elements written in a project file. */
  source: number;
  /** Visible elements with no source position: built by the page's script, or added by the browser. */
  script: number;
  /** The share of the first screen under `<canvas>` elements, 0 to 1. */
  drawn: number;
}

/** Fewer visible elements than this say nothing about a page either way. */
export const MIN_ELEMENTS = 12;
/** From this share of script-built elements, a page is its script's. */
const SCRIPT_SHARE = 0.6;
/** From this share of the first screen, a page is a drawing surface. */
export const DRAWN_SHARE = 0.5;

/** A reply's `traced`, checked: it comes from a frame that runs the project's code. */
export function readTraced(value: unknown): Traced | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const source = n(v.source), script = n(v.script), drawn = n(v.drawn);
  return source === null || script === null || drawn === null ? null : { source, script, drawn: Math.min(1, drawn) };
}

/** Whether a page gives the Canvas little to select: mostly built by its script, or mostly one drawing surface. */
export function isDrawn(traced: Traced): boolean {
  const total = traced.source + traced.script;
  return traced.drawn >= DRAWN_SHARE || (total >= MIN_ELEMENTS && traced.script / total >= SCRIPT_SHARE);
}

/** Whether more than half of the measured pages are of that kind. With none measured, no. */
export function mostlyDrawn(pages: readonly Traced[]): boolean {
  return pages.length > 0 && pages.filter(isDrawn).length * 2 > pages.length;
}
