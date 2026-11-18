/**
 * A style change to one element, written: its marker into source and its rules into `/overrides.css`.
 *
 * 1. Source file is read once and written once (stamp marker, then insert `<link>`, on the same string).
 * 2. `/overrides.css` is written silently (no provenance indices); source files are not.
 * 3. Link sweep runs on every apply so pages the agent adds later pick up the stylesheet.
 */

import { vfs as browserVfs, type VirtualFileSystem } from '@/lib/vfs';
import { readOpenTagAt } from '@/lib/preview/provenance';
import { resolveSelection } from './resolution';
import { MARKER_ATTR, newMarkerId, readMarkerAt, stampMarker } from './marker';
import { ensureOverridesLink } from './link-invariant';
import { OVERRIDES_PATH, applyChanges, declaredByScope, managedWidths, markerBlocksText, markerIdsIn, removeMarkerBlock, strengthenDeclarations, type OverrideScope } from './overrides-css';
import type { ApplyResult, PreviewSelection, StyleChange, WriteRecorder } from './types';
import { asText } from '@/lib/vfs/as-text';

export { OVERRIDES_PATH };

/**
 * Fired on `window` with `{ projectId, css }` when something other than the Styles tab writes
 * `/overrides.css` silently (the agent's `style` command), so the open workspace sends the new rules
 * to its frames as it does for its own writes.
 */
export const OVERRIDES_WRITTEN_EVENT = 'osw:overrides-written';

/** A marker id a caller may choose: what `stampMarker` accepts. */
const SAFE_MARKER = /^[A-Za-z0-9_-]+$/;

/** Pages that can hold a `<head>`. `.hbs` partials are swept by nothing: they have no head. */
const PAGE_RE = /\.html?$/i;

/** `/.skills/…`, `/.server/…` and friends never ship and are never edit targets. */
export function isHidden(path: string): boolean {
  const first = path.split('/').filter(Boolean)[0];
  return !!first && first.startsWith('.');
}

/** A file the compile serves as a page, as against a partial or an asset. */
export function isPage(path: string): boolean {
  return PAGE_RE.test(path) && !isHidden(path);
}

/**
 * Apply a list of changes to the selected element's override block in one write: a value sets the
 * property, `null` removes it. `scope` is the width block they go in (`'all'` by default).
 *
 * A list that only removes never stamps: an element with no marker has nothing to remove, so that is
 * a success that writes nothing.
 *
 * `confirmedMultiInstance` is required when the element resolves to a shared partial.
 *
 * `isGenerating` is injected to keep `lib/direct-edit/` free of store imports. `record` hears about
 * every file written, for the edit journal.
 */
export async function applyStyleOverride(
  projectId: string,
  selection: PreviewSelection,
  changes: readonly StyleChange[],
  opts?: {
    scope?: OverrideScope;
    /**
     * The element's marker when the caller knows it and the payload may not carry it yet: the panel
     * learns it from the first write, before the frame recompiles. Used for removals only; a write
     * that sets reads the marker back out of source rather than trust a remembered one.
     */
    markerId?: string | null;
    /**
     * The id to stamp if the element has none: the panel picks it ahead of the write, so the frames
     * can show the change on the element before the write lands. A marker already in source wins.
     */
    newMarkerId?: string;
    confirmedMultiInstance?: boolean;
    /**
     * Properties to mark `!important` in the element's blocks, after the changes: the ones a render
     * showed losing to a rule of the project or to the element's own `style` attribute. With no
     * changes, this is all the call does.
     */
    strengthen?: readonly string[];
    isGenerating?: () => boolean;
    record?: WriteRecorder;
    /** The files to write: the tab's own by default; the agent's shell passes the run's. */
    fs?: VirtualFileSystem;
  },
): Promise<ApplyResult> {
  const vfs = opts?.fs ?? browserVfs;
  // 1. Gate. A write landing mid-generation races the agent's own edits over the same files.
  if (opts?.isGenerating?.()) return { ok: false, reason: 'generating', filesWritten: [] };

  const scope = opts?.scope ?? 'all';
  const sets = changes.some((change) => change.value !== null);
  const filesWritten: string[] = [];
  const skippedPages: string[] = [];

  // 2. Fast path. After the first edit the element carries its marker, so re-editing it is a pure
  //    `/overrides.css` update: no resolution, no source write. `attributes` can miss the marker on
  //    an attribute-heavy element (gatherAttributes caps its output), which costs the slow path but
  //    is not wrong — the slow path reads the same id back out of source.
  let markerId = selection.attributes?.[MARKER_ATTR] ?? (sets ? undefined : opts?.markerId ?? undefined);
  let sourceFile: string | undefined;

  if (!markerId || !sets) {
    // 3. Resolve. A removal resolves even with the marker in hand: taking a style off a shared
    //    partial changes every instance, which is what the confirmation is for.
    const resolution = resolveSelection(selection);
    if (resolution.kind === 'unresolvable') {
      if (markerId) return writeOverrides(projectId, markerId, scope, changes, filesWritten, skippedPages, opts?.record, vfs, opts?.strengthen);
      return sets ? { ok: false, reason: 'unresolvable', filesWritten: [] } : { ok: true, filesWritten: [] };
    }
    if (resolution.kind === 'one-to-many' && !opts?.confirmedMultiInstance) {
      return {
        ok: false,
        reason: 'needs-confirmation',
        file: resolution.file,
        instances: resolution.instances,
        filesWritten: [],
      };
    }

    if (!markerId) {
      const file = resolution.file;

      // 4. Read the source once. `readFile` throws when the file is gone, which is the likeliest
      //    stale case: the agent deleted or renamed it since the preview compiled.
      let original: string;
      try {
        original = asText((await vfs.readFile(projectId, file)).content);
      } catch {
        return { ok: false, reason: 'missing-file', file, filesWritten: [] };
      }

      // 5. Validate the index against the tag name the payload carries. A stale `tagStart` usually
      //    still lands on *some* valid open tag, which passes a `<`-plus-letter check and stamps the
      //    marker onto the wrong element permanently. The tag name is what narrows it.
      const tag = readOpenTagAt(original, resolution.tagStart);
      if (!tag || (selection.tagName && tag.tagName !== selection.tagName.toLowerCase())) {
        return { ok: false, reason: 'stale-index', file, filesWritten: [] };
      }

      if (!sets) {
        // Nothing to stamp for: an unmarked element has no block to take anything out of.
        const existing = readMarkerAt(original, resolution.tagStart);
        if (!existing) return { ok: true, filesWritten: [] };
        markerId = existing;
      } else {
        // 6. Stamp, then link, then write — once, in that order. See the module comment.
        const candidate = opts?.newMarkerId && SAFE_MARKER.test(opts.newMarkerId) ? opts.newMarkerId : newMarkerId();
        const stamp = stampMarker(original, resolution.tagStart, candidate);
        markerId = stamp.existing ?? candidate;

        let next = stamp.content;
        if (isPage(file)) {
          const linked = ensureOverridesLink(next);
          if (linked.skipped === 'no-head') skippedPages.push(file);
          next = linked.content;
        }
        if (next !== original) {
          await vfs.updateFile(projectId, file, next);
          opts?.record?.({ path: file, before: original, after: next, silent: false });
          filesWritten.push(file);
        }
        sourceFile = file;
      }
    }
  }

  const written = await writeOverrides(projectId, markerId, scope, changes, filesWritten, skippedPages, opts?.record, vfs, opts?.strengthen);
  if (!written.ok || !sets) return written;

  // 7. Link sweep over every other page.
  await linkOverridesEverywhere(projectId, sourceFile, filesWritten, skippedPages, opts?.record, vfs);
  return written;
}

/**
 * Link `/overrides.css` from every page but `skip`. Running it on every write that adds an
 * override is what makes the link an invariant rather than a one-time write: a page the agent adds
 * later picks it up on the next edit instead of silently losing every override on it. Only the
 * pages are read: a project's images and other files would make every edit wait on loading them.
 */
export async function linkOverridesEverywhere(
  projectId: string,
  skip: string | undefined,
  filesWritten: string[],
  skippedPages: string[],
  record?: WriteRecorder,
  vfs: VirtualFileSystem = browserVfs,
): Promise<void> {
  for (const path of await vfs.listFilePaths(projectId)) {
    if (!isPage(path) || path === skip) continue;
    let before: string;
    try {
      before = asText((await vfs.readFile(projectId, path)).content);
    } catch {
      continue;
    }
    const linked = ensureOverridesLink(before);
    if (linked.skipped === 'no-head') {
      skippedPages.push(path);
      continue;
    }
    if (linked.changed) {
      await vfs.updateFile(projectId, path, linked.content);
      record?.({ path, before, after: linked.content, silent: false });
      filesWritten.push(path);
    }
  }
}

/** The override stylesheet, written silently: no recompile for a file only frames read. */
async function writeOverrides(
  projectId: string,
  markerId: string,
  scope: OverrideScope,
  changes: readonly StyleChange[],
  filesWritten: string[],
  skippedPages: string[],
  record?: WriteRecorder,
  vfs: VirtualFileSystem = browserVfs,
  strengthen: readonly string[] = [],
): Promise<ApplyResult> {
  try {
    const exists = await vfs.fileExists(projectId, OVERRIDES_PATH);
    const current = exists ? asText((await vfs.readFile(projectId, OVERRIDES_PATH)).content) : '';
    const nextCss = strengthenDeclarations(applyChanges(current, markerId, scope, changes), markerId, strengthen);
    if (!exists && nextCss !== '') {
      await vfs.createFile(projectId, OVERRIDES_PATH, nextCss, { silent: true });
      record?.({ path: OVERRIDES_PATH, before: null, after: nextCss, silent: true });
      filesWritten.push(OVERRIDES_PATH);
    } else if (exists && nextCss !== current) {
      await vfs.updateFile(projectId, OVERRIDES_PATH, nextCss, { silent: true });
      record?.({ path: OVERRIDES_PATH, before: current, after: nextCss, silent: true });
      filesWritten.push(OVERRIDES_PATH);
    }
    return { ok: true, markerId, filesWritten, skippedPages, css: nextCss };
  } catch (error) {
    // `applyChanges` throws rather than guessing which block is ours — the selector found in a
    // comment or nested in an at-rule — and on an unsafe property, value or marker id. A
    // hand-edited stylesheet must reach the user as a message, not an unhandled rejection. Any
    // marker already stamped above stays; an unreferenced marker is inert.
    return {
      ok: false,
      reason: 'ambiguous-stylesheet',
      message: error instanceof Error ? error.message : String(error),
      markerId,
      filesWritten,
    };
  }
}

/** What `/overrides.css` holds for one element: its declarations by scope, and its blocks as text. */
export interface MarkerOverrides {
  byScope: Map<OverrideScope, Record<string, string>>;
  /** The element's blocks as the file has them, for reading. Empty when there are none. */
  text: string;
  /** The widths the file has managed blocks for, widest first. */
  widths: number[];
}

/** Reads one element's overrides, so dots and Reset survive a reload. Any failure reads as none. */
export async function readMarkerOverrides(
  projectId: string,
  markerId: string,
  vfs: VirtualFileSystem = browserVfs,
): Promise<MarkerOverrides> {
  const none: MarkerOverrides = { byScope: new Map(), text: '', widths: [] };
  try {
    if (!(await vfs.fileExists(projectId, OVERRIDES_PATH))) return none;
    const css = asText((await vfs.readFile(projectId, OVERRIDES_PATH)).content);
    return { byScope: declaredByScope(css, markerId), text: markerBlocksText(css, markerId), widths: managedWidths(css) };
  } catch {
    return none;
  }
}

/**
 * Removes the blocks of markers no source file has any more: an element deleted or rewritten
 * without its `data-osw-id` leaves its rules behind, where they match nothing. A marker counts as live if its id appears in any project file but
 * `/overrides.css`, scripts and data included. A block the writer cannot place is left alone.
 */
export async function sweepUnusedOverrides(
  projectId: string,
  opts?: { fs?: VirtualFileSystem; record?: WriteRecorder },
): Promise<{ removed: string[]; css: string | null }> {
  const vfs = opts?.fs ?? browserVfs;
  if (!(await vfs.fileExists(projectId, OVERRIDES_PATH))) return { removed: [], css: null };
  const before = asText((await vfs.readFile(projectId, OVERRIDES_PATH)).content);
  const ids = markerIdsIn(before);
  if (ids.length === 0) return { removed: [], css: before };

  const live = new Set<string>();
  for (const path of await vfs.listFilePaths(projectId)) {
    if (path === OVERRIDES_PATH) continue;
    let text: string;
    try {
      const content = (await vfs.readFile(projectId, path)).content;
      if (typeof content !== 'string') continue;
      text = content;
    } catch {
      continue;
    }
    for (const id of ids) if (!live.has(id) && text.includes(id)) live.add(id);
    if (live.size === ids.length) break;
  }

  let css = before;
  const removed: string[] = [];
  for (const id of ids) {
    if (live.has(id)) continue;
    try {
      const next = removeMarkerBlock(css, id);
      if (next !== css) removed.push(id);
      css = next;
    } catch {
      // Ambiguous in this file: a hand edit put the selector somewhere the writer will not touch.
    }
  }
  if (css !== before) {
    await vfs.updateFile(projectId, OVERRIDES_PATH, css, { silent: true });
    opts?.record?.({ path: OVERRIDES_PATH, before, after: css, silent: true });
  }
  return { removed, css };
}
