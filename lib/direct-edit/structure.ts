/**
 * Structural edits on one source file: where an element's markup runs, and the operations the
 * Canvas and the Elements tab offer on it (move, wrap, unwrap, duplicate, delete, insert).
 *
 * Pure: strings in, strings out. Every operation splices the file at the offset provenance names
 * (`data-osw-src`), keeps the file's indentation, and says how the old offsets map into the new
 * content (`Piece[]`), which is what lets the frames show the edit before the recompile does.
 *
 * Template blocks (`{{#each}}`, `{{#if}}`, `{{else}}`) are invisible in the rendered page, so an edit
 * that carried markup into or out of one would change what renders, or how often. Every operation
 * checks that the markup it touches is balanced and lands in the block it came from, and refuses
 * otherwise. Plain expressions (`{{title}}`, `{{> card}}`) inside a range are fine.
 */

import { readOpenTagAt, carriesProvenance } from '@/lib/preview/provenance';
import { RAW_TEXT_TAGS, VOID_TAGS, isSelfClosing } from './apply-text';
import { hasAttributeIn } from './attributes';

/** A wrapper the Canvas made: the one element Unwrap takes apart. */
export const FRAME_ATTR = 'data-osw-frame';
/** Restyle only: nothing moves into, out of or around an element carrying it. */
export const LOCK_ATTR = 'data-osw-lock';

/** One element as the file spells it. */
export interface SourceNode {
  /** Lowercase. */
  tag: string;
  /** The `<` of its open tag. */
  start: number;
  /** Just past its open tag's `>`. */
  openEnd: number;
  /** The `<` of its close tag; `openEnd` for a void or self-closing element. */
  closeStart: number;
  /** Just past its close tag's `>`; `openEnd` for a void or self-closing element. */
  end: number;
  /** Its parent's index in the scan, or -1 at the top of the file. */
  parent: number;
  /** Closed by the parser rather than by a close tag of its own, so its range is a guess. */
  implied: boolean;
}

/**
 * The new content as old ranges kept and new text put: `[from, to]` keeps `old.slice(from, to)`, a
 * number is that many characters of new text. Concatenated in order they spell the new content.
 */
export type Piece = [number, number] | number;

export interface StructureEdit {
  content: string;
  pieces: Piece[];
  /** Where the element the edit leaves selected starts in the new content; `null` when none is. */
  select: number | null;
  /**
   * Where the elements the edit created start in the new content, in document order, for the ones
   * the compile tags: the inserted element, the wrapper, or the copy and everything in it.
   */
  created: number[];
}

export type StructureRefusal =
  /** No element starts at the offset: the file changed since the page was compiled. */
  | 'stale-index'
  /** The element, or the one it goes into, has no close tag of its own. */
  | 'unclosed'
  /** The edit would move markup into or out of a template block, or the range is not balanced. */
  | 'crosses-template'
  /** `data-osw-lock` on the element, the place it goes, or one of their ancestors. */
  | 'locked'
  | 'into-itself'
  | 'not-a-frame'
  /** No sibling to move past, a void parent, or a place between elements of other files. */
  | 'no-place';

export type StructureResult = { ok: true; edit: StructureEdit } | { ok: false; reason: StructureRefusal };

// ---------- scanning ----------

/** Just past the mustache that starts at `i` (which points at `{{`). */
function mustacheEnd(s: string, i: number): number {
  const n = s.length;
  const close = (marker: string, from: number) => {
    const e = s.indexOf(marker, from);
    return e === -1 ? n : e + marker.length;
  };
  if (s.startsWith('{{{{', i)) return close('}}}}', i + 4);
  if (s.startsWith('{{!--', i)) return close('--}}', i + 5);
  if (s.startsWith('{{{', i)) return close('}}}', i + 3);
  return close('}}', i + 2);
}

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

/** Just past the comment, CDATA section or declaration at `i`, or -1 when none starts there. */
function skipMarkupDeclaration(s: string, i: number): number {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    // `<!-->` and `<!--->` are legal abrupt-closing empty comments.
    if (s.startsWith('>', i + 4)) return i + 5;
    if (s.startsWith('->', i + 4)) return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? n : e + 3;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e === -1 ? n : e + 3;
  }
  if (s.startsWith('<!', i)) {
    const e = s.indexOf('>', i + 2);
    return e === -1 ? n : e + 1;
  }
  return -1;
}

/**
 * Every element in the file, in document order, with its range and parent.
 *
 * A close tag closes the nearest open element of its name, and any opened after it are marked
 * `implied`; a stray close tag is skipped. Mustaches are opaque, as they are to provenance.
 */
export function scanElements(content: string): SourceNode[] {
  const nodes: SourceNode[] = [];
  const stack: number[] = [];
  const n = content.length;
  let lowered: string | null = null;
  const lower = () => (lowered ??= content.toLowerCase());
  let i = 0;
  while (i < n) {
    const c = content[i];
    if (c === '{' && content.startsWith('{{', i)) { i = mustacheEnd(content, i); continue; }
    if (c !== '<') { i++; continue; }
    const skipped = skipMarkupDeclaration(content, i);
    if (skipped !== -1) { i = skipped; continue; }
    if (content.startsWith('</', i)) {
      const nameEnd = closeTagNameEnd(content, i);
      const name = content.slice(i + 2, nameEnd).toLowerCase();
      const gt = content.indexOf('>', nameEnd);
      const after = gt === -1 ? n : gt + 1;
      let k = stack.length - 1;
      while (k >= 0 && nodes[stack[k]].tag !== name) k--;
      if (k >= 0) {
        while (stack.length - 1 > k) {
          const open = nodes[stack.pop()!];
          open.closeStart = open.end = i;
          open.implied = true;
        }
        const closed = nodes[stack.pop()!];
        closed.closeStart = i;
        closed.end = after;
      }
      i = after;
      continue;
    }
    const tag = readOpenTagAt(content, i);
    if (!tag) { i++; continue; }
    const node: SourceNode = {
      tag: tag.tagName,
      start: i,
      openEnd: tag.tagEnd,
      closeStart: tag.tagEnd,
      end: tag.tagEnd,
      parent: stack.length ? stack[stack.length - 1] : -1,
      implied: false,
    };
    const index = nodes.push(node) - 1;
    if (VOID_TAGS.has(tag.tagName) || isSelfClosing(content, tag)) { i = tag.tagEnd; continue; }
    if (RAW_TEXT_TAGS.has(tag.tagName)) {
      const close = lower().indexOf(`</${tag.tagName}`, tag.tagEnd);
      if (close === -1) {
        node.closeStart = node.end = n;
        node.implied = true;
        i = n;
      } else {
        const gt = content.indexOf('>', close);
        node.closeStart = close;
        node.end = gt === -1 ? n : gt + 1;
        i = node.end;
      }
      continue;
    }
    stack.push(index);
    i = tag.tagEnd;
  }
  for (const open of stack) {
    nodes[open].closeStart = nodes[open].end = n;
    nodes[open].implied = true;
  }
  return nodes;
}

/**
 * The template block a position sits in, as a key two positions can be compared by: each open
 * block's start and which of its branches (`{{else}}`, `{{^}}`) the position is in.
 */
export function templateScope(content: string, pos: number): string {
  const stack: { at: number; branch: number }[] = [];
  let i = content.indexOf('{{');
  while (i !== -1 && i < pos) {
    const end = mustacheEnd(content, i);
    if (end > pos) break;
    if (!content.startsWith('{{{', i) && !content.startsWith('{{!', i)) {
      let body = content.slice(i + 2, end - 2);
      if (body.startsWith('~')) body = body.slice(1);
      if (body.endsWith('~')) body = body.slice(0, -1);
      body = body.trim();
      if (body.startsWith('#') || (body.startsWith('^') && body.length > 1)) {
        stack.push({ at: i, branch: 0 });
      } else if (body.startsWith('/')) {
        stack.pop();
      } else if ((body === '^' || body === 'else' || body.startsWith('else ')) && stack.length) {
        stack[stack.length - 1].branch++;
      }
    }
    i = content.indexOf('{{', end);
  }
  return stack.map(open => `${open.at}:${open.branch}`).join('/');
}

/** The element whose open tag starts at `start`. */
function nodeAt(nodes: SourceNode[], start: number): number {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].start === start) return mid;
    if (nodes[mid].start < start) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** `data-osw-lock` on this element or any element around it. */
function isLocked(content: string, nodes: SourceNode[], index: number): boolean {
  for (let k = index; k !== -1; k = nodes[k].parent) {
    const tag = readOpenTagAt(content, nodes[k].start);
    if (tag && hasAttributeIn(content, tag, LOCK_ATTR)) return true;
  }
  return false;
}

/** Whether the element is a Canvas frame. */
function isFrameAt(content: string, start: number): boolean {
  const tag = readOpenTagAt(content, start);
  return !!tag && hasAttributeIn(content, tag, FRAME_ATTR);
}

/** Whether the element, or one around it, carries `data-osw-lock`. */
export function isLockedAt(content: string, start: number): boolean {
  const nodes = scanElements(content);
  const index = nodeAt(nodes, start);
  return index !== -1 && isLocked(content, nodes, index);
}

// ---------- lines ----------

const lineStartOf = (s: string, i: number) => s.lastIndexOf('\n', i - 1) + 1;
/** The `\n` ending the line `i` is on, or the end of the file. */
const lineEndOf = (s: string, i: number) => {
  const nl = s.indexOf('\n', i);
  return nl === -1 ? s.length : nl;
};
const indentOf = (s: string, lineStart: number) => {
  let j = lineStart;
  while (s[j] === ' ' || s[j] === '\t') j++;
  return s.slice(lineStart, j);
};
const isBlank = (text: string) => /^[ \t\r]*$/.test(text);
const newlineOf = (s: string) => (s.includes('\r\n') ? '\r\n' : '\n');

/**
 * The lines `[from, to)` runs over when nothing else shares them: from its line's start to just past
 * the `\n` that ends its last line. `null` when other markup sits on the same line.
 */
function ownLines(s: string, from: number, to: number): { from: number; to: number } | null {
  const ls = lineStartOf(s, from);
  if (!isBlank(s.slice(ls, from))) return null;
  const le = lineEndOf(s, to);
  if (!isBlank(s.slice(to, le))) return null;
  return { from: ls, to: le < s.length ? le + 1 : le };
}

/** One level of the file's indentation: a tab when it indents with tabs, else its smallest step. */
export function indentUnit(s: string): string {
  let smallest = Infinity;
  for (const line of s.split('\n')) {
    const lead = /^[ \t]*/.exec(line)![0];
    if (!lead || isBlank(line)) continue;
    if (lead.includes('\t')) return '\t';
    smallest = Math.min(smallest, lead.length);
  }
  return smallest === Infinity || smallest > 8 ? '  ' : ' '.repeat(smallest);
}

/** Builds the new content and its pieces at once. */
class Builder {
  readonly pieces: Piece[] = [];
  private readonly parts: string[] = [];
  length = 0;

  constructor(private readonly s: string) {}

  keep(from: number, to: number): void {
    if (to <= from) return;
    const last = this.pieces[this.pieces.length - 1];
    if (Array.isArray(last) && last[1] === from) last[1] = to;
    else this.pieces.push([from, to]);
    this.parts.push(this.s.slice(from, to));
    this.length += to - from;
  }

  put(text: string): void {
    if (!text) return;
    this.pieces.push(text.length);
    this.parts.push(text);
    this.length += text.length;
  }

  /**
   * Keep `[from, to)` line by line with `add` put before each line's indentation, or `remove` taken
   * off it where the line has it. Blank lines are kept as they are.
   */
  keepIndented(from: number, to: number, add: string, remove: string): void {
    let i = from;
    while (i < to) {
      const end = Math.min(lineEndOf(this.s, i) + 1, to);
      const blank = isBlank(this.s.slice(i, end).replace(/\n$/, ''));
      if (blank) { this.keep(i, end); i = end; continue; }
      this.put(add);
      this.keep(remove && this.s.startsWith(remove, i) ? i + remove.length : i, end);
      i = end;
    }
  }

  done(): string {
    return this.parts.join('');
  }
}

/** Where an old offset lands in the new content: the first kept range holding it, or `null`. */
export function mapOffset(pieces: readonly Piece[], old: number): number | null {
  let at = 0;
  for (const piece of pieces) {
    if (typeof piece === 'number') { at += piece; continue; }
    if (old >= piece[0] && old < piece[1]) return at + old - piece[0];
    at += piece[1] - piece[0];
  }
  return null;
}

/** The re-indentation that turns lines indented `from` into lines indented `to`, where one is a prefix. */
function reindent(from: string, to: string): { add: string; remove: string } {
  if (to.startsWith(from)) return { add: to.slice(from.length), remove: '' };
  if (from.startsWith(to)) return { add: '', remove: from.slice(to.length) };
  return { add: '', remove: '' };
}

/** Starts of the elements in `markup` the compile tags, offset by `at`. */
function createdIn(markup: string, at: number): number[] {
  return scanElements(markup).filter(node => carriesProvenance(node.tag)).map(node => at + node.start);
}

// ---------- the operations ----------

interface Located {
  nodes: SourceNode[];
  index: number;
  node: SourceNode;
}

function locate(content: string, start: number): Located | StructureRefusal {
  const nodes = scanElements(content);
  const index = nodeAt(nodes, start);
  if (index === -1) return 'stale-index';
  const node = nodes[index];
  if (node.implied) return 'unclosed';
  return { nodes, index, node };
}

/** The range is balanced: it starts and ends in the same template block. */
const balanced = (content: string, node: SourceNode) =>
  templateScope(content, node.start) === templateScope(content, node.end);

/** Where an insertion goes, relative to elements of the same file. */
export type Place =
  | { before: number }
  | { after: number }
  /** First or last inside the element starting at `parent`. */
  | { parent: number; at: 'start' | 'end' };

/**
 * The insertion point and the indentation a new own-line element there takes, or `null` for an
 * inline insertion. Refuses places that are not inside an open element.
 */
function placeOf(
  content: string,
  nodes: SourceNode[],
  place: Place,
): { at: number; parent: number; line: { at: number; indent: string } | null } | StructureRefusal {
  if ('before' in place || 'after' in place) {
    const index = nodeAt(nodes, 'before' in place ? place.before : place.after);
    if (index === -1) return 'stale-index';
    const ref = nodes[index];
    if (ref.implied) return 'unclosed';
    const own = ownLines(content, ref.start, ref.end);
    const indent = own ? indentOf(content, own.from) : '';
    if ('before' in place) return { at: ref.start, parent: ref.parent, line: own ? { at: own.from, indent } : null };
    return { at: ref.end, parent: ref.parent, line: own ? { at: own.to, indent } : null };
  }
  const index = nodeAt(nodes, place.parent);
  if (index === -1) return 'stale-index';
  const parent = nodes[index];
  if (parent.implied) return 'unclosed';
  if (parent.closeStart === parent.openEnd && parent.end === parent.openEnd) return 'no-place';
  const unit = indentUnit(content);
  const children = nodes.filter(node => node.parent === index);
  if (place.at === 'start') {
    const first = children[0];
    const openLine = lineEndOf(content, parent.openEnd);
    // The open tag ends its line: the new element gets a line of its own after it.
    if (isBlank(content.slice(parent.openEnd, openLine)) && openLine < content.length) {
      const indent = first && ownLines(content, first.start, first.end)
        ? indentOf(content, lineStartOf(content, first.start))
        : indentOf(content, lineStartOf(content, parent.start)) + unit;
      return { at: parent.openEnd, parent: index, line: { at: openLine + 1, indent } };
    }
    return { at: parent.openEnd, parent: index, line: null };
  }
  const closeLine = lineStartOf(content, parent.closeStart);
  if (isBlank(content.slice(closeLine, parent.closeStart)) && closeLine > parent.openEnd) {
    const last = children[children.length - 1];
    const indent = last && ownLines(content, last.start, last.end)
      ? indentOf(content, lineStartOf(content, last.start))
      : indentOf(content, closeLine) + unit;
    return { at: parent.closeStart, parent: index, line: { at: closeLine, indent } };
  }
  return { at: parent.closeStart, parent: index, line: null };
}

/** Move the element starting at `start` to `place`, in the same file. */
export function moveElement(content: string, start: number, place: Place): StructureResult {
  const found = locate(content, start);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { nodes, index, node } = found;
  const target = placeOf(content, nodes, place);
  if (typeof target === 'string') return { ok: false, reason: target };
  if (target.at > node.start && target.at < node.end) return { ok: false, reason: 'into-itself' };
  if ('parent' in place && place.parent === start) return { ok: false, reason: 'into-itself' };
  if (isLocked(content, nodes, index)) return { ok: false, reason: 'locked' };
  if (target.parent !== -1 && isLocked(content, nodes, target.parent)) return { ok: false, reason: 'locked' };
  const scope = templateScope(content, node.start);
  if (!balanced(content, node) || templateScope(content, target.at) !== scope) {
    return { ok: false, reason: 'crosses-template' };
  }

  const nl = newlineOf(content);
  const own = ownLines(content, node.start, node.end);
  const cut = own ?? { from: node.start, to: node.end };
  const b = new Builder(content);
  let selectAt = 0;
  const putMoved = () => {
    if (own && target.line) {
      const { add, remove } = reindent(indentOf(content, own.from), target.line.indent);
      selectAt = b.length + add.length + (node.start - own.from) - (content.startsWith(remove, own.from) ? remove.length : 0);
      b.keepIndented(own.from, own.to, add, remove);
      if (!content.slice(own.from, own.to).endsWith('\n')) b.put(nl);
    } else if (target.line) {
      b.put(target.line.indent);
      selectAt = b.length;
      b.keep(node.start, node.end);
      b.put(nl);
    } else {
      selectAt = b.length;
      b.keep(node.start, node.end);
    }
  };
  const at = target.line ? target.line.at : target.at;
  if (at <= cut.from) {
    b.keep(0, at);
    putMoved();
    b.keep(at, cut.from);
    b.keep(cut.to, content.length);
  } else if (at >= cut.to) {
    b.keep(0, cut.from);
    b.keep(cut.to, at);
    putMoved();
    b.keep(at, content.length);
  } else {
    // Inside the lines the element leaves: it stays where it is.
    return { ok: true, edit: { content, pieces: [[0, content.length]], select: node.start, created: [] } };
  }
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select: selectAt, created: [] } };
}

/** Wrap the element starting at `start` in `open` + `close` (a frame), on lines of their own when it has its own. */
export function wrapElement(content: string, start: number, open: string, close: string): StructureResult {
  const found = locate(content, start);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { nodes, index, node } = found;
  if (isLocked(content, nodes, index)) return { ok: false, reason: 'locked' };
  if (!balanced(content, node)) return { ok: false, reason: 'crosses-template' };
  const nl = newlineOf(content);
  const own = ownLines(content, node.start, node.end);
  const b = new Builder(content);
  let wrapperAt: number;
  if (own) {
    const indent = indentOf(content, own.from);
    const unit = indentUnit(content);
    b.keep(0, own.from);
    b.put(indent);
    wrapperAt = b.length;
    b.put(open + nl);
    b.keepIndented(own.from, own.to, unit, '');
    if (!content.slice(own.from, own.to).endsWith('\n')) b.put(nl);
    b.put(indent + close + (own.to < content.length || content.endsWith('\n') ? nl : ''));
    b.keep(own.to, content.length);
  } else {
    b.keep(0, node.start);
    wrapperAt = b.length;
    b.put(open);
    b.keep(node.start, node.end);
    b.put(close);
    b.keep(node.end, content.length);
  }
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select: wrapperAt, created: [wrapperAt] } };
}

/** Take a frame apart: its children stay where it was, one level out. */
export function unwrapElement(content: string, start: number): StructureResult {
  const found = locate(content, start);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { nodes, index, node } = found;
  if (!isFrameAt(content, start)) return { ok: false, reason: 'not-a-frame' };
  if (isLocked(content, nodes, index)) return { ok: false, reason: 'locked' };
  if (!balanced(content, node)) return { ok: false, reason: 'crosses-template' };
  const b = new Builder(content);
  const openLine = ownLines(content, node.start, node.openEnd);
  const closeLine = ownLines(content, node.closeStart, node.end);
  if (openLine && closeLine && openLine.to <= closeLine.from) {
    b.keep(0, openLine.from);
    b.keepIndented(openLine.to, closeLine.from, '', indentUnit(content));
    b.keep(closeLine.to, content.length);
  } else {
    b.keep(0, node.start);
    b.keep(node.openEnd, node.closeStart);
    b.keep(node.end, content.length);
  }
  const first = nodes.find(other => other.parent === index && carriesProvenance(other.tag));
  const select = first ? mapOffset(b.pieces, first.start) : null;
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select, created: [] } };
}

/**
 * Put a copy of the element starting at `start` right after it, on a line of its own when it has
 * one. `transform` rewrites the copied markup (fresh markers), and must leave its length alone
 * only where the caller relies on that; `created` is read from the result either way.
 */
export function duplicateElement(
  content: string,
  start: number,
  transform: (markup: string) => string = markup => markup,
): StructureResult {
  const found = locate(content, start);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { nodes, index, node } = found;
  if (isLocked(content, nodes, index)) return { ok: false, reason: 'locked' };
  if (!balanced(content, node)) return { ok: false, reason: 'crosses-template' };
  const nl = newlineOf(content);
  const own = ownLines(content, node.start, node.end);
  const copy = transform(content.slice(node.start, node.end));
  const b = new Builder(content);
  let copyAt: number;
  if (own) {
    const indent = indentOf(content, own.from);
    b.keep(0, own.to);
    if (!content.slice(own.from, own.to).endsWith('\n')) b.put(nl);
    b.put(indent);
    copyAt = b.length;
    b.put(copy + (own.to < content.length || content.slice(own.from, own.to).endsWith('\n') ? nl : ''));
    b.keep(own.to, content.length);
  } else {
    b.keep(0, node.end);
    copyAt = b.length;
    b.put(copy);
    b.keep(node.end, content.length);
  }
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select: copyAt, created: createdIn(copy, copyAt) } };
}

/** Delete the element starting at `start`, and its line when it has one to itself. */
export function removeElement(content: string, start: number): StructureResult {
  const found = locate(content, start);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { nodes, index, node } = found;
  if (isLocked(content, nodes, index)) return { ok: false, reason: 'locked' };
  if (!balanced(content, node)) return { ok: false, reason: 'crosses-template' };
  const cut = ownLines(content, node.start, node.end) ?? { from: node.start, to: node.end };
  const b = new Builder(content);
  b.keep(0, cut.from);
  b.keep(cut.to, content.length);
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select: null, created: [] } };
}

/** Insert `markup` (one element) at `place`, on a line of its own where its neighbours have theirs. */
export function insertElement(content: string, place: Place, markup: string): StructureResult {
  const nodes = scanElements(content);
  const target = placeOf(content, nodes, place);
  if (typeof target === 'string') return { ok: false, reason: target };
  if (target.parent !== -1 && isLocked(content, nodes, target.parent)) return { ok: false, reason: 'locked' };
  const inside = target.parent === -1 ? '' : templateScope(content, nodes[target.parent].openEnd);
  if (templateScope(content, target.at) !== inside) return { ok: false, reason: 'crosses-template' };
  const nl = newlineOf(content);
  const b = new Builder(content);
  let at: number;
  if (target.line) {
    b.keep(0, target.line.at);
    if (target.line.at === content.length && !content.endsWith('\n') && content.length) b.put(nl);
    b.put(target.line.indent);
    at = b.length;
    b.put(markup + nl);
    b.keep(target.line.at, content.length);
  } else {
    b.keep(0, target.at);
    at = b.length;
    b.put(markup);
    b.keep(target.at, content.length);
  }
  return { ok: true, edit: { content: b.done(), pieces: b.pieces, select: at, created: createdIn(markup, at) } };
}

/**
 * The elements around the one starting at `start` that a move could go past: the previous and next
 * elements of the same parent that the compile tags, as their starts.
 */
export function siblingsOf(content: string, start: number): { previous: number | null; next: number | null } {
  const nodes = scanElements(content);
  const index = nodeAt(nodes, start);
  if (index === -1) return { previous: null, next: null };
  const parent = nodes[index].parent;
  const kin = nodes.filter(node => node.parent === parent && carriesProvenance(node.tag));
  const k = kin.findIndex(node => node.start === start);
  return { previous: kin[k - 1]?.start ?? null, next: kin[k + 1]?.start ?? null };
}
