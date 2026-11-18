/**
 * The number rows (`NumberEntry`): what they show and what they write.
 *
 * A number row shows, in order of preference: what this session asked for, the declaration as
 * written when it is in one of the row's units, or the computed value turned into the unit on
 * screen. `+` and `−` move it by the row's step in that unit; a drag on the label moves it by steps
 * from where the drag began.
 */

import type { SpecifiedValue } from '@/lib/preview/types';
import type { NumberEntry, StyleKeyword, StyleUnit } from './properties';

const NUM_UNIT = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|deg|vw|vh)?$/;

/** A number and the unit it is in, or `null` for anything else (`auto`, `none`, a list). */
export function parseNumber(text: string | null | undefined): { n: number; unit: StyleUnit } | null {
  const m = NUM_UNIT.exec((text ?? '').trim().toLowerCase());
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? { n, unit: (m[2] ?? '') as StyleUnit } : null;
}

/** How many columns a `grid-template-columns` value makes: `repeat(n, …)`, or a list of tracks. */
export function columnsOf(value: string | null | undefined): number | null {
  const v = (value ?? '').trim();
  if (v === '' || v === 'none') return null;
  const repeat = /^repeat\(\s*(\d+)\s*,/.exec(v);
  if (repeat) return Number(repeat[1]);
  let depth = 0;
  let tracks = 0;
  let inTrack = false;
  // Tracks are separated by spaces outside parentheses and line names (`[a]`).
  for (const c of v.replace(/\[[^\]]*\]/g, ' ')) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (/\s/.test(c) && depth === 0) { inTrack = false; continue; }
    if (!inTrack) { tracks++; inTrack = true; }
  }
  return tracks > 0 ? tracks : null;
}

const round = (n: number, places = 4) => Number(n.toFixed(places));

export interface NumberContext {
  /** What this session asked for, until the frame answers. */
  requested?: string;
  specified?: SpecifiedValue | null;
  /** The computed value, under the row's first read name. */
  computed?: string;
  rootFontSize: number | null;
  /** The element's own font size in px: what one `em` is worth. */
  fontSize: number | null;
  /** The unit the person picked for this row, if they did. */
  unit?: StyleUnit;
  /** The frame's width in px: what one `vw` is worth. */
  viewportWidth?: number | null;
  /** The computed value of the row's `startFrom`, for a row with no number to show. */
  start?: string;
}

export interface ShownNumber {
  n: number | null;
  unit: StyleUnit;
}

/** px per one `unit`, or `null` where that cannot be known here (`%`, `vh`). */
function pxPer(unit: StyleUnit, ctx: NumberContext): number | null {
  if (unit === 'px' || unit === '' || unit === 'deg') return 1;
  if (unit === 'rem') return ctx.rootFontSize && ctx.rootFontSize > 0 ? ctx.rootFontSize : null;
  if (unit === 'em') return ctx.fontSize && ctx.fontSize > 0 ? ctx.fontSize : null;
  if (unit === 'vw') return ctx.viewportWidth && ctx.viewportWidth > 0 ? ctx.viewportWidth / 100 : null;
  return null;
}

/**
 * The keyword a row stands at, from the first of `sources` that says anything (what this session
 * asked for, then what is declared, then what computed): `null` when that is a number.
 */
export function keywordOf(keywords: readonly StyleKeyword[] | undefined, sources: readonly (string | null | undefined)[]): StyleKeyword | null {
  if (!keywords || keywords.length === 0) return null;
  for (const source of sources) {
    const text = (source ?? '').trim().toLowerCase();
    if (text === '') continue;
    return (keywords as readonly string[]).includes(text) ? (text as StyleKeyword) : null;
  }
  return null;
}

/** A keyword typed into the field, if the row takes it. */
export function typedKeyword(keywords: readonly StyleKeyword[] | undefined, text: string): StyleKeyword | null {
  const typed = text.trim().toLowerCase();
  return keywords && (keywords as readonly string[]).includes(typed) ? (typed as StyleKeyword) : null;
}

/** What a number row shows. */
export function shownNumber(entry: NumberEntry, ctx: NumberContext): ShownNumber {
  if (entry.shape === 'percent') {
    const v = Number.parseFloat(ctx.requested ?? ctx.computed ?? '');
    return { n: Number.isFinite(v) ? round(v * 100, 2) : null, unit: '%' };
  }
  if (entry.shape === 'columns') {
    return { n: columnsOf(ctx.requested ?? ctx.specified?.value ?? ctx.computed), unit: '' };
  }
  const unit = ctx.unit ?? entry.units[0];
  for (const source of [ctx.requested, ctx.specified?.value]) {
    const p = parseNumber(source);
    if (!p || !entry.units.includes(p.unit)) continue;
    if (!ctx.unit || p.unit === ctx.unit) return { n: p.n, unit: p.unit };
  }
  const raw = (ctx.computed ?? '').trim();
  // A rotation of none is no rotation, and normal letter spacing is none: both read as 0.
  if ((raw === 'none' && unit === 'deg') || (raw === 'normal' && entry.property === 'letter-spacing')) return { n: 0, unit };
  const c = parseNumber(raw);
  if (!c) return { n: null, unit };
  if (c.unit === unit) return { n: round(c.n), unit };
  const from = pxPer(c.unit, ctx);
  const to = pxPer(unit, ctx);
  if (from === null || to === null || (c.unit === 'deg') !== (unit === 'deg')) return { n: null, unit };
  return { n: round((c.n * from) / to), unit };
}

const clamp = (entry: NumberEntry, n: number) =>
  Math.min(entry.max ?? Infinity, Math.max(entry.min ?? -Infinity, n));

/** The CSS value for `n` in `unit`, in the row's shape. */
export function writeNumber(entry: NumberEntry, n: number, unit: StyleUnit): string {
  const v = clamp(entry, n);
  if (entry.shape === 'percent') return String(round(v / 100, 4));
  if (entry.shape === 'columns') return `repeat(${Math.max(1, Math.round(v))}, minmax(0, 1fr))`; // i18n-ignore: a CSS value, not text
  if (entry.property === 'z-index') return String(Math.round(v));
  return `${round(v)}${unit}`;
}

/**
 * Where `+`, `−`, a drag and a unit change start: what is shown, or with nothing shown, the row's
 * `startFrom` in the unit on screen (a maximum of `none` starts from the element's own size).
 */
export function baseNumber(shown: ShownNumber, ctx: NumberContext): ShownNumber {
  if (shown.n !== null) return shown;
  const start = parseNumber(ctx.start);
  if (!start) return shown;
  const from = pxPer(start.unit, ctx);
  const to = pxPer(shown.unit, ctx);
  return from === null || to === null || to === 0 ? shown : { n: round((start.n * from) / to), unit: shown.unit };
}

/** One step up or down from what is shown; from 0 when nothing is. */
export function stepNumber(entry: NumberEntry, shown: ShownNumber, direction: 1 | -1): string {
  return writeNumber(entry, (shown.n ?? 0) + direction * entry.step, shown.unit);
}

/** The value `steps` steps from `start`, for a drag on the label. */
export function scrubNumber(entry: NumberEntry, start: ShownNumber, steps: number): string {
  return writeNumber(entry, (start.n ?? 0) + steps * entry.step, start.unit);
}

/** What was shown, in another unit, or `null` when that cannot be worked out here. */
export function convertNumber(entry: NumberEntry, shown: ShownNumber, to: StyleUnit, ctx: NumberContext): string | null {
  if (shown.n === null) return null;
  const from = pxPer(shown.unit, ctx);
  const per = pxPer(to, ctx);
  if (from === null || per === null || per === 0) return null;
  return writeNumber(entry, (shown.n * from) / per, to);
}

/** A typed number, with or without the unit on screen; `null` for anything else. */
export function typedNumber(entry: NumberEntry, text: string, unit: StyleUnit): string | null {
  const p = parseNumber(text);
  if (!p || (p.unit !== '' && p.unit !== unit)) return null;
  return writeNumber(entry, p.n, unit);
}
