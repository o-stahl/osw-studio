/**
 * Colour token matching and swatch actions. Parses CSS colours to 8-bit sRGB for comparison,
 * determines whether a swatch press supersedes a design token, and produces the write declaration.
 * `var()` indirection, `color-mix()`, and `lab()`/`lch()` are not parsed.
 */

import type { StyleDeclaration } from '@/lib/direct-edit/types';
import { readValue } from './controls';
import type { SwatchEntry } from './properties';

/** 8-bit sRGB with alpha in 0..1 — the space every spelling is compared in. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Per-channel tolerance (out of 255). Sized for colour-space transform error, not perceptual similarity. */
export const COLOR_TOLERANCE = 6;

/** The named colours that turn up in real stylesheets. Not the full CSS table, on purpose. */
const NAMED: Readonly<Record<string, Rgba>> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** A component that may be a percentage: `50%` → 127.5, `128` → 128. */
function channel(text: string, full: number): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const percent = trimmed.endsWith('%');
  const n = Number.parseFloat(percent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(n)) return null;
  return percent ? (n / 100) * full : n;
}

function alphaOf(text: string | undefined): number {
  if (text === undefined) return 1;
  const n = channel(text, 1);
  return n === null ? 1 : Math.max(0, Math.min(1, n));
}

/** The arguments of `name(...)`, split on commas and whitespace, with `/ alpha` kept separate. */
function functionArgs(body: string): { parts: string[]; alpha?: string } {
  const [head, tail] = body.split('/');
  const parts = head.trim().split(/[\s,]+/).filter(Boolean);
  return tail === undefined ? { parts } : { parts, alpha: tail.trim() };
}

function parseHex(text: string): Rgba | null {
  const hex = text.slice(1);
  const expand = (c: string) => Number.parseInt(c + c, 16);
  if (hex.length === 3 || hex.length === 4) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    return {
      r: expand(hex[0]),
      g: expand(hex[1]),
      b: expand(hex[2]),
      a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const byte = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 };
  }
  return null;
}

/** Linear-light channel to 8-bit sRGB, sRGB transfer function. */
function encodeSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(Math.max(linear, 0), 1 / 2.4) - 0.055;
  return clamp255(c * 255);
}

/** oklch → sRGB. Out-of-gamut values clamp per channel. */
function oklchToRgb(l: number, c: number, hDeg: number): { r: number; g: number; b: number } {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.2914855480 * b;

  const L = lp * lp * lp;
  const M = mp * mp * mp;
  const S = sp * sp * sp;

  return {
    r: encodeSrgb(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: encodeSrgb(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: encodeSrgb(-0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S),
  };
}

/**
 * A CSS colour in 8-bit sRGB, or `null` when this module cannot read it.
 *
 * `null` is the honest answer for `var(--x)`, `color-mix(...)`, a gradient, or a keyword outside the
 * short table — and it is what keeps an unreadable value from being reported as a token match.
 */
export function parseColor(css: string | null | undefined): Rgba | null {
  if (typeof css !== 'string') return null;
  const text = css.trim().toLowerCase();
  if (text === '') return null;

  if (text.startsWith('#')) return parseHex(text);

  const named = NAMED[text];
  if (named) return { ...named };

  const call = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (!call) return null;
  const [, name, body] = call;
  const { parts, alpha } = functionArgs(body);

  if (name === 'rgb' || name === 'rgba') {
    // `rgba(1, 2, 3, 0.5)` puts alpha in the fourth comma-separated slot; `rgb(1 2 3 / 50%)` after
    // the slash. Both spellings reach here, from stylesheets and from getComputedStyle respectively.
    if (parts.length < 3) return null;
    const r = channel(parts[0], 255);
    const g = channel(parts[1], 255);
    const b = channel(parts[2], 255);
    if (r === null || g === null || b === null) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alphaOf(alpha ?? parts[3]) };
  }

  if (name === 'oklch') {
    if (parts.length < 3) return null;
    const l = channel(parts[0], 1);
    const c = Number.parseFloat(parts[1]);
    const h = Number.parseFloat(parts[2]);
    if (l === null || !Number.isFinite(c) || !Number.isFinite(h)) return null;
    return { ...oklchToRgb(l, c, h), a: alphaOf(alpha ?? parts[3]) };
  }

  return null;
}

/**
 * A CSS colour as the `#rrggbb` an `input[type=color]` takes, or `null` when it cannot be read.
 *
 * **Alpha is dropped**, because the control has none: `#rrggbbaa` is not a value that element
 * accepts, and it opens on black for anything it cannot parse. This is only what the picker *opens*
 * on — nothing is written from it until the user picks something, at which point the value written
 * is the picker's own opaque hex.
 */
export function hexColor(css: string | null | undefined): string | null {
  const rgba = parseColor(css);
  if (!rgba) return null;
  const pair = (n: number) => clamp255(n).toString(16).padStart(2, '0');
  return `#${pair(rgba.r)}${pair(rgba.g)}${pair(rgba.b)}`;
}

/** Same colour, within {@link COLOR_TOLERANCE}? Alpha is compared too — a tint is not its base. */
export function colorsMatch(a: Rgba, b: Rgba, tolerance = COLOR_TOLERANCE): boolean {
  return Math.abs(a.r - b.r) <= tolerance
    && Math.abs(a.g - b.g) <= tolerance
    && Math.abs(a.b - b.b) <= tolerance
    && Math.abs(a.a - b.a) <= tolerance / 255;
}

/** Compares declared token text against computed colour across formats (hex, oklch, rgb). */
export function sameColor(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseColor(a);
  const right = parseColor(b);
  if (!left || !right) return false;
  return colorsMatch(left, right);
}

export interface ColorToken {
  /** Including the leading dashes, as it is written and as `var()` takes it. */
  name: string;
  /** The declaration's text, in whatever spelling the stylesheet used. */
  value: string;
  /** The VFS path it was declared in. */
  file: string;
  rgba: Rgba;
}

export interface CssSource {
  path: string;
  content: string;
}

/** `--name: value;` — value runs to the next `;` or the end of the block. */
const CUSTOM_PROPERTY_RE = /(--[a-z0-9_-]+)\s*:\s*([^;}]+)/gi;

/**
 * The colour tokens a project declares, read out of its own stylesheets.
 *
 * No fixed list: a project that renamed `--accent` to `--brand-ink`, or that never used the built-in
 * templates at all, has to work. Sources are scanned in the order given and a later declaration of
 * the same name replaces an earlier one, which is what the cascade does for equal-specificity
 * `:root` blocks — though for detection it only decides which *spelling* is reported, since a token
 * redeclared as a different colour matches under whichever value wins.
 */
export function discoverColorTokens(sources: readonly CssSource[]): ColorToken[] {
  const found = new Map<string, ColorToken>();
  for (const source of sources) {
    CUSTOM_PROPERTY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CUSTOM_PROPERTY_RE.exec(source.content)) !== null) {
      const name = match[1].toLowerCase();
      const value = match[2].trim();
      const rgba = parseColor(value);
      if (!rgba) continue;
      found.set(name, { name, value, file: source.path, rgba });
    }
  }
  return Array.from(found.values());
}

/** The token this colour is, or `null`. */
export function matchToken(css: string | null | undefined, tokens: readonly ColorToken[]): ColorToken | null {
  const rgba = parseColor(css);
  if (!rgba) return null;
  return tokens.find(token => colorsMatch(rgba, token.rgba)) ?? null;
}

/**
 * The outcome of a swatch press: one declaration, and what it superseded.
 * No variant for "nothing written": a press always writes.
 */
export interface SwatchAction {
  declaration: StyleDeclaration;
  /**
   * The token the replaced colour came from, or `null` when it came from nowhere in particular.
   *
   * Reported so the caller can raise the foot-of-panel note without repeating the lookup — and only
   * for the note. It is not a veto and it never changes {@link declaration}.
   */
  superseded: ColorToken | null;
}

/** Compute the declaration and superseded token for a swatch press. */
export function swatchAction(
  entry: SwatchEntry,
  next: string,
  values: Record<string, string>,
  tokens: readonly ColorToken[],
): SwatchAction {
  // A chosen colour that *is* a token is written as the reference, not as its literal: an element
  // pointed at `--accent` still follows the token when the token later changes.
  const chosen = matchToken(next, tokens);
  return {
    declaration: { property: entry.property, value: chosen ? `var(${chosen.name})` : next },
    superseded: matchToken(readValue(entry, values), tokens),
  };
}

/** Foot-of-panel note after a press superseded a token. Past tense: describes a write that already happened. */
export function tokenSupersedeMessage(
  label: string,
  token: ColorToken,
  t: (key: 'tokenSuperseded', values: Record<string, string>) => string
): string {
  return t('tokenSuperseded', { label, token: token.name, file: token.file });
}

/** The instruction handed to the agent when the user takes that offer. */
export function tokenAgentPrompt(entry: SwatchEntry, token: ColorToken, next: string): string {
  return `Change the ${token.name} design token, declared in ${token.file}, from ${token.value} to ${next}. ` // i18n-ignore: addressed to the agent
    + `I picked this from the selected element's ${entry.label.toLowerCase()} colour, so update the token ` // i18n-ignore: addressed to the agent
    + 'itself rather than adding a per-element override.'; // i18n-ignore: addressed to the agent
}
