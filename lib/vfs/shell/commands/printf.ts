import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, truncate } from '../runtime';

const USAGE = 'printf: usage: printf <format> [arguments...]';

/** The backslash escapes printf reads in its format, and `%b` in an argument. */
function unescape(text: string): string {
  return text.replace(/\\(0[0-7]{0,3}|x[0-9a-fA-F]{1,2}|.)/g, (_, e: string) => {
    if (e[0] === '0') return String.fromCharCode(parseInt(e.slice(1) || '0', 8));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', "'": "'" };
    return map[e] ?? `\\${e}`;
  });
}

function pad(text: string, width: number, left: boolean, zero: boolean): string {
  if (text.length >= width) return text;
  if (left) return text.padEnd(width);
  if (zero) {
    const sign = /^[-+]/.test(text) ? text[0] : '';
    return sign + text.slice(sign.length).padStart(width - sign.length, '0');
  }
  return text.padStart(width);
}

/** A numeric argument as bash reads it: a quoted character gives its code, anything else 0. */
function toNumber(arg: string | undefined): number {
  if (arg === undefined || arg === '') return 0;
  if (/^['"]./.test(arg)) return arg.codePointAt(1)!;
  const n = Number(arg);
  return Number.isFinite(n) ? n : 0;
}

/** Width and precision are capped: `%999999999s` would otherwise build a string of a gigabyte. */
const MAX_FIELD = 10_000;
const field = (n: number) => Math.min(MAX_FIELD, Math.max(0, Math.trunc(n)));

const SPEC = /%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([sdiufFeEgGxXocb%])/g;

/** One pass of the format, taking arguments from `args` at `next`. */
function formatOnce(format: string, args: string[], start: number): { text: string; used: number } {
  let i = start;
  const take = () => args[i++];
  const text = format.replace(SPEC, (_, flags: string, w: string | undefined, p: string | undefined, conv: string) => {
    if (conv === '%') return '%';
    const givenWidth = w === '*' ? toNumber(take()) : w ? Number(w) : 0;
    const width = field(Math.abs(givenWidth));
    const precision = p === '*' ? field(toNumber(take())) : p !== undefined ? field(Number(p)) : undefined;
    // A negative width from `*` pads on the right, as `-` does.
    const left = flags.includes('-') || givenWidth < 0;
    const zero = flags.includes('0') && !left;
    const arg = take();
    let out: string;
    switch (conv) {
      case 's': out = arg ?? ''; if (precision !== undefined) out = out.slice(0, precision); return pad(out, width, left, false);
      case 'b': return pad(unescape(arg ?? ''), width, left, false);
      case 'c': return pad((arg ?? '').slice(0, 1), width, left, false);
      case 'd': case 'i': case 'u': {
        const n = Math.trunc(toNumber(arg));
        out = (n >= 0 && flags.includes('+') ? '+' : n >= 0 && flags.includes(' ') ? ' ' : '') + String(n);
        return pad(out, width, left, zero);
      }
      case 'x': case 'X': case 'o': {
        const n = Math.trunc(toNumber(arg));
        out = n.toString(conv === 'o' ? 8 : 16);
        return pad(conv === 'X' ? out.toUpperCase() : out, width, left, zero);
      }
      default: {
        const n = toNumber(arg);
        // toFixed, toExponential and toPrecision take at most 100 digits.
        const digits = Math.min(100, precision ?? 6);
        out = conv === 'e' || conv === 'E' ? n.toExponential(digits)
          : conv === 'g' || conv === 'G' ? String(Number(n.toPrecision(digits || 1)))
          : n.toFixed(digits);
        if (conv === 'E' || conv === 'G') out = out.toUpperCase();
        if (n >= 0 && flags.includes('+')) out = '+' + out;
        return pad(out, width, left, zero);
      }
    }
  });
  return { text, used: i - start };
}

/** `printf` — formatted output, as bash's builtin does it (writes when redirected). */
export async function printfCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, ctx, redirect } = env;
  const args = env.args[0] === '--' ? env.args.slice(1) : env.args;
  if (args.length === 0) return { stdout: '', stderr: USAGE, exitCode: 2 };

  const format = unescape(args[0]);
  const rest = args.slice(1);
  // The format is used again while arguments are left, and at least once.
  let output = '';
  let next = 0;
  do {
    const { text, used } = formatOnce(format, rest, next);
    output += text;
    if (used === 0) break;
    next += used;
  } while (next < rest.length);

  if (redirect) return applyRedirectGuarded(vfs, projectId, output, redirect, ctx);
  return { stdout: truncate(output), stderr: '', exitCode: 0 };
}
