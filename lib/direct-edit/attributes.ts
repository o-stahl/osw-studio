/** Reads and counts a named attribute in an HTML open tag without regex. */

import type { OpenTag } from '@/lib/preview/provenance';

/**
 * One attribute's value, and the span it occupies.
 *
 * `valueStart`/`valueEnd` bracket the value text *inside* the quotes, so `content.slice(valueStart,
 * valueEnd) === value` whether or not the value was quoted. A rewriter that wants to replace the
 * quotes too widens the span itself — and has to check that the closing quote is actually there,
 * because a truncated tag ends the value at the tag end with no quote to consume.
 */
export interface AttributeSpan {
  value: string;
  valueStart: number;
  valueEnd: number;
  /** The quote character the value was written with, or `null` when it was unquoted. */
  quote: '"' | "'" | null;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

/**
 * Walk one open tag's attributes, calling `visit` with each name and span.
 *
 * Walks rather than regex-matching the region, because a regex matches the attribute's spelling
 * wherever it appears — including inside *another attribute's value* (`title=" src='x'"`). That
 * reads as a false positive, and a caller then edits a span that is part of somebody else's string.
 * Attribute values are consumed as values here, so they cannot be mistaken for names.
 *
 * Mustaches are opaque for the same reason they are in `findTagEnd`: `{{#if a}}title="x>y"{{/if}}`
 * is not attribute syntax and must not be tokenized as if it were. Note what that means for an
 * attribute written *inside* one: the mustache is skipped, so `{{#if a}}src="x"{{/if}}` yields an
 * ordinary `src` — the walk reports what is spelled in the tag, and whether the template makes it
 * conditional is a question for the caller.
 *
 * Scoped to the one tag, never the whole file, so an attribute on the previous or the next element
 * cannot be mistaken for this one's.
 *
 * @param visit return `true` to stop the walk.
 */
function walkAttributes(
  s: string,
  tag: OpenTag,
  visit: (name: string, span: AttributeSpan) => boolean | void,
  /** Told about attributes written without a value (`<div hidden>`), which `visit` never sees. */
  valueless?: (name: string) => boolean | void,
): void {
  const to = tag.tagEnd;
  let i = tag.nameEnd;

  while (i < to) {
    if (s.startsWith('{{{', i)) { const e = s.indexOf('}}}', i + 3); i = e === -1 || e >= to ? to : e + 3; continue; }
    if (s.startsWith('{{', i))  { const e = s.indexOf('}}', i + 2);  i = e === -1 || e >= to ? to : e + 2; continue; }

    const c = s[i];
    if (isSpace(c) || c === '/') { i++; continue; }
    // Redundant with `to` on well-formed markup — both land on the same character — and kept
    // because each covers the other's failure mode: without `to` a truncated tag scans to end of
    // file, and without this break a `>` at an attribute-name position advances nothing and spins.
    if (c === '>') break;
    // A quote where an attribute name should be is malformed markup; skip the span rather than
    // reading its contents as names.
    if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); i = e === -1 || e >= to ? to : e + 1; continue; }

    const nameStart = i;
    while (i < to && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '/' && s[i] !== '>' &&
           s[i] !== '"' && s[i] !== "'" && !s.startsWith('{{', i)) i++;
    const attr = s.slice(nameStart, i).toLowerCase();

    while (i < to && isSpace(s[i])) i++;
    if (s[i] !== '=') {                      // valueless attribute — next name starts here
      if (attr && valueless?.(attr) === true) return;
      continue;
    }
    i++;
    while (i < to && isSpace(s[i])) i++;

    let span: AttributeSpan;
    const q = s[i];
    if (q === '"' || q === "'") {
      const e = s.indexOf(q, i + 1);
      const end = e === -1 || e >= to ? to : e;
      span = { value: s.slice(i + 1, end), valueStart: i + 1, valueEnd: end, quote: q };
      i = end + 1;
    } else {
      const vStart = i;
      while (i < to && !isSpace(s[i]) && s[i] !== '>') i++;
      span = { value: s.slice(vStart, i), valueStart: vStart, valueEnd: i, quote: null };
    }

    if (visit(attr, span) === true) return;
  }
}

/**
 * Find `name` among the attributes of one open tag, or `null`. The first, when a malformed or
 * conditional tag spells it more than once.
 *
 * @param name matched case-insensitively, as HTML attribute names are.
 */
export function findAttributeIn(s: string, tag: OpenTag, name: string): AttributeSpan | null {
  const wanted = name.toLowerCase();
  let found: AttributeSpan | null = null;
  walkAttributes(s, tag, (attr, span) => {
    if (attr !== wanted) return;
    found = span;
    return true;
  });
  return found;
}

/** Whether one open tag carries `name`, with or without a value (`data-osw-lock` usually has none). */
export function hasAttributeIn(s: string, tag: OpenTag, name: string): boolean {
  const wanted = name.toLowerCase();
  let found = false;
  const hit = (attr: string) => {
    if (attr !== wanted) return;
    found = true;
    return true;
  };
  walkAttributes(s, tag, hit, hit);
  return found;
}

/** Separate from findAttributeIn so the common path keeps its early return. */
export function countAttributeIn(s: string, tag: OpenTag, name: string): number {
  const wanted = name.toLowerCase();
  let count = 0;
  walkAttributes(s, tag, attr => { if (attr === wanted) count++; });
  return count;
}
