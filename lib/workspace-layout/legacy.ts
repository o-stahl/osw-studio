import { isPanelKey } from './model';
import type { PanelKey, WorkspaceLayout } from './types';

/**
 * Left to right, for whichever panels are open, in a workspace with no saved layout.
 *
 * Chat and preview lead because they are the pair that stays open: the work is asking for a change
 * and looking at the result, and everything else is opened to answer a question and closed again.
 */
export const DEFAULT_PANEL_ORDER: readonly PanelKey[] = ['chat', 'preview', 'files', 'editor', 'skills', 'console', 'elements', 'checkpoints', 'debug'];

const OPEN_BY_DEFAULT: ReadonlySet<PanelKey> = new Set<PanelKey>(['chat', 'preview', 'files']);

/**
 * The layout a workspace saved before docking: one column per open panel, in the saved order
 * (`osw-workspace-panel-order`, unknown keys dropped and missing ones appended), open as saved in
 * `osw-workspace-panels`, at the widths react-resizable-panels saved for that set of panels under
 * its `workspace-slots` entry. Called with nulls, it is the layout a fresh workspace opens with.
 */
export function layoutFromLegacy(order: unknown, open: unknown, slots: unknown): WorkspaceLayout {
  const saved = Array.isArray(order) ? order.filter(isPanelKey) : [];
  const keys = [...saved, ...DEFAULT_PANEL_ORDER.filter((key) => !saved.includes(key))];
  const flags = open && typeof open === 'object' ? (open as Record<string, unknown>) : {};
  const shown = keys.filter((key) => (typeof flags[key] === 'boolean' ? flags[key] : OPEN_BY_DEFAULT.has(key)));
  const widths = savedWidths(slots, shown) ?? shown.map(() => 100 / shown.length);
  return {
    v: 1,
    columns: shown.map((key, i) => ({
      id: `col${i + 1}`,
      size: widths[i],
      cells: [{ id: `cell${i + 1}`, size: 100, tabs: [key], active: key }],
    })),
  };
}

/**
 * The widths react-resizable-panels saved for exactly these panels: its entry is keyed by the sorted
 * panel ids (`panel-<key>`) and holds a layout in on-screen order.
 */
function savedWidths(slots: unknown, keys: PanelKey[]): number[] | null {
  if (!slots || typeof slots !== 'object' || !keys.length) return null;
  const entryKey = keys.map((key) => `panel-${key}`).sort((a, b) => a.localeCompare(b)).join(',');
  const entry = (slots as Record<string, { layout?: unknown }>)[entryKey];
  const layout = entry && Array.isArray(entry.layout) ? entry.layout : null;
  if (!layout || layout.length !== keys.length || !layout.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const sum = layout.reduce((a, b) => a + b, 0);
  return layout.map((n) => (n * 100) / sum);
}
