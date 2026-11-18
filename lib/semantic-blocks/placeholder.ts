/**
 * The placeholder a Semantic block dropped on a page writes into its source: one element, the
 * placement's id in its attribute and the block's name as its text. Its look is not in the source:
 * the preview frames add {@link PLACEHOLDER_CSS}, below the element's own overrides, so styling the
 * placeholder shows, and those styles can go on to the block the agent builds in its place.
 */

import { readOpenTagAt } from '@/lib/preview/provenance';
import { findAttributeIn, type AttributeSpan } from '@/lib/direct-edit/attributes';
import { newMarkerId } from '@/lib/direct-edit/marker';
import { scanElements, type SourceNode } from '@/lib/direct-edit/structure';
import { getBlockById, placeholderCss } from './registry';
import type { SemanticBlock } from './types';

/** The attribute a placeholder carries: its placement's id, `hero-k3j9x2m1`. */
export const BLOCK_ATTR = 'data-osw-block';

/** Nothing in it can end the attribute value it is written into. */
export const isPlacementId = (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);

/** The block's id and a random tail: what the placeholder's attribute says. */
export function newPlacementId(blockId: string): string {
  return `${blockId}-${newMarkerId()}`;
}

/**
 * Text as an element's content in source: `&`, `<` and `>` escaped and quotes left as typed, the
 * spelling the text editor (`lib/direct-edit/apply-text.ts`) reads back as the text itself.
 */
export const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The placeholder for `block`. */
export function placeholderMarkup(block: SemanticBlock, placementId: string): string {
  return `<div ${BLOCK_ATTR}="${placementId}">${escapeText(block.name)}</div>`;
}

/** What placeholders look like in Live Preview and on Canvas. */
export const PLACEHOLDER_CSS = placeholderCss(BLOCK_ATTR);

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** The element's range, widened to its whole line when nothing else stands on it. */
function lineOf(html: string, start: number, end: number): [number, number] {
  let from = start;
  while (html[from - 1] === ' ' || html[from - 1] === '\t') from--;
  if (from > 0 && html[from - 1] !== '\n') return [start, end];
  let to = end;
  while (html[to] === ' ' || html[to] === '\t' || html[to] === '\r') to++;
  if (to < html.length && html[to] !== '\n') return [start, end];
  return [from, Math.min(html.length, to + 1)];
}

/**
 * Whether the element says what {@link placeholderMarkup} wrote into it, its block's name, whitespace
 * aside. A text block built in place says something else, and one whose block is unknown cannot be told.
 */
function saysBlockName(html: string, node: SourceNode, placementId: string): boolean {
  const block = getBlockById(placementId.slice(0, placementId.lastIndexOf('-')));
  return !!block && html.slice(node.openEnd, node.closeStart).replace(/\s+/g, ' ').trim() === escapeText(block.name);
}

/** The range of one attribute in its open tag, name to closing quote, with the whitespace before it. */
function attributeRange(html: string, span: AttributeSpan): [number, number] {
  const to = span.quote && html[span.valueEnd] === span.quote ? span.valueEnd + 1 : span.valueEnd;
  let from = span.valueStart - (span.quote ? 1 : 0);
  while (isSpace(html[from - 1])) from--;
  from--;
  while (isSpace(html[from - 1])) from--;
  from -= BLOCK_ATTR.length;
  while (isSpace(html[from - 1])) from--;
  return [from, to];
}

/**
 * `html` without its placeholders, for a page that is published or exported as a site: a
 * placeholder is a request to the agent that has not been carried out, and its look is added only
 * in the preview, so a visitor would see a bare box with the block's name. The project keeps it.
 * A placeholder alone on its line takes the line with it.
 *
 * Only an element shaped as {@link placeholderMarkup} writes one goes: a `div` with a placement id,
 * closed by its own close tag, holding its block's name and no element. Anything else carrying the
 * attribute is a block built in its place that kept it, or a placeholder someone broke open, and
 * loses the attribute alone: a guessed range would take real content off the published page.
 */
export function withoutPlaceholders(html: string): string {
  if (!html.includes(BLOCK_ATTR)) return html;
  const nodes = scanElements(html);
  const parents = new Set<number>();
  for (const node of nodes) if (node.parent !== -1) parents.add(node.parent);
  const kept: string[] = [];
  let at = 0;
  nodes.forEach((node, index) => {
    if (node.start < at) return;
    const tag = readOpenTagAt(html, node.start);
    const span = tag ? findAttributeIn(html, tag, BLOCK_ATTR) : null;
    if (!span) return;
    const placeholder = node.tag === 'div' && isPlacementId(span.value) && !node.implied
      && node.end > node.openEnd && !parents.has(index) && saysBlockName(html, node, span.value);
    const [from, to] = placeholder ? lineOf(html, node.start, node.end) : attributeRange(html, span);
    kept.push(html.slice(at, Math.max(at, from)));
    at = to;
  });
  kept.push(html.slice(at));
  return kept.join('');
}
