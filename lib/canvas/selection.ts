/**
 * Which element a click on an artboard selects.
 *
 * The frame answers a pick with the chain of elements under the point that came from a source file
 * (they carry `data-osw-src`), outermost first. Wrappers are left out of it, the picked element
 * excepted: `<main>`, and anything nearly as tall as the page. A click on a section should select the
 * section, not what holds every section.
 */

export interface ChainItem {
  /** The frame's id for the element (`data-osw-node`), valid while its document is. */
  nodeId: string;
  /** Its parent's id, when the parent came from a source file too. */
  parentId: string | null;
  /** Rendered height in CSS pixels. */
  height: number;
  /** Its tag name, lower case. */
  tag?: string;
  /** It has words of its own and no element inside: double-clicking it, selected, types in place. */
  leafText?: boolean;
}

/** Wrappers this much of the page's height or taller are not click targets. */
const WRAPPER_SHARE = 0.9;

/** The chain without wrappers; the innermost element always stays. */
export function clickableChain<T extends ChainItem>(chain: readonly T[], pageHeight: number): T[] {
  return chain.filter((item, i) => i === chain.length - 1 || (item.tag !== 'main' && item.height < pageHeight * WRAPPER_SHARE));
}

/**
 * A click: the deepest element with ⌘ or Ctrl held; otherwise the current selection if the click is
 * inside it, its sibling at the same level if the click is on one, or else the outermost element.
 * `current` is the selection on the same artboard, or null.
 */
export function clickTarget<T extends ChainItem>(chain: readonly T[], pageHeight: number, current: { nodeId: string; parentId: string | null } | null, deep: boolean): T | null {
  const list = clickableChain(chain, pageHeight);
  if (!list.length) return null;
  if (deep) return list[list.length - 1];
  if (current) {
    const inside = list.find((item) => item.nodeId === current.nodeId);
    if (inside) return inside;
    if (current.parentId) {
      const sibling = list.find((item) => item.parentId === current.parentId);
      if (sibling) return sibling;
    }
  }
  return list[0];
}

/**
 * One level deeper than the selection, along the chain under the pointer. Null when the selection is
 * the innermost element there, or isn't on the chain at all.
 */
export function deeperTarget<T extends ChainItem>(chain: readonly T[], pageHeight: number, currentNodeId: string | null): T | null {
  const list = clickableChain(chain, pageHeight);
  const i = currentNodeId ? list.findIndex((item) => item.nodeId === currentNodeId) : -1;
  return i >= 0 && i < list.length - 1 ? list[i + 1] : null;
}

/**
 * Whether a click is a double-click on Canvas: every second click of a run, by the browser's count
 * (`detail`). The browser's own double-click event comes only at the 2nd, so a run clicked on at a
 * steady rate would go one level deeper and stop.
 */
export const isDoubleClick = (detail: number) => detail >= 2 && detail % 2 === 0;

/**
 * A double-click, which on Canvas is every second click of a run (the 2nd, the 4th, …): one level
 * deeper than what its own first click selects (see {@link clickTarget}), worked out from the chain
 * and the selection before it, so it does not depend on whether that click's selection has landed.
 * At the innermost element, it types in place when the element has words of its own.
 */
export function doubleClickTarget<T extends ChainItem>(
  chain: readonly T[],
  pageHeight: number,
  current: { nodeId: string; parentId: string | null } | null,
  deep: boolean,
): { select: T | null; editText: boolean } {
  const base = clickTarget(chain, pageHeight, current, deep);
  if (!base) return { select: null, editText: false };
  const deeper = deeperTarget(chain, pageHeight, base.nodeId);
  if (deeper) return { select: deeper, editText: false };
  const leaf = chain[chain.length - 1];
  return { select: base, editText: Boolean(leaf && leaf.nodeId === base.nodeId && leaf.leafText) };
}

/**
 * The selections Canvas made itself, in order. The frame confirms each one, and a confirmation of an
 * older one that arrives after a newer selection must not put that older one back: a double-click
 * selects twice in quick succession, and the first click's confirmation lands after the second.
 */
export class OwnSelections {
  private keys: string[] = [];

  add(board: string, nodeId: string): void {
    this.keys.push(`${board}\n${nodeId}`);
    if (this.keys.length > 16) this.keys.shift();
  }

  /**
   * A confirmation from the frame: `stale` when Canvas has made a newer selection since, `own` for
   * the latest, `foreign` for one Canvas did not make (a row picked in the Elements tree).
   */
  settle(board: string, nodeId: string): 'stale' | 'own' | 'foreign' {
    const at = this.keys.indexOf(`${board}\n${nodeId}`);
    if (at === -1) return 'foreign';
    const newer = at < this.keys.length - 1;
    this.keys = this.keys.slice(at + 1);
    return newer ? 'stale' : 'own';
  }
}
