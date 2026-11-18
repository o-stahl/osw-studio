import { OVERRIDES_PATH, managedWidths, type OverrideScope } from './overrides-css';

/** A page or a partial: the files whose markup and `<style>` blocks the project's pages are made of. */
export const isPageFile = (path: string) => /\.(html?|hbs|handlebars)$/i.test(path);

/**
 * The project's breakpoints, as the edges width scopes are made from.
 *
 * Every edge is a `max-width` in px: `max-width: N` is N, `min-width: N` is the width just below it
 * (N - 1), so a mobile-first project's `min-width: 768px` and a desktop-first one's
 * `max-width: 767px` describe the same edge. `em` and `rem` in a media query are 16 px (the initial
 * font size, not the page's). Range syntax (`width <= 640px`) counts too. Other units are skipped.
 */

/** Media-query `em` and `rem` resolve against the initial font size, which is 16 px. */
const EM_PX = 16;

/** A length in a media query, in px, or `null` for a unit it cannot be turned into. */
function mediaPx(amount: string, unit: string): number | null {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = unit.toLowerCase();
  if (u === 'px') return n;
  if (u === 'em' || u === 'rem') return n * EM_PX;
  return null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The edges one stylesheet's media queries use. Comments are ignored. */
export function breakpointsOf(css: string): number[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: number[] = [];
  const add = (px: number | null, below: boolean) => {
    if (px === null) return;
    const edge = round(below ? px - 1 : px);
    if (edge > 0 && edge < 10000) out.push(edge);
  };
  for (const media of text.matchAll(/@media\b([^{;]*)\{/gi)) {
    const prelude = media[1];
    for (const m of prelude.matchAll(/\(\s*(max|min)-width\s*:\s*([\d.]+)\s*(px|r?em)\s*\)/gi)) {
      add(mediaPx(m[2], m[3]), m[1].toLowerCase() === 'min');
    }
    // `width <= 640px`, `width >= 768px`, and the same written the other way round.
    for (const m of prelude.matchAll(/\(\s*width\s*(<=|<|>=|>)\s*([\d.]+)\s*(px|r?em)\s*\)/gi)) {
      add(mediaPx(m[2], m[3]), m[1] === '<' || m[1] === '>=');
    }
    for (const m of prelude.matchAll(/\(\s*([\d.]+)\s*(px|r?em)\s*(<=|<|>=|>)\s*width\s*\)/gi)) {
      add(mediaPx(m[1], m[2]), m[3] === '>' || m[3] === '<=');
    }
  }
  return out;
}

/** Every edge the project's stylesheets use, widest first, each once. */
export function projectBreakpoints(sources: readonly string[]): number[] {
  return Array.from(new Set(sources.flatMap(breakpointsOf))).sort((a, b) => b - a);
}

/** The `<style>` blocks of a page, for the breakpoints a single-file site keeps there. */
export function styleBlocksOf(html: string): string[] {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi), (m) => m[1]);
}

/**
 * The scope a frame `width` px wide edits: the narrowest breakpoint at or above it, so the rule
 * written applies at this width and the ones below it down to the next breakpoint. Wider than every
 * breakpoint, it is All widths.
 */
export function scopeOfWidth(width: number, breakpoints: readonly number[]): OverrideScope {
  let scope: OverrideScope = 'all';
  for (const edge of breakpoints) if (width <= edge) scope = scope === 'all' || edge < scope ? edge : scope;
  return scope;
}

/**
 * The scopes Applies to offers: All widths, the scope each of `widths` falls in, and `current`,
 * widest first. Only scopes a width can reach, so choosing one always has a frame to move to.
 */
export function offeredScopes(
  breakpoints: readonly number[],
  widths: readonly number[],
  current: OverrideScope,
): OverrideScope[] {
  const numbers = new Set<number>();
  for (const width of widths) {
    const scope = scopeOfWidth(width, breakpoints);
    if (scope !== 'all') numbers.add(scope);
  }
  if (current !== 'all') numbers.add(current);
  return ['all', ...Array.from(numbers).sort((a, b) => b - a)];
}

/**
 * The breakpoints a project's files use, widest first: every stylesheet's but `/overrides.css`,
 * every page's and partial's `<style>` blocks, and the widths `/overrides.css` already has blocks
 * for, so those stay reachable even when the stylesheet that had the breakpoint is rewritten.
 */
export function projectBreakpointsOf(files: readonly { path: string; content: string }[]): number[] {
  const css = files.filter(file => file.path.toLowerCase().endsWith('.css') && file.path !== OVERRIDES_PATH);
  const pages = files.filter(file => isPageFile(file.path));
  const overrides = files.find(file => file.path === OVERRIDES_PATH);
  let kept: number[] = [];
  try {
    kept = overrides ? managedWidths(overrides.content) : [];
  } catch {
    // A file the writer would refuse adds none.
  }
  return Array.from(new Set([
    ...projectBreakpoints([...css.map(file => file.content), ...pages.flatMap(page => styleBlocksOf(page.content))]),
    ...kept,
  ])).sort((a, b) => b - a);
}
