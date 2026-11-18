import type { StyleChange, StyleDeclaration } from './types';
import { MARKER_ATTR } from './marker';
import { closesWhatItOpens } from './css-variables';

/**
 * `/overrides.css` — the stylesheet direct editing accumulates into.
 *
 * Line-oriented parser; indexOf plus brace counting corrupts comments, strings, nested blocks
 * and media queries.
 *
 * A marker's rules live at the top level (every width) and in managed width blocks, one
 * `@media (max-width: Npx)` block per width, after every top-level marker block and widest first,
 * so a narrower width's rule wins where both apply. A marker rule anywhere else is refused.
 */

/** Where the override stylesheet lives. Root and undotted, so no export filter drops it. */
export const OVERRIDES_PATH = '/overrides.css';

/** Where an override applies: at every width, or inside the managed block for widths up to N px. */
export type OverrideScope = 'all' | number;

/** The prelude of the managed block for one width, as it is written. */
export function scopePrelude(width: number): string {
  return `@media (max-width: ${width}px)`;
}

/**
 * Header written into an empty file. It is where an agent that opens the file learns what the file
 * is: nothing in the system prompt says, so the rules that matter (keep the attribute, change a
 * block with `style`) are stated here, in the place they apply.
 *
 * Deliberately free of any `[data-osw-id="…"]` text: the scan throws on the marker selector
 * appearing inside a comment, and a header that spelled one out would poison every later upsert.
 */
export const OVERRIDES_HEADER = `/* OSW Studio style overrides.
 *
 * Each block below styles one element: the one whose data-osw-id attribute has the block's id.
 * The attribute is stamped on the element in source. Keep it there when the element's HTML is
 * edited, and leave it off a copy of the element: without it the block styles nothing.
 *
 * The app's Inspector and Canvas write these blocks, and so does the shell command for one
 * element: style @<id> property=value (style --help). Use that rather than editing a block by
 * hand. Anything written outside the blocks is preserved byte for byte.
 *
 * The selector is doubled so it has the specificity of two classes, which lets it beat an
 * ordinary compound selector on source order alone. A declaration marked !important was losing
 * to a stronger rule of the project, or to the element's own style attribute, when it was set:
 * the mark is what makes it apply, so leave it in place.
 *
 * Blocks inside @media (max-width: ...) apply up to that width. They come after the blocks for
 * every width, widest first, so the narrowest one that applies wins.
 *
 * A block whose id is on no element in the project has no effect and is safe to delete.
 */`;

/**
 * Headers earlier versions wrote (v1.96.0 to v1.110.0 had the one). A file that still opens with
 * one, unedited, takes the current header on its next write; a header someone changed is theirs.
 */
const EARLIER_HEADERS = [
  `/* OSW Studio style overrides.
 *
 * Each block below is keyed to one element by the data-osw-id attribute stamped on it in source.
 * Direct edits in the preview rewrite these blocks; anything you write outside them is preserved
 * byte for byte. The selector is doubled so it has the specificity of two classes, which lets it
 * beat an ordinary compound selector on source order alone, without forcing priority.
 *
 * A block whose marker no longer exists anywhere in the project has no effect and is safe to
 * delete.
 */`,
];

/** `css` with an earlier version's untouched header replaced by the current one. */
export function withCurrentHeader(css: string): string {
  for (const earlier of EARLIER_HEADERS) {
    if (css.startsWith(earlier)) return OVERRIDES_HEADER + css.slice(earlier.length);
  }
  return css;
}

/** CSS property names, including custom properties and vendor prefixes. */
const PROPERTY_RE = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;

/** Marker ids safe inside both an HTML attribute and a CSS attribute selector. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Exported as a pattern (not a function) because the frame script needs the same selector as a string. */
export const MARKER_SELECTOR_TEMPLATE = `[${MARKER_ATTR}="{id}"][${MARKER_ATTR}]`;

/** The canonical selector for one marker. Doubled — see OVERRIDES_HEADER. */
function selectorFor(markerId: string): string {
  // A replacement *function*, so a `$&` or `$'` in the id cannot be read as a replacement pattern.
  return MARKER_SELECTOR_TEMPLATE.replace('{id}', () => markerId);
}

/** The substring that identifies a mention of this marker anywhere in the file. */
function needleFor(markerId: string): string {
  return `[${MARKER_ATTR}="${markerId}"]`;
}

/**
 * Reject anything that could terminate the declaration and continue as CSS of its own.
 *
 * The property is validated as strictly as the value. An injected property name escapes the block
 * exactly as well as an injected value does — `color; } body { color` is a complete escape and
 * looks harmless next to a plain `red`.
 *
 * A consequence worth knowing: a legitimate value containing `}` (`content: "}"`) is refused. That
 * is a deliberate trade — direct editing sets lengths, colours and spacing, and no shelf control
 * produces such a value, so the check costs nothing real and removes a whole class of escape.
 */
function assertSafeDeclaration(decl: StyleDeclaration): void {
  if (!PROPERTY_RE.test(decl.property)) {
    throw new Error(`Refusing unsafe CSS property ${JSON.stringify(decl.property)}`);
  }
  const value = decl.value.trim();
  if (value === '') {
    throw new Error('Refusing an empty CSS value');
  }
  if (/[;{}]/.test(value) || value.includes('/*') || value.includes('*/') || !closesWhatItOpens(value)) {
    throw new Error(`Refusing unsafe CSS value ${JSON.stringify(decl.value)}`);
  }
}

function assertSafeProperty(property: string): void {
  if (!PROPERTY_RE.test(property)) {
    throw new Error(`Refusing unsafe CSS property ${JSON.stringify(property)}`);
  }
}

function assertSafeMarkerId(markerId: string): void {
  if (!SAFE_ID.test(markerId)) {
    throw new Error(`Refusing unsafe marker id ${JSON.stringify(markerId)}`);
  }
}

interface TopLevelBlock {
  /** Selector text as written, before normalisation. For an at-rule, its prelude. */
  selector: string;
  /** Index of the first non-whitespace character of the selector — never the preceding newline. */
  start: number;
  braceOpen: number;
  /** Index just past the closing `}`. */
  end: number;
}

/**
 * Locate every `{ … }` block at one level of `css[from, to)`, and refuse outright if this marker is
 * mentioned somewhere we must not edit.
 *
 * Throws when the marker's selector appears inside a comment (the next `{` would belong to someone
 * else's rule) or inside a block (an `@media`, `@supports` or nested rule — editing there would
 * silently scope the override to that context), except directly inside a block whose prelude
 * `nestedOk` accepts: the managed width blocks, whose rules are read one level down.
 */
function scanLevel(
  css: string,
  from: number,
  to: number,
  needle: string,
  nestedOk: (prelude: string) => boolean,
): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  let i = from;
  let depth = 0;
  let segStart = from;
  let braceOpen = -1;
  let prelude = '';

  while (i < to) {
    if (css.startsWith('/*', i)) {
      const e = css.indexOf('*/', i + 2);
      const end = e === -1 || e + 2 > to ? to : e + 2;
      if (css.slice(i, end).includes(needle)) {
        throw new Error(
          `Refusing to edit /overrides.css: ${needle} appears inside a comment, so the block it ` +
          `belongs to cannot be identified. Remove the mention or the block by hand.`,
        );
      }
      // A comment sitting between the previous block and this one belongs to neither. Leaving it
      // inside the segment would make it part of the next block's "selector" — so the file header
      // would be prepended to the first rule's selector, which then matches nothing and causes a
      // duplicate block on every write — and would put it inside the range upsert replaces.
      if (depth === 0 && css.slice(segStart, i).trim() === '') segStart = end;
      i = end;
      continue;
    }

    const c = css[i];

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < to) {
        if (css[j] === '\\') { j += 2; continue; }
        if (css[j] === c) { j++; break; }
        if (css[j] === '\n') break;   // unterminated string; CSS ends it at the newline
        j++;
      }
      i = j;
      continue;
    }

    if (css.startsWith(needle, i)) {
      if (depth > 1 || (depth === 1 && !nestedOk(prelude))) {
        throw new Error(
          `Refusing to edit /overrides.css: ${needle} is nested inside an at-rule or another ` +
          `block, where an edit would apply only in that context. Move it to the top level.`,
        );
      }
      // At this level: part of a selector. One level down in a managed block: the selector of one
      // of its rules. Fall through and keep scanning.
    }

    if (c === '{') {
      if (depth === 0) {
        braceOpen = i;
        prelude = css.slice(segStart, i);
      }
      depth++;
      i++;
      continue;
    }

    if (c === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && braceOpen !== -1) {
        const raw = css.slice(segStart, braceOpen);
        const lead = raw.length - raw.replace(/^\s+/, '').length;
        blocks.push({ selector: raw, start: segStart + lead, braceOpen, end: i + 1 });
        braceOpen = -1;
        segStart = i + 1;
      }
      i++;
      continue;
    }

    // A top-level statement that is not a block — `@import url(x);`, `@charset "utf-8";`. The next
    // selector starts after it, not at the top of the file.
    if (c === ';' && depth === 0) { segStart = i + 1; i++; continue; }

    i++;
  }

  return blocks;
}

/** The width a block's prelude manages, or `null` when it is anything but a managed width block. */
function managedWidth(prelude: string): number | null {
  const m = /^@media \( ?max-width ?: ?(\d+(?:\.\d+)?)px ?\)$/i.exec(normalizeSelector(prelude));
  if (!m) return null;
  const width = Number(m[1]);
  return Number.isFinite(width) && width > 0 ? width : null;
}

const isManaged = (prelude: string) => managedWidth(prelude) !== null;

/** The top-level blocks, after checking the whole file for mentions of the marker we must not edit. */
function topBlocks(css: string, needle: string): TopLevelBlock[] {
  return scanLevel(css, 0, css.length, needle, isManaged);
}

/** The rules inside one managed block. */
function innerBlocks(css: string, block: TopLevelBlock, needle: string): TopLevelBlock[] {
  return scanLevel(css, block.braceOpen + 1, block.end - 1, needle, () => false);
}

/**
 * Compare selectors on structure rather than bytes, so a reformatted or minified copy of our own
 * block is still recognised as ours.
 *
 * Whitespace is collapsed, not stripped: `[…="a"] [data-osw-id]` is a descendant selector matching
 * different elements than `[…="a"][data-osw-id]`, and stripping would merge the two. Comments are
 * removed because the CSS tokenizer removes them: a comment between two compound selectors is not
 * a descendant combinator, so `.a`-comment-`.b` selects what `.a.b` selects.
 */
function normalizeSelector(selector: string): string {
  return selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

type BodyItem =
  | { kind: 'comment'; text: string }
  | { kind: 'decl'; property: string; value: string };

/**
 * Split a block body into declarations, keeping hand-written comments as items so re-emitting the
 * block does not delete them.
 *
 * Throws on a brace outside strings and parentheses: a nested rule or at-rule (`&:hover { … }`),
 * which re-emitting as declarations would leave without its closing brace, open over every later
 * rule of the file. Every reader and writer of a body goes through here, so none acts on a misread.
 */
function parseBody(body: string): BodyItem[] {
  const items: BodyItem[] = [];
  const n = body.length;
  let buf = '';
  let i = 0;

  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (text === '') return;
    const colon = firstTopLevelColon(text);
    if (colon === -1) return;   // not a declaration; drop rather than re-emit as garbage
    items.push({
      kind: 'decl',
      property: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  };

  while (i < n) {
    if (body.startsWith('/*', i)) {
      const e = body.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      items.push({ kind: 'comment', text: body.slice(i, end) });
      i = end;
      continue;
    }
    const c = body[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (body[j] === '\\') { j += 2; continue; }
        if (body[j] === c) { j++; break; }
        if (body[j] === '\n') break;
        j++;
      }
      buf += body.slice(i, j);
      i = j;
      continue;
    }
    if (c === '(') {
      let j = i + 1;
      let par = 1;
      while (j < n && par > 0) {
        if (body[j] === '(') par++;
        else if (body[j] === ')') par--;
        j++;
      }
      buf += body.slice(i, j);
      i = j;
      continue;
    }
    if (c === '{' || c === '}') {
      const nested = c === '{' ? buf.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      throw new Error(
        `Refusing to edit /overrides.css: ${nested ? `"${nested} { … }"` : 'a block'} is nested inside an ` +
        `element's block, which the writer does not edit. Move it out to a rule of its own.`,
      );
    }
    if (c === ';') { flush(); i++; continue; }
    buf += c;
    i++;
  }
  flush();
  return items;
}

/**
 * Index of the colon that separates property from value.
 *
 * The FIRST colon at paren depth zero — the opposite of `data-osw-src`, which splits on the last.
 * A value may contain colons (`url(https://…)`, `background: linear-gradient(…)`), a property name
 * may not, so splitting late would move part of the value into the property and fail validation on
 * the next write.
 */
function firstTopLevelColon(text: string): number {
  let par = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') par++;
    else if (c === ')') { if (par > 0) par--; }
    else if (c === ':' && par === 0) return i;
  }
  return -1;
}

/** One block, its declarations indented under it. `indent` is the block's own, for a rule in a width block. */
function renderBlock(selector: string, items: BodyItem[], indent = ''): string {
  const lines = items.map((item) =>
    item.kind === 'comment' ? `${indent}  ${item.text}` : `${indent}  ${item.property}: ${item.value};`);
  return `${selector} {\n${lines.join('\n')}\n${indent}}`;
}

/** A property name as declarations are matched and reported: lowercased, but a custom property as spelled, since its name is case-sensitive. */
const nameKey = (property: string) => (property.startsWith('--') ? property : property.toLowerCase());

const IMPORTANT_RE = /\s*!\s*important\s*$/i;

/** A declared value without its `!important`. */
const plainValue = (value: string) => value.replace(IMPORTANT_RE, '');
const isImportant = (value: string) => IMPORTANT_RE.test(value);
const important = (value: string) => `${plainValue(value)} !important`;

/** The marker's blocks in one scope, in document order. */
function ownedBlocks(css: string, markerId: string, scope: OverrideScope = 'all'): TopLevelBlock[] {
  const canonical = selectorFor(markerId);
  const needle = needleFor(markerId);
  const top = topBlocks(css, needle);
  const mine = (b: TopLevelBlock) => normalizeSelector(b.selector) === canonical;
  if (scope === 'all') return top.filter(mine);
  return top
    .filter((b) => managedWidth(b.selector) === scope)
    .flatMap((b) => innerBlocks(css, b, needle).filter(mine));
}

/** Cut one block out of the file, with the indentation before it and the newline that ended it. */
function cutBlock(css: string, block: TopLevelBlock): string {
  const lineStart = css.lastIndexOf('\n', block.start - 1) + 1;
  const start = /^[ \t]*$/.test(css.slice(lineStart, block.start)) ? lineStart : block.start;
  const end = css[block.end] === '\n' ? block.end + 1 : block.end;
  return css.slice(0, start) + css.slice(end);
}

/** Managed blocks for `width` that hold nothing but whitespace, cut out. */
function dropEmptyWidthBlocks(css: string, markerId: string, width: number): string {
  const blocks = topBlocks(css, needleFor(markerId)).filter((b) => managedWidth(b.selector) === width);
  let out = css;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (out.slice(b.braceOpen + 1, b.end - 1).trim() === '') out = cutBlock(out, b);
  }
  return out;
}

/** Set one declaration on the marker's block in `scope`, creating the block (and the width block) if needed. */
function upsertIn(css: string, markerId: string, scope: OverrideScope, property: string, given: string): string {
  // A property made to win stays that way at every width: a new value for it, here or in another
  // width's block, that left the mark off would lose to the marked one or to the rule it beat.
  const value = isImportant(given) || importantProperties(css, markerId).includes(nameKey(property))
    ? important(given)
    : given;
  const selector = selectorFor(markerId);
  const indent = scope === 'all' ? '' : '  ';
  const owned = ownedBlocks(css, markerId, scope);

  if (owned.length > 0) {
    const block = owned[owned.length - 1];
    const items = parseBody(css.slice(block.braceOpen + 1, block.end - 1));
    const existing = items.find(
      (item) => item.kind === 'decl' && nameKey(item.property) === nameKey(property),
    );
    if (existing && existing.kind === 'decl') {
      existing.property = property;
      existing.value = value;
    } else {
      items.push({ kind: 'decl', property, value });
    }
    return css.slice(0, block.start) + renderBlock(selector, items, indent) + css.slice(block.end);
  }

  const rendered = renderBlock(selector, [{ kind: 'decl', property, value }], indent);
  const top = topBlocks(css, needleFor(markerId));
  const widthBlocks = top.filter((b) => managedWidth(b.selector) !== null);
  const before = (block: TopLevelBlock, text: string) => css.slice(0, block.start) + text + '\n' + css.slice(block.start);

  if (scope === 'all') {
    if (css.trim() === '') return `${OVERRIDES_HEADER}\n\n${rendered}\n`;
    // Before the width blocks, or every width block for this element would lose to it on order.
    if (widthBlocks.length > 0) return before(widthBlocks[0], rendered);
    // Append rather than prepend: hand-written rules keep their source order, and ours loads last,
    // which is what the (0,2,0) specificity tie depends on.
    return css + (css.endsWith('\n') ? '' : '\n') + rendered + '\n';
  }

  const same = widthBlocks.filter((b) => managedWidth(b.selector) === scope);
  if (same.length > 0) {
    const block = same[same.length - 1];
    const body = css.slice(block.braceOpen + 1, block.end - 1).replace(/\s+$/, '');
    return css.slice(0, block.braceOpen + 1) + `${body}\n  ${rendered}\n` + css.slice(block.end - 1);
  }

  const media = `${scopePrelude(scope)} {\n  ${rendered}\n}`;
  if (css.trim() === '') return `${OVERRIDES_HEADER}\n\n${media}\n`;
  // Widest first: a narrower block after a wider one wins where both apply.
  const narrower = widthBlocks.find((b) => (managedWidth(b.selector) ?? 0) < scope);
  if (narrower) return before(narrower, media);
  return css + (css.endsWith('\n') ? '' : '\n') + media + '\n';
}

/** Take one declaration off the marker's blocks in `scope`; a block left empty goes, and so does an empty width block. */
function removeIn(css: string, markerId: string, scope: OverrideScope, property: string): string {
  const owned = ownedBlocks(css, markerId, scope);
  if (owned.length === 0) return css;
  const wanted = nameKey(property);
  const indent = scope === 'all' ? '' : '  ';

  let out = css;
  // Back to front, so an earlier block's indices are still valid after a later one is rewritten.
  for (let i = owned.length - 1; i >= 0; i--) {
    const block = owned[i];
    const items = parseBody(out.slice(block.braceOpen + 1, block.end - 1));
    const kept = items.filter(
      (item) => !(item.kind === 'decl' && nameKey(item.property) === wanted),
    );
    if (kept.length === items.length) continue;
    out = kept.some((item) => item.kind === 'decl')
      ? out.slice(0, block.start) + renderBlock(selectorFor(markerId), kept, indent) + out.slice(block.end)
      : cutBlock(out, block);
  }
  return scope === 'all' ? out : dropEmptyWidthBlocks(out, markerId, scope);
}

/**
 * Set one declaration on a marker's block, creating the block (and the file body) if needed.
 *
 * Returns the new file content; never mutates. Throws rather than editing whenever the marker's
 * ownership of a block is ambiguous — see the module comment for which cases and why.
 *
 * When more than one block in the scope carries the marker's selector (only reachable by hand
 * editing), the LAST is edited, because that is the one that wins the cascade and therefore the one
 * whose values the user is actually seeing.
 */
export function upsertDeclaration(
  css: string,
  markerId: string,
  declaration: StyleDeclaration,
  scope: OverrideScope = 'all',
): string {
  assertSafeMarkerId(markerId);
  assertSafeDeclaration(declaration);
  return upsertIn(css, markerId, scope, declaration.property, declaration.value.trim());
}

/**
 * Removes one declaration from a marker's blocks in `scope`; removes a block left empty.
 * Does not remove the marker from source. Returns input unchanged when no match.
 */
export function removeDeclaration(
  css: string,
  markerId: string,
  property: string,
  scope: OverrideScope = 'all',
): string {
  assertSafeMarkerId(markerId);
  assertSafeProperty(property);
  return removeIn(css, markerId, scope, property);
}

/**
 * Apply a list of changes to one marker in one scope, in order: a value sets the property, `null`
 * removes it. All or nothing: every change is validated before any is applied, and the result is
 * returned rather than written, so a refused change leaves the file as it was.
 */
export function applyChanges(
  css: string,
  markerId: string,
  scope: OverrideScope,
  changes: readonly StyleChange[],
): string {
  assertSafeMarkerId(markerId);
  for (const change of changes) {
    if (change.value === null) assertSafeProperty(change.property);
    else assertSafeDeclaration({ property: change.property, value: change.value });
  }
  let out = css;
  for (const change of changes) {
    out = change.value === null
      ? removeIn(out, markerId, scope, change.property)
      : upsertIn(out, markerId, scope, change.property, change.value.trim());
  }
  // Only with a change of its own: a call that changes nothing must not turn into a write.
  return out === css ? css : withCurrentHeader(out);
}

/** Every declaration the marker has, by scope: property (as {@link nameKey} gives it) to value, a later block winning. */
export function declaredByScope(css: string, markerId: string): Map<OverrideScope, Record<string, string>> {
  assertSafeMarkerId(markerId);
  const canonical = selectorFor(markerId);
  const needle = needleFor(markerId);
  const out = new Map<OverrideScope, Record<string, string>>();
  const take = (scope: OverrideScope, block: TopLevelBlock) => {
    const bag = out.get(scope) ?? {};
    for (const item of parseBody(css.slice(block.braceOpen + 1, block.end - 1))) {
      if (item.kind === 'decl') bag[nameKey(item.property)] = plainValue(item.value);
    }
    if (Object.keys(bag).length > 0) out.set(scope, bag);
  };
  for (const block of topBlocks(css, needle)) {
    const width = managedWidth(block.selector);
    if (width === null) {
      if (normalizeSelector(block.selector) === canonical) take('all', block);
      continue;
    }
    for (const inner of innerBlocks(css, block, needle)) {
      if (normalizeSelector(inner.selector) === canonical) take(width, inner);
    }
  }
  return out;
}

/** Every block of the marker, at every width, in document order. */
function everyBlock(css: string, markerId: string): TopLevelBlock[] {
  return [...ownedBlocks(css, markerId, 'all'), ...managedWidths(css).flatMap(width => ownedBlocks(css, markerId, width))]
    .sort((a, b) => a.start - b.start);
}

/**
 * The properties the marker declares `!important` at any width, as {@link nameKey} gives them. {@link declaredByScope}
 * gives values without the mark, so a reader of values never has to know of it; this is the other half.
 */
export function importantProperties(css: string, markerId: string): string[] {
  assertSafeMarkerId(markerId);
  const out: string[] = [];
  for (const block of everyBlock(css, markerId)) {
    for (const item of parseBody(css.slice(block.braceOpen + 1, block.end - 1))) {
      if (item.kind !== 'decl' || !isImportant(item.value)) continue;
      const name = nameKey(item.property);
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Marks the marker's declarations of `properties` `!important`, at every width: what makes an
 * override win over a project rule with a stronger selector, a later one, or the element's own
 * `style` attribute. It does not win over a declaration that is itself `!important` and stronger.
 * Returns the input unchanged when there is nothing to mark.
 */
export function strengthenDeclarations(css: string, markerId: string, properties: readonly string[]): string {
  assertSafeMarkerId(markerId);
  const wanted = properties.map(nameKey);
  if (wanted.length === 0) return css;
  let out = css;
  // Last first, so an earlier block's indices still stand after a later one grew.
  for (const block of everyBlock(css, markerId).reverse()) {
    const items = parseBody(out.slice(block.braceOpen + 1, block.end - 1));
    let changed = false;
    for (const item of items) {
      if (item.kind !== 'decl' || isImportant(item.value) || !wanted.includes(nameKey(item.property))) continue;
      item.value = important(item.value);
      changed = true;
    }
    if (!changed) continue;
    const lineStart = out.lastIndexOf('\n', block.start - 1) + 1;
    const indent = /^[ \t]*$/.test(out.slice(lineStart, block.start)) ? out.slice(lineStart, block.start) : '';
    out = out.slice(0, block.start) + renderBlock(selectorFor(markerId), items, indent) + out.slice(block.end);
  }
  return out === css ? css : withCurrentHeader(out);
}

/** What properties this element has in /overrides.css in `scope`. Throws on parse failure rather than returning []. */
export function declaredProperties(css: string, markerId: string, scope: OverrideScope = 'all'): string[] {
  assertSafeMarkerId(markerId);
  const seen: string[] = [];
  for (const block of ownedBlocks(css, markerId, scope)) {
    for (const item of parseBody(css.slice(block.braceOpen + 1, block.end - 1))) {
      if (item.kind !== 'decl') continue;
      const property = nameKey(item.property);
      if (!seen.includes(property)) seen.push(property);
    }
  }
  return seen;
}

/** Removes the marker's blocks in one scope; a width block left empty goes with them. */
export function clearScope(css: string, markerId: string, scope: OverrideScope): string {
  assertSafeMarkerId(markerId);
  const owned = ownedBlocks(css, markerId, scope);
  if (owned.length === 0) return css;
  let out = css;
  // Back to front, so an earlier block's indices are still valid after a later one is removed.
  for (let i = owned.length - 1; i >= 0; i--) out = cutBlock(out, owned[i]);
  return scope === 'all' ? out : dropEmptyWidthBlocks(out, markerId, scope);
}

/**
 * Removes every block for a marker, at every width.
 *
 * Returns the input unchanged when the marker owns nothing. Throws on the same ambiguity cases as
 * `upsertDeclaration`.
 */
export function removeMarkerBlock(css: string, markerId: string): string {
  assertSafeMarkerId(markerId);
  let out = clearScope(css, markerId, 'all');
  for (const width of managedWidths(out)) out = clearScope(out, markerId, width);
  return out;
}

/**
 * The marker's blocks as the file has them, for reading: each top-level block, and each width block
 * holding one of its rules, cut down to those rules. Empty when the file has none.
 */
export function markerBlocksText(css: string, markerId: string): string {
  assertSafeMarkerId(markerId);
  const canonical = selectorFor(markerId);
  const needle = needleFor(markerId);
  const parts: string[] = [];
  const text = (block: TopLevelBlock) => {
    const lineStart = css.lastIndexOf('\n', block.start - 1) + 1;
    const lead = css.slice(lineStart, block.start);
    return (/^[ \t]*$/.test(lead) ? lead : '') + css.slice(block.start, block.end);
  };
  for (const block of topBlocks(css, needle)) {
    const width = managedWidth(block.selector);
    if (width === null) {
      if (normalizeSelector(block.selector) === canonical) parts.push(text(block));
      continue;
    }
    const rules = innerBlocks(css, block, needle).filter((b) => normalizeSelector(b.selector) === canonical);
    if (rules.length > 0) parts.push(`${scopePrelude(width)} {\n${rules.map(text).join('\n')}\n}`);
  }
  return parts.join('\n\n');
}

/** The widths the file has managed blocks for, widest first. */
export function managedWidths(css: string): number[] {
  // A needle no stylesheet contains: this reads the layout, it does not look for a marker.
  const widths = topBlocks(css, '\u0000')
    .map((b) => managedWidth(b.selector))
    .filter((w): w is number => w !== null);
  return Array.from(new Set(widths)).sort((a, b) => b - a);
}

/** Every marker id the file has a rule for, once each, in the order they first appear. */
export function markerIdsIn(css: string): string[] {
  const ids: string[] = [];
  const pattern = new RegExp(`\\[${MARKER_ATTR}="([A-Za-z0-9_-]+)"\\]\\[${MARKER_ATTR}\\]`, 'g');
  for (const match of css.matchAll(pattern)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
}
