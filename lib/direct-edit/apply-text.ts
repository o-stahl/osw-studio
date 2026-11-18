/**
 * Splices text at the provenance index (`data-osw-src`), no string searching.
 * Source write (not silent) — the recompile it triggers refreshes stale provenance indices.
 * Child elements, expressions, and multi-instance tags are refused, never guessed at.
 */

import { vfs } from '@/lib/vfs';
import { readOpenTagAt, type OpenTag } from '@/lib/preview/provenance';
import { resolveSelection } from './resolution';
import type { ApplyResult, PreviewSelection, WriteRecorder } from './types';
import { asText } from '@/lib/vfs/as-text';

/** Void elements have no text content to read, and no close tag. */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr',
]);

/** Tags whose content is raw text, not element text. */
export const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);

/**
 * Whitespace that may be reflowed. **U+00A0 is deliberately absent**, and so is every other
 * invisible the spec calls out: collapsing a non-breaking space into an ordinary one makes the two
 * indistinguishable, and the edit would then silently change how the line wraps.
 *
 * `String.prototype.trim` cannot be used for this — it trims U+00A0.
 */
function isReflowSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/**
 * Source spelling → the character it stands for.
 *
 * **Exactly one spelling per character**, which is what makes {@link encodeTextRun} a true inverse:
 * two names for `'` would mean a round trip through this table rewrote one of them as the other.
 * `&apos;` and `&quot;` are omitted for that reason and because encoding every apostrophe and quote
 * a user types would churn the file for nothing — left alone, they survive as literal source text
 * (see the entity rule in {@link encodeTextRun}).
 *
 * Numeric entities (`&#8212;`) are deliberately not decoded either. Decoding them would mean
 * re-encoding to *some* canonical spelling, which rewrites a file that was already correct.
 *
 * A `Map`, not an object literal. An entity name is attacker-and-author-controlled text, and
 * `'constructor' in {}` is `true` — so an object lookup answers yes for `&constructor;` and hands
 * back `Object.prototype.constructor`, which the decoder would then concatenate into the user's
 * text as the source of a function.
 */
const ENTITY_TO_CHAR = new Map<string, string>(Object.entries({
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00A0',
  shy: '\u00AD',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
}));

const CHAR_TO_ENTITY = new Map<string, string>(
  Array.from(ENTITY_TO_CHAR, ([name, char]) => [char, `&${name};`]),
);

/**
 * How far an entity-shaped token at `i` runs, or `0` when there is not one.
 *
 * Shape only — whether the name means anything is {@link ENTITY_TO_CHAR}'s question. Spelled as a
 * scan rather than a regex because both directions consult it and a match-and-replace in one
 * direction only would not stay the other's inverse.
 */
function entityTokenLength(s: string, i: number): number {
  if (s[i] !== '&') return 0;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') j++;
    const digits = j;
    while (j < s.length && /[0-9A-Fa-f]/.test(s[j])) j++;
    if (j === digits) return 0;
  } else {
    const start = j;
    while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
    if (j === start || !/[A-Za-z]/.test(s[start])) return 0;
  }
  return s[j] === ';' ? j + 1 - i : 0;
}

/** The entity name inside a token, lowercase-sensitive (`&Dagger;` is not `&dagger;`). */
function entityName(token: string): string {
  return token.slice(1, -1);
}

/**
 * Source text → what it says.
 *
 * A token this table does not know — a numeric entity, or a name outside the set — is left
 * **verbatim**, not decoded and not escaped. That is the half of the contract
 * {@link encodeTextRun} matches, and it is what keeps a rendering unchanged: `&hearts;` written
 * back as `&amp;hearts;` would turn a heart into the literal text `&hearts;`.
 */
function decodeTextRun(raw: string): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const len = entityTokenLength(raw, i);
    if (len > 0) {
      const token = raw.slice(i, i + len);
      out += ENTITY_TO_CHAR.get(entityName(token)) ?? token;
      i += len;
      continue;
    }
    out += raw[i];
    i++;
  }
  return out;
}

/**
 * What it says → source text. The inverse of {@link decodeTextRun} on anything that came out of it.
 *
 * Three rules, in order:
 *
 * 1. An entity-shaped token whose name is **not** in the table is passed through untouched. It is
 *    what the decoder left alone, so escaping its `&` here would both break the round trip and
 *    change what the page renders.
 * 2. A character the table names is written as that name. `&` is one of them, so a bare `&` the
 *    user typed becomes `&amp;` — a byte change against a source that spelled it bare, and the one
 *    place this is not byte-identical. It is rendering-preserving and it is what the plan asks for.
 * 3. Everything else is written as itself, so `é` stays `é` rather than becoming `&eacute;`.
 *
 * `<` and `>` are in the table, so no separate escape is needed for them — and there must not be
 * one, or a `<` would be escaped twice.
 */
function encodeTextRun(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const len = entityTokenLength(text, i);
    if (len > 0 && !ENTITY_TO_CHAR.has(entityName(text.slice(i, i + len)))) {
      out += text.slice(i, i + len);
      i += len;
      continue;
    }
    out += CHAR_TO_ENTITY.get(text[i]) ?? text[i];
    i++;
  }
  return out;
}

export type TextRangeResult =
  | { ok: true; start: number; end: number; text: string }
  | { ok: false; reason: 'has-children' | 'has-expression' | 'unclosed' | 'not-a-tag' | 'void-element' };

/** Index just past the name of the close tag starting at `i` (which points at `<`). */
function closeTagNameEnd(s: string, i: number): number {
  let j = i + 2;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '>' || c === '<') break;
    j++;
  }
  return j;
}

/**
 * Was this open tag written self-closing?
 *
 * `<circle/>` in an SVG has no content and no close tag, so its range does not exist. Scanned
 * backwards from the `>` rather than matched, because an attribute value can end in `/`
 * (`href="/about/"`) and the quote is what sits between it and the tag end.
 */
export function isSelfClosing(content: string, tag: OpenTag): boolean {
  if (content[tag.tagEnd - 1] !== '>') return false;
  let i = tag.tagEnd - 2;
  while (i > tag.nameEnd && isReflowSpace(content[i])) i--;
  return i >= tag.nameEnd && content[i] === '/';
}

/**
 * The editable text of the element whose open tag starts at `index`.
 *
 * `start`/`end` bracket the element's whole content — everything between the open tag and its
 * matching close tag — while `text` is that content **trimmed of reflowable whitespace and
 * decoded**. The two are deliberately not the same string: the user edits what the element says,
 * and {@link writeTextRange} puts the indentation back from the file rather than from anything the
 * user typed.
 *
 * The close tag is found by walking, counting only tags of the *same name*, so a `<div>` inside a
 * `<div>` does not end it early. Everything else in the range is inspected on the way past, and the
 * refusals are the point:
 *
 * - `has-children` — an element, a comment or a stray close tag shares the range, so replacing the
 *   run would clobber markup. Selecting the child itself is still editable.
 * - `has-expression` — a `{{ }}` renders the text, so the literal in the file is not what the user
 *   is looking at; writing over it would change the template and not the value.
 * - `unclosed` — no matching close tag, so there is no range at all.
 * - `void-element` / `not-a-tag` — nothing to read. `not-a-tag` is the stale-index signal.
 *
 * Pure. No VFS, no DOM, and **no string search for the text** — see this module's header.
 */
export function readTextRange(content: string, index: number): TextRangeResult {
  const tag = readOpenTagAt(content, index);
  if (!tag) return { ok: false, reason: 'not-a-tag' };
  if (VOID_TAGS.has(tag.tagName) || isSelfClosing(content, tag)) {
    return { ok: false, reason: 'void-element' };
  }

  const n = content.length;
  // Lowercased lazily. Only a raw-text tag needs it — `script`, `style`, `title`, `textarea` — and
  // eagerly copying the whole file to serve a lookup most elements never make is a full-length string
  // allocation on every selection.
  let lowered: string | null = null;
  const lower = (): string => (lowered ??= content.toLowerCase());
  let end = -1;
  let sawChild = false;
  let sawExpression = false;

  if (RAW_TEXT_TAGS.has(tag.tagName)) {
    // Its content is text by definition, so a `<` in there is a character and not a tag. Nesting is
    // impossible, which is why this does not walk.
    const close = lower().indexOf(`</${tag.tagName}`, tag.tagEnd);
    if (close === -1) return { ok: false, reason: 'unclosed' };
    end = close;
    sawExpression = content.slice(tag.tagEnd, end).includes('{{');
  } else {
    let depth = 1;
    let i = tag.tagEnd;
    while (i < n) {
      // Mustaches first: `{{#if a}}<b>{{/if}}` is not markup this may tokenize, and a `}}` can hold
      // anything at all. Any of them in the range is a refusal, so the scan only has to get *past*
      // them correctly.
      if (content.startsWith('{{', i)) {
        const triple = content.startsWith('{{{', i);
        const closeAt = content.indexOf(triple ? '}}}' : '}}', i + (triple ? 3 : 2));
        sawExpression = true;
        i = closeAt === -1 ? n : closeAt + (triple ? 3 : 2);
        continue;
      }
      if (content.startsWith('<!--', i)) {
        // A comment is a child node: splicing over the range would delete it. `<!-->` and `<!--->`
        // are legal abrupt-closing empty comments, and searching for `-->` past their terminator
        // swallows the rest of the file.
        sawChild = true;
        if (content.startsWith('>', i + 4)) { i += 5; continue; }
        if (content.startsWith('->', i + 4)) { i += 6; continue; }
        const closeAt = content.indexOf('-->', i + 4);
        i = closeAt === -1 ? n : closeAt + 3;
        continue;
      }
      if (content.startsWith('<![CDATA[', i)) {
        sawChild = true;
        const closeAt = content.indexOf(']]>', i + 9);
        i = closeAt === -1 ? n : closeAt + 3;
        continue;
      }
      if (content.startsWith('<!', i)) {
        sawChild = true;
        const closeAt = content.indexOf('>', i + 2);
        i = closeAt === -1 ? n : closeAt + 1;
        continue;
      }
      if (content.startsWith('</', i)) {
        const nameEnd = closeTagNameEnd(content, i);
        const name = content.slice(i + 2, nameEnd).toLowerCase();
        const gt = content.indexOf('>', nameEnd);
        if (name === tag.tagName) {
          depth--;
          if (depth === 0) { end = i; break; }
        } else {
          // A close tag for something else means markup opened before this element and closed
          // inside it, or the file is malformed. Either way the range is not one plain run.
          sawChild = true;
        }
        i = gt === -1 ? n : gt + 1;
        continue;
      }
      const child = readOpenTagAt(content, i);
      if (child) {
        sawChild = true;
        // Depth only tracks same-name tags, so a self-closing one would over-count — but a range
        // containing any child is refused before `end` is consulted, so the miscount is unreachable.
        if (child.tagName === tag.tagName && !isSelfClosing(content, child)) depth++;
        if (RAW_TEXT_TAGS.has(child.tagName)) {
          const close = lower().indexOf(`</${child.tagName}`, child.tagEnd);
          i = close === -1 ? n : close;
        } else {
          i = child.tagEnd;
        }
        continue;
      }
      i++;
    }
    if (end === -1) return { ok: false, reason: 'unclosed' };
  }

  // Order matters only for a range that is wrong in two ways at once, and markup is the one worth
  // naming: "it contains a link" is something a user can act on, "it contains an expression" is not
  // the thing they can see.
  if (sawChild) return { ok: false, reason: 'has-children' };
  if (sawExpression) return { ok: false, reason: 'has-expression' };

  const raw = content.slice(tag.tagEnd, end);
  let from = 0;
  while (from < raw.length && isReflowSpace(raw[from])) from++;
  let to = raw.length;
  while (to > from && isReflowSpace(raw[to - 1])) to--;

  return { ok: true, start: tag.tagEnd, end, text: decodeTextRun(raw.slice(from, to)) };
}

/** Preserves surrounding whitespace so a round-trip through readTextRange/writeTextRange is byte-identical. */
export function writeTextRange(
  content: string,
  range: { start: number; end: number },
  nextText: string,
): string {
  const raw = content.slice(range.start, range.end);
  let from = 0;
  while (from < raw.length && isReflowSpace(raw[from])) from++;
  let to = raw.length;
  while (to > from && isReflowSpace(raw[to - 1])) to--;

  const lead = raw.slice(0, from);
  const trail = raw.slice(to);
  return content.slice(0, range.start) + lead + encodeTextRun(nextText) + trail + content.slice(range.end);
}

/** Where the selected element's source is, or why it cannot be said. */
type Located =
  | { ok: true; file: string; tagStart: number; instances: number; content: string }
  | { ok: false; reason: NonNullable<ApplyResult['reason']>; file?: string };

/** Tag-name check prevents a stale index from reading an unrelated element's text. */
async function locate(projectId: string, selection: PreviewSelection): Promise<Located> {
  const resolution = resolveSelection(selection);
  if (resolution.kind === 'unresolvable') return { ok: false, reason: 'unresolvable' };

  const file = resolution.file;
  let content: string;
  try {
    content = asText((await vfs.readFile(projectId, file)).content);
  } catch {
    return { ok: false, reason: 'missing-file', file };
  }

  const tag = readOpenTagAt(content, resolution.tagStart);
  if (!tag || (selection.tagName && tag.tagName !== selection.tagName.toLowerCase())) {
    return { ok: false, reason: 'stale-index', file };
  }

  return {
    ok: true,
    file,
    tagStart: resolution.tagStart,
    instances: resolution.kind === 'one-to-many' ? resolution.instances : 1,
    content,
  };
}

export type TextReadResult =
  | { ok: true; text: string; file: string; instances: number }
  | { ok: false; reason: NonNullable<ApplyResult['reason']>; file?: string };

/**
 * Reads the source text for the popover. Separate from applyText because the rendered text
 * differs from source text (entities, whitespace).
 */
export async function readSourceText(
  projectId: string,
  selection: PreviewSelection,
): Promise<TextReadResult> {
  const located = await locate(projectId, selection);
  if (!located.ok) return { ok: false, reason: located.reason, file: located.file };

  const range = readTextRange(located.content, located.tagStart);
  if (!range.ok) {
    return {
      ok: false,
      reason: range.reason === 'not-a-tag' ? 'stale-index' : range.reason,
      file: located.file,
    };
  }
  return { ok: true, text: range.text, file: located.file, instances: located.instances };
}

/**
 * Write `nextText` as the selected element's text, durably.
 *
 * `confirmedMultiInstance` is required when the tag renders more than once.
 *
 * `isGenerating` is injected to keep `lib/direct-edit/` free of store imports.
 */
export async function applyText(
  projectId: string,
  selection: PreviewSelection,
  nextText: string,
  opts?: { confirmedMultiInstance?: boolean; isGenerating?: () => boolean; record?: WriteRecorder },
): Promise<ApplyResult> {
  // A write landing mid-generation races the agent's own edits over the same files.
  if (opts?.isGenerating?.()) return { ok: false, reason: 'generating', filesWritten: [] };

  const resolution = resolveSelection(selection);
  if (resolution.kind === 'one-to-many' && !opts?.confirmedMultiInstance) {
    return {
      ok: false,
      reason: 'needs-confirmation',
      file: resolution.file,
      instances: resolution.instances,
      filesWritten: [],
    };
  }

  const located = await locate(projectId, selection);
  if (!located.ok) {
    return { ok: false, reason: located.reason, file: located.file, filesWritten: [] };
  }

  const range = readTextRange(located.content, located.tagStart);
  if (!range.ok) {
    // `not-a-tag` cannot arrive — `locate` already read the tag — but it is mapped rather than
    // assumed away, and `stale-index` is what it would mean.
    return {
      ok: false,
      reason: range.reason === 'not-a-tag' ? 'stale-index' : range.reason,
      file: located.file,
      filesWritten: [],
    };
  }

  const next = writeTextRange(located.content, range, nextText);
  // Identical content is not written. The write is what forces the recompile, and a recompile that
  // changes nothing costs the user their toolbar and their scroll position for no reason.
  if (next === located.content) return { ok: true, filesWritten: [] };

  await vfs.updateFile(projectId, located.file, next);
  opts?.record?.({ path: located.file, before: located.content, after: next, silent: false });
  return { ok: true, file: located.file, filesWritten: [located.file] };
}
