import type { PreviewSelection, SourceResolution } from './types';

/**
 * `[file, offset]` of a `data-osw-src` value, or `null` for a malformed one.
 *
 * **Splits on the LAST colon.** A project may legitimately contain a file named `/index.html:67`,
 * so `split(':')` and `indexOf(':')` both produce a wrong path and a wrong index on real input.
 * The index must then be all digits — parsing `'abc'` with `parseInt` yields `NaN`, which flows on
 * as a silently wrong offset rather than an error. `colon === 0` is `':5'` — an empty path, which is
 * as unusable as no colon at all.
 */
export function parseSrc(src: string): [file: string, offset: number] | null {
  const colon = src.lastIndexOf(':');
  if (colon <= 0) return null;
  const rawIndex = src.slice(colon + 1);
  if (!/^\d+$/.test(rawIndex)) return null;
  const offset = Number(rawIndex);
  if (!Number.isSafeInteger(offset)) return null;
  return [src.slice(0, colon), offset];
}

/**
 * A source position as the agent reads and writes it: `/index.html:16:5`, a file with a 1-based
 * line and column, the form `rg -n` and every compiler print. `data-osw-src` counts code units from
 * the start of the file instead, which reads as a line number to anyone who was not told otherwise,
 * so that form stays inside the app.
 */
export function sourceRef(file: string, content: string, offset: number): string {
  const { line, col } = positionAt(content, offset);
  return `${file}:${line}:${col}`;
}

/** The 1-based line and column of `offset` in `content`. */
export function positionAt(content: string, offset: number): { line: number; col: number } {
  const end = Math.max(0, Math.min(offset, content.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < end; i++) if (content.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  return { line, col: end - lineStart + 1 };
}

/** Where line `line` (1-based) starts and ends in `content`, without its newline; `null` past the end. */
export function lineRange(content: string, line: number): { start: number; end: number } | null {
  if (!Number.isInteger(line) || line < 1) return null;
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = content.indexOf('\n', start);
    if (next === -1) return null;
    start = next + 1;
  }
  const end = content.indexOf('\n', start);
  return { start, end: end === -1 ? content.length : end };
}

/** The 1-based line `offset` falls on in `content`. */
export function lineAt(content: string, offset: number): number {
  return positionAt(content, offset).line;
}

/**
 * Turn a preview selection into a source location.
 *
 * Pure. Never guesses: an element built by JS carries no `data-osw-src`, and a guessed location
 * gets a marker stamped into the wrong file with nothing downstream able to notice. See `parseSrc`
 * for how the attribute is read.
 */
export function resolveSelection(selection: PreviewSelection): SourceResolution {
  const srcAttr = selection.srcAttr;

  // No attribute at all is the ordinary case for a JS-generated element, not a failure.
  if (srcAttr === undefined || srcAttr === null) {
    return { kind: 'unresolvable', reason: 'generated' };
  }

  const parts = parseSrc(srcAttr);
  if (!parts) return { kind: 'unresolvable', reason: 'malformed' };
  const [file, tagStart] = parts;

  const instances = selection.instanceCount ?? 1;
  if (instances > 1) return { kind: 'one-to-many', file, tagStart, instances };

  return { kind: 'resolved', file, tagStart };
}
