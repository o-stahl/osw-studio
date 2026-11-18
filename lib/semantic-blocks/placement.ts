/**
 * Semantic blocks placed on a page compiled with source positions: how the placeholder written into
 * the source where the block was dropped (`placeholder.ts`) is found again, and how placed blocks
 * are put to the agent when the message goes.
 *
 * The placeholder is the request made visible: it shows in the file, the Elements tree, every Canvas
 * artboard and Live Preview, and the agent replaces it with the block, keeping the styles the user
 * gave it. A page compiled without source positions (a bundled runtime) gets a placeholder in its
 * preview frame only, and the agent gets the page's markup around the drop (`FramePlacedBlock`).
 */

import { vfs as browserVfs, type VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { readOpenTagAt } from '@/lib/preview/provenance';
import type { StructurePlace } from '@/lib/preview/types';
import { findAttributeIn } from '@/lib/direct-edit/attributes';
import { readMarkerAt } from '@/lib/direct-edit/marker';
import { sourceRef } from '@/lib/direct-edit/resolution';
import { scanElements } from '@/lib/direct-edit/structure';
import { getBlockById } from './registry';
import { BLOCK_ATTR } from './placeholder';
import { isSourcePlaced, type PlacedBlock, type SemanticBlock, type SentBlock } from './types';

/** A place as a frame reports it, which runs the project's scripts: its fields checked. */
export function isPlace(value: unknown): value is StructurePlace {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.before === 'string' || typeof v.after === 'string'
    || (typeof v.parent === 'string' && (v.at === 'start' || v.at === 'end'));
}

/** Where the placeholder with this id starts in `content`, or `null` when it is not there. */
export function placeholderAt(content: string, placementId: string): number | null {
  if (!content.includes(placementId)) return null;
  for (const node of scanElements(content)) {
    const tag = readOpenTagAt(content, node.start);
    if (tag && findAttributeIn(content, tag, BLOCK_ATTR)?.value === placementId) return node.start;
  }
  return null;
}

async function readText(fs: VirtualFileSystem, projectId: string, path: string): Promise<string | null> {
  try {
    return asText((await fs.readFile(projectId, path)).content);
  } catch {
    return null;
  }
}

/** A placed block as the message puts it to the agent. */
export type ResolvedBlock = { block: SemanticBlock; page: string } & (
  /** `markup`: the placeholder element as the file spells it. `marker`: its `data-osw-id`, when it was styled. */
  | { placementId: string; file: string; offset: number; ref: string; markup: string; marker: string | null }
  | { domPath: string; position: 'before' | 'after'; htmlContext: string }
);

/**
 * The placed blocks as they are now, each placeholder with its position in its file (`ref`, as the
 * agent's commands take it). A block whose placeholder is gone from its file, or that the registry
 * no longer has, is left out.
 */
export async function resolvePlacedBlocks(
  projectId: string,
  placed: readonly PlacedBlock[],
  fs: VirtualFileSystem = browserVfs,
): Promise<ResolvedBlock[]> {
  const texts = new Map<string, string | null>();
  const out: ResolvedBlock[] = [];
  for (const p of placed) {
    const block = getBlockById(p.blockId);
    if (!block) continue;
    if (!isSourcePlaced(p)) {
      out.push({ block, page: p.page, domPath: p.domPath, position: p.position, htmlContext: p.htmlContext });
      continue;
    }
    if (!texts.has(p.file)) texts.set(p.file, await readText(fs, projectId, p.file));
    const content = texts.get(p.file);
    const offset = content ? placeholderAt(content, p.placementId) : null;
    if (content && offset !== null) {
      const node = scanElements(content).find(n => n.start === offset);
      out.push({
        block, page: p.page, placementId: p.placementId, file: p.file, offset,
        ref: sourceRef(p.file, content, offset),
        markup: content.slice(offset, node ? node.end : offset),
        marker: readMarkerAt(content, offset),
      });
    }
  }
  return out;
}

/**
 * `html` cut to `maxLength` around `marker`, so the drop position stays in view with context on both
 * sides; head and tail when the marker is not in it.
 */
export function truncateAroundMarker(html: string, marker: string, maxLength = 1200): string {
  if (!html) return '';
  if (html.length <= maxLength) return html;
  const at = html.indexOf(marker);
  if (at === -1) {
    const tailLength = Math.floor(maxLength * 0.3);
    return `${html.slice(0, Math.floor(maxLength * 0.6))}\n  (...truncated...)\n${tailLength > 0 ? html.slice(-tailLength) : ''}`;
  }
  const half = Math.max(0, Math.floor((maxLength - marker.length) / 2));
  const start = Math.max(0, at - half);
  const end = Math.min(html.length, at + marker.length + half);
  return `${start > 0 ? '(...truncated...)\n' : ''}${html.slice(start, end)}${end < html.length ? '\n(...truncated...)' : ''}`;
}

/**
 * The context block a message with placed blocks starts with, for the agent: what the user did, the
 * steps to take, then each block with its placeholder as the file spells it, so it can be replaced
 * without a search first.
 */
export function placedBlocksPrompt(blocks: readonly ResolvedBlock[]): string {
  if (blocks.length === 0) return '';
  const inSource = blocks.some(b => 'file' in b);
  const lines = [
    'Blocks to build:',
    'The user dragged the blocks below onto the page, each to the spot they want it. Build every one of them, at that spot.',
  ];
  if (inSource) {
    lines.push(
      `1. Each block stands in the HTML as a placeholder element (it has a ${BLOCK_ATTR} attribute and the block's name as its text). Replace the whole placeholder element with the block's real HTML. No ${BLOCK_ATTR} attribute should be left when you are done.`, // i18n-ignore: part of the context block sent to the agent
      '2. Put the block\'s CSS in the project\'s stylesheet, not in a style attribute. Make it belong to this site: the same colours, fonts, spacing and class naming as the sections around it, with sample content where needed.', // i18n-ignore: part of the context block sent to the agent
      '3. If a placeholder has a data-osw-id attribute, the user styled it. Put that same data-osw-id on the block\'s outermost element, so those styles (they are in /overrides.css) carry over to the block.', // i18n-ignore: part of the context block sent to the agent
    );
  } else {
    lines.push('Make each belong to this site: the same colours, fonts, spacing and class naming as the sections around it, with sample content where needed. Put its CSS in the project\'s stylesheet.'); // i18n-ignore: part of the context block sent to the agent
  }
  if (blocks.some(b => !('file' in b))) {
    lines.push('A block given with "Where" instead of a placeholder has no element in the source: the HTML shown is the page around the spot, and the comment `<!-- INSERT <block name> HERE -->` marks the spot. The comment is not in the file. Find that HTML in the source and add the block where the comment is.'); // i18n-ignore: part of the context block sent to the agent
  }
  lines.push('');
  blocks.forEach((b, index) => {
    lines.push(`[${index + 1}] ${b.block.name} (page: ${b.page})`);
    lines.push(`    What it is: ${b.block.description}`); // i18n-ignore: part of the context block sent to the agent
    if ('file' in b) {
      lines.push(`    Placeholder, at ${b.ref}${b.marker ? ` (styled by the user: keep data-osw-id="${b.marker}" on the block)` : ''}:`); // i18n-ignore: part of the context block sent to the agent
      lines.push(`    ${b.markup}`);
    } else if (b.htmlContext) {
      const marker = `<!-- INSERT ${b.block.name} HERE -->`;
      lines.push('    Where:');
      lines.push('    ```html');
      lines.push(`    ${truncateAroundMarker(b.htmlContext, marker)}`);
      lines.push('    ```');
    } else {
      lines.push(`    Where: ${b.position} ${b.domPath}`); // i18n-ignore: part of the context block sent to the agent
    }
    lines.push('');
  });
  return lines.join('\n');
}

/** The placed blocks as the sent message records them. */
export function sentBlocks(blocks: readonly ResolvedBlock[]): SentBlock[] {
  return blocks.map(b => ({
    blockId: b.block.id,
    name: b.block.name,
    description: b.block.description,
    ...('file' in b ? { file: b.file, placementId: b.placementId } : { domPath: b.domPath, position: b.position }),
  }));
}
