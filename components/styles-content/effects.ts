/**
 * The Effects and Colour groups' compound values: a shadow's first layer, a two-colour linear
 * gradient, and the blur in a filter list. Each is read out of the declaration as written (or the
 * computed value) and written back whole, keeping what the controls do not show: a shadow's other
 * layers, a filter list's other functions.
 */

const COLOR_RE = /(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8}\b|var\(--[\w-]+\))/;

/** `v` split at its top-level commas: the layers of a box-shadow, the stops of a gradient. */
export function layers(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
  inset: boolean;
  /** The layers after the first, written back as they were. */
  rest: string[];
}

/** The first shadow layer as fields, or `null` for no shadow. */
export function parseShadow(v: string | null | undefined): Shadow | null {
  const text = (v ?? '').trim();
  if (text === '' || text === 'none') return null;
  const [first, ...rest] = layers(text);
  const color = (first.match(COLOR_RE) ?? ['rgba(0, 0, 0, 0.18)'])[0];
  const lengths = first.replace(color, '').match(/-?[\d.]+(px)?(?=\s|$)/g) ?? [];
  const [x = 0, y = 0, blur = 0, spread = 0] = lengths.map((n) => Number.parseFloat(n));
  return { x, y, blur, spread, color, inset: /\binset\b/.test(first), rest };
}

/** A length the fields show as it is: px, or a bare zero. */
const PX_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)px$|^-?0*\.?0+$/;

/** A shadow whose first layer is a colour and two to four px lengths (and maybe `inset`): what the fields write back. */
function plainShadow(v: string): boolean {
  const text = v.trim();
  if (text === '' || text === 'none') return false;
  const first = layers(text)[0];
  const color = first.match(COLOR_RE)?.[0];
  if (!color) return false;
  const words = first.replace(color, ' ').trim().split(/\s+/).filter(word => word !== 'inset');
  return words.length >= 2 && words.length <= 4 && words.every(word => PX_LENGTH.test(word));
}

/**
 * The shadow the fields show: the declaration as written where they can read it, else the computed
 * value, which the engine gives as a colour and px lengths. A shadow kept in a variable, or written in
 * rem, would read as zeros and be written back as them.
 */
export function readShadow(written: string | null | undefined, computed: string | null | undefined): Shadow | null {
  const text = (written ?? '').trim();
  if (text === '' || text === 'none') return null;
  if (plainShadow(text)) return parseShadow(text);
  const engine = computed ?? '';
  return plainShadow(engine) ? parseShadow(engine) : null;
}

export function shadowString(s: Shadow): string {
  return [`${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`, ...s.rest].join(', ');
}

/** What + Shadow writes. */
export const NEW_SHADOW = '0px 8px 24px 0px rgba(0, 0, 0, 0.16)';

export interface Gradient {
  angle: number;
  from: string;
  to: string;
}

/** The arguments of a value that is one `linear-gradient(…)` and nothing else, or `null`. */
function gradientArgs(v: string | null | undefined): string[] | null {
  const all = layers((v ?? '').trim());
  if (all.length !== 1) return null;
  const call = /^linear-gradient\(([\s\S]*)\)$/i.exec(all[0]);
  return call ? layers(call[1]) : null;
}

/** Whether a background is one linear gradient, and no other layer. */
export function isOneGradient(v: string | null | undefined): boolean {
  return gradientArgs(v) !== null;
}

/** The side keywords, as the angles they stand for. */
const SIDES: ReadonlyMap<string, number> = new Map([['to top', 0], ['to right', 90], ['to bottom', 180], ['to left', 270]]);

/** A stop the fields write back as it is: a colour alone, with no position. */
const STOP_RE = new RegExp(`^(?:${COLOR_RE.source}|[a-z]+)$`, 'i');

/**
 * A linear gradient's angle and two colours, or `null` for anything the fields cannot write back
 * whole: no gradient, a gradient with other layers (an image under it), or one with more stops, or
 * stops placed at positions.
 */
export function parseGradient(v: string | null | undefined): Gradient | null {
  const args = gradientArgs(v);
  if (!args) return null;
  let angle = 180;
  const direction = (args[0] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const degrees = /^(-?[\d.]+)deg$/.exec(direction);
  if (degrees) {
    angle = Number.parseFloat(degrees[1]);
    args.shift();
  } else if (SIDES.has(direction)) {
    angle = SIDES.get(direction) ?? angle;
    args.shift();
  }
  if (args.length !== 2 || !args.every(stop => STOP_RE.test(stop))) return null;
  return { angle, from: args[0], to: args[1] };
}

export function gradientString(g: Gradient): string {
  return `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`;
}

/** The radius of a filter list's `blur()`, 0 for none. */
export function blurOf(v: string | null | undefined): number {
  const m = String(v ?? '').match(/blur\(\s*([\d.]+)px\s*\)/);
  return m ? Number.parseFloat(m[1]) : 0;
}

/** A filter list with its `blur()` set to `px` (0 takes it out); the list's other functions stay. `null` when nothing is left. */
export function withBlur(list: string | null | undefined, px: number): string | null {
  const rest = String(list ?? '').replace(/\bnone\b/, '').replace(/blur\([^)]*\)/, '').trim().replace(/\s+/g, ' ');
  const v = [px > 0 ? `blur(${px}px)` : '', rest].filter(Boolean).join(' '); // i18n-ignore: a CSS value, not text
  return v || null;
}
