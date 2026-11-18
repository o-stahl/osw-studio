/**
 * What an agent's write did to the things a user put on a page by hand.
 *
 * A marker (`data-osw-id`) is all that ties an element to its rules in `/overrides.css`, and a model
 * rewriting a page from memory leaves it out without knowing it mattered. Nothing told the agent, so
 * the styles went silently. The guard reads the project's markup before a writing command and again
 * after it, puts back what it can, and words the rest as a note on the command's own reply, which is
 * the one place every agent reads: the in-app one, a server run, and a client over MCP that never
 * sees the system prompt.
 *
 * It watches three things: markers that have rules, placeholders of blocks the user placed
 * (`data-osw-block`), and locked elements (`data-osw-lock`). A project with none of them costs one
 * read of its pages and nothing more.
 */

import type { VirtualFileSystem } from '@/lib/vfs';
import { logger } from '@/lib/utils';
import { asText } from '@/lib/vfs/as-text';
import { readOpenTagAt } from '@/lib/preview/provenance';
import { BLOCK_ATTR } from '@/lib/semantic-blocks/placeholder';
import { findAttributeIn, hasAttributeIn } from './attributes';
import { OVERRIDES_PATH } from './apply-style';
import { MARKER_ATTR, newMarkerId, stampMarker } from './marker';
import { applyChanges, declaredByScope, importantProperties, markerIdsIn, strengthenDeclarations } from './overrides-css';
import { sourceRef } from './resolution';
import { LOCK_ATTR, scanElements, type SourceNode } from './structure';
import { isMarkupFile } from './targets';

/** Path to content, for every page and partial. */
type Markup = Map<string, string>;

const TRACKED = /data-osw-(?:id|block|lock)/;

/** Elements a page has one of by nature, so "the page's `<h1>`" names the same element after a rewrite. */
const SINGULAR_TAGS = new Set(['h1', 'nav', 'header', 'footer', 'main']);

/** Lines of detail before the rest are counted. */
const MAX_LINES = 6;

interface Found {
  file: string;
  node: SourceNode;
}

interface Marked extends Found {
  id: string;
}

interface Placeholder extends Found {
  id: string;
  name: string;
}

interface Locked extends Found {
  /** The tags inside it with their depth: what "restructured" is measured against. */
  shape: string;
}

interface Census {
  markers: Map<string, Marked[]>;
  placeholders: Map<string, Placeholder>;
  locks: Locked[];
}

async function readMarkup(fs: VirtualFileSystem, projectId: string): Promise<Markup> {
  const out: Markup = new Map();
  for (const path of await fs.listFilePaths(projectId)) {
    if (!isMarkupFile(path)) continue;
    try {
      out.set(path, asText((await fs.readFile(projectId, path)).content));
    } catch {
      // Unreadable now: it cannot be compared, so it is left out of both readings.
    }
  }
  return out;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** What an element says, tags and mustaches taken out, cut to a length that still tells two apart. */
function textOf(content: string, node: SourceNode): string {
  // Only the start is kept, so only the start is read: a wrapper holds the whole page.
  const inner = content.slice(node.openEnd, Math.min(node.closeStart, node.openEnd + 2000));
  return collapse(inner.replace(/<[^>]*>?/g, ' ').replace(/\{\{[^}]*(?:\}\})?/g, ' ')).slice(0, 160);
}

function attribute(content: string, node: SourceNode, name: string): string | null {
  const tag = readOpenTagAt(content, node.start);
  return tag ? findAttributeIn(content, tag, name)?.value ?? null : null;
}

/** The tags under `nodes[index]`, each with its depth below it. */
function shapeOf(nodes: SourceNode[], index: number): string {
  const root = nodes[index];
  const depth = new Map<number, number>([[index, 0]]);
  const parts: string[] = [];
  for (let k = index + 1; k < nodes.length && nodes[k].start < root.end; k++) {
    const d = (depth.get(nodes[k].parent) ?? 0) + 1;
    depth.set(k, d);
    parts.push(`${d}${nodes[k].tag}`);
  }
  return parts.join(' ');
}

function census(files: Markup): Census {
  const out: Census = { markers: new Map(), placeholders: new Map(), locks: [] };
  for (const [file, content] of files) {
    if (!TRACKED.test(content)) continue;
    const nodes = scanElements(content);
    nodes.forEach((node, index) => {
      const tag = readOpenTagAt(content, node.start);
      if (!tag) return;
      const id = findAttributeIn(content, tag, MARKER_ATTR)?.value;
      if (id) out.markers.set(id, [...(out.markers.get(id) ?? []), { id, file, node }]);
      const block = findAttributeIn(content, tag, BLOCK_ATTR)?.value;
      if (block) out.placeholders.set(block, { id: block, file, node, name: textOf(content, node) });
      if (hasAttributeIn(content, tag, LOCK_ATTR)) out.locks.push({ file, node, shape: shapeOf(nodes, index) });
    });
  }
  return out;
}

/** The element's classes, sorted, joined by dots. */
const classesOf = (content: string, node: SourceNode) =>
  collapse(attribute(content, node, 'class') ?? '').split(' ').filter(Boolean).sort().join('.');

/** The key of an element's tag and classes alone. */
const classKey = (tag: string, classes: string) => `c${tag}.${classes}`;

/**
 * The ways an element can be recognised again, most specific first. A key is only trusted when
 * exactly one element had it before the write and exactly one unmarked element has it after.
 */
function keysOf(content: string, node: SourceNode): string[] {
  const id = attribute(content, node, 'id');
  const classes = classesOf(content, node);
  const text = textOf(content, node);
  const keys: string[] = [];
  if (id) keys.push(`#${node.tag}#${id}`);
  if (classes && text) keys.push(`ct${node.tag}.${classes}|${text}`);
  if (classes) keys.push(classKey(node.tag, classes));
  if (text) keys.push(`t${node.tag}|${text}`);
  if (SINGULAR_TAGS.has(node.tag)) keys.push(`s${node.tag}`);
  return keys;
}

/** Two texts that both say something and have no word in common. */
function unrelatedTexts(a: string, b: string): boolean {
  if (!a || !b) return false;
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set(words(a));
  return !words(b).some(word => seen.has(word));
}

/** Where an element stands: its parent by tag, id and classes, and the tags above that. Empty at the top of the file. */
function placeOf(content: string, nodes: SourceNode[], node: SourceNode): string {
  if (node.parent === -1) return '';
  const parent = nodes[node.parent];
  const above: string[] = [];
  for (let p = parent.parent; p !== -1; p = nodes[p].parent) above.unshift(nodes[p].tag);
  return `${above.join(' ')} ${parent.tag}#${attribute(content, parent, 'id') ?? ''}.${classesOf(content, parent)}`;
}

interface Indexed {
  nodes: SourceNode[];
  keys: string[][];
  marked: boolean[];
}

/** One file's elements with their keys, read once however many markers are looked for in it. */
function indexOf(cache: Map<string, Indexed>, content: string): Indexed {
  let indexed = cache.get(content);
  if (!indexed) {
    const nodes = scanElements(content);
    indexed = {
      nodes,
      keys: nodes.map(node => keysOf(content, node)),
      marked: nodes.map(node => attribute(content, node, MARKER_ATTR) !== null),
    };
    cache.set(content, indexed);
  }
  return indexed;
}

/** The unmarked element of `after` that is the one `origin` was in `before`, or null when that is not certain. */
function recognise(cache: Map<string, Indexed>, before: string, origin: SourceNode, after: string): SourceNode | null {
  const then = indexOf(cache, before);
  const now = indexOf(cache, after);
  const own = then.keys[then.nodes.findIndex(node => node.start === origin.start)] ?? [];
  const classes = classesOf(before, origin);
  const loose = classes ? classKey(origin.tag, classes) : null;
  for (const key of own) {
    if (then.keys.filter(keys => keys.includes(key)).length !== 1) continue;
    const matches = now.nodes.filter((_node, i) => !now.marked[i] && now.keys[i].includes(key));
    if (matches.length !== 1) continue;
    const match = matches[0];
    // A tag and classes are all an unrelated element needs to share: one that says something else
    // entirely is taken for this one only where it stands under the same parent.
    if (key === loose && unrelatedTexts(textOf(before, origin), textOf(after, match))
      && placeOf(before, then.nodes, origin) !== placeOf(after, now.nodes, match)) continue;
    return match;
  }
  return null;
}

/** `<h1> at /index.html:16:5`. */
const at = (file: string, content: string, node: SourceNode) => `<${node.tag}> at ${sourceRef(file, content, node.start)}`;
const was = (file: string, content: string, node: SourceNode) => `<${node.tag}> (it was at ${sourceRef(file, content, node.start)})`;

function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `- …and ${lines.length - MAX_LINES} more of the same kind.`];
}

export interface WriteGuardOptions {
  /** Placeholders the agent was asked to build: their going is the request done, not a loss. */
  expectedPlaceholders?: ReadonlySet<string>;
}

export interface WriteGuard {
  /** Run after the command. The note to put under its reply, or '' when there is nothing to say. */
  finish(): Promise<string>;
}

async function compare(fs: VirtualFileSystem, projectId: string, before: Markup, opts: WriteGuardOptions): Promise<string> {
  const after = await readMarkup(fs, projectId);
  let touched = after.size !== before.size;
  for (const [path, content] of before) if (after.get(path) !== content) touched = true;
  if (!touched) return '';

  const then = census(before);
  const now = census(after);
  let css = '';
  try {
    css = (await fs.fileExists(projectId, OVERRIDES_PATH)) ? asText((await fs.readFile(projectId, OVERRIDES_PATH)).content) : '';
  } catch {
    css = '';
  }
  const styled = new Set(markerIdsIn(css));
  const lines: string[] = [];
  /** Edits to make, by file: an attribute to stamp, or a marker value to replace. */
  const stamps = new Map<string, { start: number; id: string }[]>();
  const renames = new Map<string, { node: SourceNode; fresh: string }[]>();
  const cache = new Map<string, Indexed>();
  let nextCss = css;

  // A marker with rules that is on no element any more.
  for (const [id, marked] of then.markers) {
    if (!styled.has(id) || now.markers.has(id)) continue;
    const origin = marked[0];
    const beforeText = before.get(origin.file)!;
    const afterText = after.get(origin.file);
    // A page that was deleted took its elements with it on purpose.
    if (afterText === undefined) continue;
    const candidate = recognise(cache, beforeText, origin.node, afterText);
    // One element takes one marker: a second claim on it is not a recognition.
    const taken = (stamps.get(origin.file) ?? []).some(s => s.start === candidate?.start);
    const found = taken ? null : candidate;
    if (found) {
      stamps.set(origin.file, [...(stamps.get(origin.file) ?? []), { start: found.start, id }]);
      lines.push(`- ${at(origin.file, afterText, found)}: the user styled this element by hand, and the styles hang on its ${MARKER_ATTR}="${id}" attribute, which this command left out. It was put back. Keep that attribute on the element when you edit it.`);
    } else {
      lines.push(`- ${was(origin.file, beforeText, origin.node)}: the user styled this element by hand, and it is gone with its ${MARKER_ATTR}="${id}" attribute, so those styles apply to nothing now. If an element you wrote takes its place, add ${MARKER_ATTR}="${id}" to that element's open tag.`);
    }
  }

  // One marker on more elements than before: the extra ones are copies, and get their own.
  const copies = new Map<string, number>();
  for (const [id, marked] of now.markers) {
    const had = then.markers.get(id);
    if (!had || marked.length <= had.length) continue;
    const home = had[0].file;
    const kept = marked.find(m => m.file === home) ?? marked[0];
    let declared: ReturnType<typeof declaredByScope> | null = null;
    try {
      declared = styled.has(id) ? declaredByScope(nextCss, id) : null;
    } catch {
      declared = null;
    }
    for (const copy of marked) {
      if (copy === kept) continue;
      const fresh = newMarkerId();
      try {
        if (declared) {
          for (const [scope, bag] of declared) {
            nextCss = applyChanges(nextCss, fresh, scope, Object.entries(bag).map(([property, value]) => ({ property, value })));
          }
          // What the original needed `!important` to show, the copy needs too.
          nextCss = strengthenDeclarations(nextCss, fresh, importantProperties(nextCss, id));
        }
      } catch {
        // A stylesheet the writer will not edit: the copy still gets its own marker, without the rules.
      }
      renames.set(copy.file, [...(renames.get(copy.file) ?? []), { node: copy.node, fresh }]);
      copies.set(copy.file, (copies.get(copy.file) ?? 0) + 1);
    }
  }
  for (const [file, count] of copies) {
    lines.push(count === 1
      ? `- ${file}: an element was copied together with its ${MARKER_ATTR}, which belongs to one element only. The copy now has a ${MARKER_ATTR} of its own, with the same styles.`
      : `- ${file}: ${count} elements were copied together with their ${MARKER_ATTR} attributes, each of which belongs to one element only. The copies now have their own, with the same styles.`);
  }

  // A placeholder nobody asked to have built.
  for (const [id, placeholder] of then.placeholders) {
    if (now.placeholders.has(id) || opts.expectedPlaceholders?.has(id) || !after.has(placeholder.file)) continue;
    lines.push(`- The placeholder "${placeholder.name}" (${BLOCK_ATTR}="${id}", it was at ${sourceRef(placeholder.file, before.get(placeholder.file)!, placeholder.node.start)}) is gone. The user put it there for a block they want built at that spot. That is right if you built the block; if not, put the placeholder back.`);
  }

  // A locked element that is gone, or whose inside was rebuilt. Matched within its own file, so an
  // identical one on another page neither covers for it nor takes the blame for it.
  const lockKey = (lock: Locked) => `${lock.file} ${lock.node.tag} ${lock.shape}`;
  const left = now.locks.map(lockKey);
  for (const lock of then.locks) {
    if (!after.has(lock.file)) continue;
    const index = left.indexOf(lockKey(lock));
    if (index !== -1) {
      left.splice(index, 1);
      continue;
    }
    lines.push(`- ${was(lock.file, before.get(lock.file)!, lock.node)} is locked by the user (${LOCK_ATTR}), and this command removed it, unlocked it or changed what is inside it. Put it back as it was, unless the request asked for that change.`);
  }

  if (lines.length === 0) return '';

  if (nextCss !== css) await fs.updateFile(projectId, OVERRIDES_PATH, nextCss, { silent: true });
  for (const file of new Set([...stamps.keys(), ...renames.keys()])) {
    let content = after.get(file)!;
    const edits = [
      ...(stamps.get(file) ?? []).map(s => ({ start: s.start, apply: (text: string) => stampMarker(text, s.start, s.id).content })),
      ...(renames.get(file) ?? []).map(r => ({
        start: r.node.start,
        apply: (text: string) => {
          const tag = readOpenTagAt(text, r.node.start);
          const span = tag ? findAttributeIn(text, tag, MARKER_ATTR) : null;
          return span ? text.slice(0, span.valueStart) + r.fresh + text.slice(span.valueEnd) : text;
        },
      })),
    ];
    // Last first, so an earlier position still points at its tag after a later one grew.
    for (const edit of edits.sort((a, b) => b.start - a.start)) content = edit.apply(content);
    if (content !== after.get(file)) await fs.updateFile(projectId, file, content);
  }

  return ['Note: this command changed things the user set by hand on the page.', ...capped(lines)].join('\n');
}

/**
 * Reads the project before a writing command. Null when it holds nothing a write could harm, so the
 * caller has nothing to finish.
 */
export async function beginWriteGuard(fs: VirtualFileSystem, projectId: string, opts: WriteGuardOptions = {}): Promise<WriteGuard | null> {
  let before: Markup;
  try {
    before = await readMarkup(fs, projectId);
  } catch {
    return null;
  }
  let tracked = false;
  for (const content of before.values()) if (TRACKED.test(content)) { tracked = true; break; }
  if (!tracked) return null;
  return {
    async finish() {
      try {
        return await compare(fs, projectId, before, opts);
      } catch (error) {
        // A guard that fails must not take the command's own reply with it.
        logger.warn('[WriteGuard] Could not check or restore what the command changed', error);
        return '';
      }
    },
  };
}
