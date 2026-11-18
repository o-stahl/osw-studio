/**
 * Structural edits from Canvas and the Elements tab: the write.
 *
 * Resolves the element the frame named (`data-osw-src`), checks the file still has it there, runs
 * the edit from `structure.ts` and writes it: the page or partial (not silent, so the frames
 * recompile) and, for a wrap, an insert or a duplicate, `/overrides.css` (silent) with the new
 * element's starting styles or the copy's blocks. One journal group for all of it. A Semantic
 * block's placeholder is an insert with no starting styles (the preview frames give it its look),
 * so it writes the page alone.
 *
 * The result names the element to select afterwards and, where the frames can show the edit before
 * the recompile does, the patch that lets them (`StructurePatch`).
 */

import { vfs } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { readOpenTagAt } from '@/lib/preview/provenance';
import { parseSrc, resolveSelection } from './resolution';
import { MARKER_ATTR, newMarkerId } from './marker';
import { applyChanges, declaredByScope, importantProperties, strengthenDeclarations, type OverrideScope } from './overrides-css';
import { ensureOverridesLink } from './link-invariant';
import { OVERRIDES_PATH, isPage, linkOverridesEverywhere } from './apply-style';
import {
  FRAME_ATTR,
  duplicateElement,
  insertElement,
  mapOffset,
  moveElement,
  removeElement,
  siblingsOf,
  unwrapElement,
  wrapElement,
  type Piece,
  type Place,
  type StructureResult,
} from './structure';
import type { ApplyResult, PreviewSelection, StyleChange, WriteRecorder } from './types';
import { getBlockById } from '@/lib/semantic-blocks/registry';
import { escapeText, isPlacementId, placeholderMarkup } from '@/lib/semantic-blocks/placeholder';
import type { StructurePatchOp, StructurePlace } from '@/lib/preview/types';

export type InsertKind = 'frame' | 'text' | 'image' | 'button' | 'divider';

export type StructureOp =
  | { kind: 'move'; place: StructurePlace }
  /** Past the previous (-1) or next (1) element of the same parent in the file. */
  | { kind: 'step'; dir: -1 | 1 }
  | { kind: 'wrap' }
  | { kind: 'unwrap' }
  | { kind: 'duplicate' }
  | { kind: 'delete' }
  /** `text` is what a new Text or Button says. */
  | { kind: 'insert'; place: StructurePlace; element: InsertKind; text?: string }
  /** A Semantic block's placeholder (`lib/semantic-blocks/placement.ts`). */
  | { kind: 'block'; place: StructurePlace; block: string; placementId: string };

type PatchOp = StructurePatchOp;

export interface StructurePatch {
  file: string;
  /** Old offsets of `file` to new (see `Piece`). */
  pieces: Piece[];
  op: PatchOp;
  /** New offsets of the elements the edit made, in document order. */
  created: number[];
}

export interface StructureApplyResult extends ApplyResult {
  /** `data-osw-src` of the element to select afterwards; `null` when nothing is. */
  select?: string | null;
  /** How the frames show the edit before the recompile; absent when they wait for it. */
  patch?: StructurePatch;
}

/** A new frame and a wrap: a column with room in it, visible while empty. */
const FRAME_STYLES: Record<string, string> = {
  display: 'flex',
  'flex-direction': 'column',
  gap: '12px',
  padding: '20px',
  'min-height': '72px',
  'background-color': 'rgb(127 127 127 / 0.08)',
  'border-radius': '12px',
};
const WRAP_STYLES: Record<string, string> = { display: 'flex', 'flex-direction': 'column', gap: '12px' };
const IMAGE_STYLES: Record<string, string> = {
  display: 'block',
  width: '100%',
  'aspect-ratio': '4 / 3',
  'object-fit': 'cover',
  'border-radius': '12px',
};
/** For a project with no `.btn` of its own. */
const BUTTON_STYLES: Record<string, string> = {
  display: 'inline-block',
  padding: '10px 18px',
  'border-radius': '8px',
  'background-color': 'rgb(127 127 127 / 0.15)',
  color: 'inherit',
  'text-decoration': 'none',
};
const DIVIDER_STYLES: Record<string, string> = {
  border: '0',
  'border-top': '1px solid rgb(127 127 127 / 0.35)',
  width: '100%',
  margin: '8px 0',
};

/** A new image until one is picked: grey ground, a mountain and a sun. */
const PLACEHOLDER_IMAGE ="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 90'%3E%3Crect width='120' height='90' fill='%23e5e7eb'/%3E%3Cpath d='M18 72l26-30 18 20 12-12 28 22z' fill='%239ca3af'/%3E%3Ccircle cx='84' cy='28' r='9' fill='%239ca3af'/%3E%3C/svg%3E";

/** The markup an insert writes, and the starting styles its marker gets. */
export function insertMarkup(
  kind: InsertKind,
  opts: { text?: string; projectHasBtn?: boolean; markerId?: string },
): { markup: string; styles: Record<string, string> | null; marker: string | null } {
  const marker = opts.markerId ?? newMarkerId();
  const id = `${MARKER_ATTR}="${marker}"`;
  switch (kind) {
    case 'frame':
      return { markup: `<div ${FRAME_ATTR} ${id}></div>`, styles: FRAME_STYLES, marker };
    case 'text':
      return { markup: `<p>${escapeText(opts.text || 'Text')}</p>`, styles: null, marker: null };
    case 'image':
      return { markup: `<img ${id} src="${PLACEHOLDER_IMAGE}" alt="">`, styles: IMAGE_STYLES, marker };
    case 'button':
      return opts.projectHasBtn
        ? { markup: `<a class="btn" href="#">${escapeText(opts.text || 'Button')}</a>`, styles: null, marker: null }
        : { markup: `<a class="btn" ${id} href="#">${escapeText(opts.text || 'Button')}</a>`, styles: BUTTON_STYLES, marker };
    case 'divider':
      return { markup: `<hr ${id}>`, styles: DIVIDER_STYLES, marker };
  }
}

/** The place as offsets in `file`, or why it cannot be one. */
function placeIn(place: StructurePlace, file: string): Place | 'cross-file' | 'unresolvable' {
  const src = 'before' in place ? place.before : 'after' in place ? place.after : place.parent;
  const parts = parseSrc(src);
  if (!parts) return 'unresolvable';
  if (parts[0] !== file) return 'cross-file';
  if ('before' in place) return { before: parts[1] };
  if ('after' in place) return { after: parts[1] };
  return { parent: parts[1], at: place.at };
}

const fileOfPlace = (place: StructurePlace) =>
  parseSrc('before' in place ? place.before : 'after' in place ? place.after : place.parent)?.[0] ?? null;

/**
 * `first` then `second`, as one map from the oldest offsets to the newest. Both are piece lists over
 * the content before them; the result keeps what both kept.
 */
export function composePieces(first: readonly Piece[], second: readonly Piece[]): Piece[] {
  const spans: { from: number; to: number; piece: Piece }[] = [];
  let at = 0;
  for (const piece of first) {
    const length = typeof piece === 'number' ? piece : piece[1] - piece[0];
    spans.push({ from: at, to: at + length, piece });
    at += length;
  }
  const out: Piece[] = [];
  for (const piece of second) {
    if (typeof piece === 'number') { out.push(piece); continue; }
    for (const span of spans) {
      const from = Math.max(span.from, piece[0]);
      const to = Math.min(span.to, piece[1]);
      if (to <= from) continue;
      out.push(typeof span.piece === 'number'
        ? to - from
        : [span.piece[0] + from - span.from, span.piece[0] + to - span.from]);
    }
  }
  return out;
}

/** The pieces of a pure insertion: what `after` adds to `before` at the first place they differ. */
function insertionPieces(before: string, after: string): Piece[] {
  let p = 0;
  while (p < before.length && before[p] === after[p]) p++;
  return [[0, p], after.length - before.length, [p, before.length]];
}

/** Does any of the project's stylesheets give `.name` a rule? */
async function projectHasClass(projectId: string, name: string): Promise<boolean> {
  const rule = new RegExp(`\\.${name}(?![\\w-])`);
  for (const path of await vfs.listFilePaths(projectId)) {
    if (!/\.css$/i.test(path) || path === OVERRIDES_PATH) continue;
    try {
      if (rule.test(asText((await vfs.readFile(projectId, path)).content))) return true;
    } catch {
      // Unreadable: not evidence either way.
    }
  }
  return false;
}

/** Every marker in `markup` and the fresh one its copy gets, with the copy's markup. */
function freshMarkers(markup: string, ids: Record<string, string>): string {
  return markup.replace(/(data-osw-id\s*=\s*)(["'])([A-Za-z0-9_-]+)\2/g, (_m, lead: string, quote: string, old: string) => {
    ids[old] ??= newMarkerId();
    return `${lead}${quote}${ids[old]}${quote}`;
  });
}

const refuse = (reason: NonNullable<ApplyResult['reason']>, file?: string): StructureApplyResult =>
  ({ ok: false, reason, file, filesWritten: [] });

/**
 * One structural edit, written.
 *
 * `selection` is the element the edit is about (not read for an insert or a block). `confirmed` is
 * required for an element in `/templates/` (a partial every page that includes it shares) or one
 * rendered several times. An edit to one rendered several times shows after the recompile, without
 * a patch: a frame finds an element by its `data-osw-src`, which every copy shares. `instances` is
 * how many times an insert's place renders, which the frame knows and the file does not.
 */
export async function applyStructure(
  projectId: string,
  selection: PreviewSelection | null,
  op: StructureOp,
  opts: {
    confirmed?: boolean;
    instances?: number;
    isGenerating?: () => boolean;
    record?: WriteRecorder;
  } = {},
): Promise<StructureApplyResult> {
  if (opts.isGenerating?.()) return refuse('generating');

  let file: string;
  let tagStart: number | null = null;
  let instances = opts.instances ?? 1;
  let target = '';
  if (op.kind === 'insert' || op.kind === 'block') {
    const placeFile = fileOfPlace(op.place);
    if (!placeFile) return refuse('unresolvable');
    file = placeFile;
  } else {
    const resolution = resolveSelection(selection ?? {});
    if (resolution.kind === 'unresolvable') return refuse('unresolvable');
    file = resolution.file;
    tagStart = resolution.tagStart;
    instances = resolution.kind === 'one-to-many' ? resolution.instances : 1;
    target = `${file}:${tagStart}`;
  }
  if (!opts.confirmed && (file.startsWith('/templates/') || instances > 1)) {
    return { ok: false, reason: 'needs-confirmation', file, instances, filesWritten: [] };
  }

  let content: string;
  try {
    content = asText((await vfs.readFile(projectId, file)).content);
  } catch {
    return refuse('missing-file', file);
  }
  if (tagStart !== null) {
    const tag = readOpenTagAt(content, tagStart);
    if (!tag || (selection?.tagName && tag.tagName !== selection.tagName.toLowerCase())) return refuse('stale-index', file);
  }

  let result: StructureResult;
  let patchOp: PatchOp;
  /** Override blocks the edit adds: marker → changes by scope. */
  const blocks: { marker: string; scope: OverrideScope; changes: StyleChange[] }[] = [];
  /** A copy's properties that its original has marked `!important`: the copy needs the mark to look the same. */
  const strong: { marker: string; properties: string[] }[] = [];
  const asChanges = (styles: Record<string, string>) => Object.entries(styles).map(([property, value]) => ({ property, value }));

  switch (op.kind) {
    case 'move': {
      const place = placeIn(op.place, file);
      if (typeof place === 'string') return refuse(place, file);
      result = moveElement(content, tagStart!, place);
      patchOp = { kind: 'move', target, place: op.place };
      break;
    }
    case 'step': {
      const around = siblingsOf(content, tagStart!);
      const past = op.dir < 0 ? around.previous : around.next;
      if (past === null) return refuse('no-place', file);
      const place: StructurePlace = op.dir < 0 ? { before: `${file}:${past}` } : { after: `${file}:${past}` };
      result = moveElement(content, tagStart!, op.dir < 0 ? { before: past } : { after: past });
      patchOp = { kind: 'move', target, place };
      break;
    }
    case 'delete':
      result = removeElement(content, tagStart!);
      patchOp = { kind: 'delete', target };
      break;
    case 'unwrap':
      result = unwrapElement(content, tagStart!);
      patchOp = { kind: 'unwrap', target };
      break;
    case 'wrap': {
      const marker = newMarkerId();
      const open = `<div ${FRAME_ATTR} ${MARKER_ATTR}="${marker}">`;
      result = wrapElement(content, tagStart!, open, '</div>');
      blocks.push({ marker, scope: 'all', changes: asChanges(WRAP_STYLES) });
      patchOp = { kind: 'wrap', target, html: `${open}</div>` };
      break;
    }
    case 'duplicate': {
      // No prototype: a marker may be called `constructor` or `__proto__`.
      const ids: Record<string, string> = Object.create(null);
      result = duplicateElement(content, tagStart!, markup => freshMarkers(markup, ids));
      if (result.ok && Object.keys(ids).length) {
        let css = '';
        try {
          css = (await vfs.fileExists(projectId, OVERRIDES_PATH)) ? asText((await vfs.readFile(projectId, OVERRIDES_PATH)).content) : '';
        } catch {
          css = '';
        }
        try {
          for (const [old, fresh] of Object.entries(ids)) {
            for (const [scope, declared] of declaredByScope(css, old)) {
              blocks.push({ marker: fresh, scope, changes: asChanges(declared) });
            }
            const marked = importantProperties(css, old);
            if (marked.length) strong.push({ marker: fresh, properties: marked });
          }
        } catch (error) {
          return { ...refuse('ambiguous-stylesheet', OVERRIDES_PATH), message: error instanceof Error ? error.message : String(error) };
        }
      }
      patchOp = { kind: 'duplicate', target, ids };
      break;
    }
    case 'insert': {
      const place = placeIn(op.place, file);
      if (typeof place === 'string') return refuse(place, file);
      const projectHasBtn = op.element === 'button' ? await projectHasClass(projectId, 'btn') : false;
      const made = insertMarkup(op.element, { text: op.text, projectHasBtn });
      result = insertElement(content, place, made.markup);
      if (made.styles && made.marker) blocks.push({ marker: made.marker, scope: 'all', changes: asChanges(made.styles) });
      patchOp = { kind: 'insert', place: op.place, html: made.markup };
      break;
    }
    case 'block': {
      const place = placeIn(op.place, file);
      if (typeof place === 'string') return refuse(place, file);
      const block = getBlockById(op.block);
      if (!block || !isPlacementId(op.placementId)) return refuse('unresolvable', file);
      const markup = placeholderMarkup(block, op.placementId);
      result = insertElement(content, place, markup);
      patchOp = { kind: 'insert', place: op.place, html: markup };
      break;
    }
  }
  if (!result.ok) return refuse(result.reason, file);
  const edit = result.edit;
  if (edit.content === content) return { ok: true, filesWritten: [], file, select: tagStart === null ? null : target };

  const filesWritten: string[] = [];
  const skippedPages: string[] = [];
  let css: string | undefined;
  let next = edit.content;
  let pieces = edit.pieces;
  let select = edit.select;
  let created = edit.created;

  if (blocks.length) {
    // `/overrides.css` first and silently, so the recompile the page write starts already has it.
    let current = '';
    let exists = false;
    try {
      exists = await vfs.fileExists(projectId, OVERRIDES_PATH);
      current = exists ? asText((await vfs.readFile(projectId, OVERRIDES_PATH)).content) : '';
      let nextCss = current;
      for (const block of blocks) nextCss = applyChanges(nextCss, block.marker, block.scope, block.changes);
      for (const { marker, properties } of strong) nextCss = strengthenDeclarations(nextCss, marker, properties);
      if (nextCss !== current) {
        if (exists) await vfs.updateFile(projectId, OVERRIDES_PATH, nextCss, { silent: true });
        else await vfs.createFile(projectId, OVERRIDES_PATH, nextCss, { silent: true });
        opts.record?.({ path: OVERRIDES_PATH, before: exists ? current : null, after: nextCss, silent: true });
        filesWritten.push(OVERRIDES_PATH);
      }
      css = nextCss;
    } catch (error) {
      return { ...refuse('ambiguous-stylesheet', OVERRIDES_PATH), message: error instanceof Error ? error.message : String(error) };
    }
    if (isPage(file)) {
      const linked = ensureOverridesLink(next);
      if (linked.skipped === 'no-head') skippedPages.push(file);
      else if (linked.changed) {
        const added = insertionPieces(next, linked.content);
        pieces = composePieces(pieces, added);
        const shift = (offset: number) => mapOffset(added, offset) ?? offset;
        select = select === null ? null : shift(select);
        created = created.map(shift);
        next = linked.content;
      }
    }
  }

  await vfs.updateFile(projectId, file, next);
  opts.record?.({ path: file, before: content, after: next, silent: false });
  filesWritten.push(file);
  if (blocks.length) await linkOverridesEverywhere(projectId, isPage(file) ? file : undefined, filesWritten, skippedPages, opts.record);

  return {
    ok: true,
    file,
    filesWritten,
    skippedPages,
    css,
    select: select === null ? null : `${file}:${select}`,
    patch: instances > 1 ? undefined : { file, pieces, op: patchOp, created },
  };
}
