/**
 * Rewrites the `src` attribute at the provenance index (`data-osw-src`).
 * Source write (not silent) — the recompile it triggers refreshes stale provenance indices.
 */

import { vfs } from '@/lib/vfs';
import { readOpenTagAt } from '@/lib/preview/provenance';
import { countAttributeIn, findAttributeIn } from './attributes';
import { resolveSelection } from './resolution';
import type { ApplyResult, PreviewSelection, WriteRecorder } from './types';
import { asText } from '@/lib/vfs/as-text';

/** The attribute an image is replaced through. */
const SRC_ATTR = 'src';

export type ReplaceSrcResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'no-src' | 'expression-src' | 'not-a-tag' };

/**
 * Escape a value so it cannot terminate the attribute it is written into.
 *
 * Both quote characters, regardless of which one the tag actually uses, so the result is safe in
 * either — the caller preserves the author's quoting and must not have to think about it. `&` goes
 * first, since escaping it after the others would double-escape the entities they just introduced.
 *
 * No VFS path realistically contains any of these; the escape exists so that one which does
 * produces a correct attribute rather than a broken tag.
 */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rewrite the `src` of the open tag at `index`.
 *
 * The same splice `stampMarker` performs, on a different attribute: read the one tag, find the
 * attribute inside it, replace that span. Nothing outside `[index, tagEnd)` is touched, so a
 * self-closing `<img/>` needs no special case — `/` is skipped as it is scanned past, and the value
 * span sits before it either way.
 *
 * **`expression-src` is a refusal, not a fallback.** A `src` holding `{{ }}` is computed by the
 * template, so overwriting the literal does two wrong things at once: it writes a path that is not
 * what renders, and it destroys the binding that was producing the real one.
 *
 * `not-a-tag` is the stale-index signal, the same as `stampMarker`'s throw — reported rather than
 * thrown because every caller here has a banner to put it in.
 */
export function replaceSrcAt(content: string, index: number, nextSrc: string): ReplaceSrcResult {
  const tag = readOpenTagAt(content, index);
  if (!tag) return { ok: false, reason: 'not-a-tag' };

  const span = findAttributeIn(content, tag, SRC_ATTR);
  if (!span) return { ok: false, reason: 'no-src' };
  if (span.value.includes('{{')) return { ok: false, reason: 'expression-src' };
  // Two `src` literals in one tag is the template choosing between them
  // (`{{#if hero}}src="a.png"{{else}}src="b.png"{{/if}}`). Which one produced the element the user
  // selected is not knowable from the source, and rewriting the first would silently edit the branch
  // they are not looking at — so this refuses for the same reason a `{{ }}` value does.
  if (countAttributeIn(content, tag, SRC_ATTR) > 1) return { ok: false, reason: 'expression-src' };

  const quote = span.quote ?? '"';
  let start = span.valueStart;
  let end = span.valueEnd;
  if (span.quote) {
    start -= 1;
    // A truncated tag ends the value at the tag end with no closing quote to consume. Widening past
    // it unconditionally would eat the `>`.
    if (content[end] === span.quote) end += 1;
  }

  return {
    ok: true,
    content: content.slice(0, start) + quote + escapeAttributeValue(nextSrc) + quote + content.slice(end),
  };
}

/**
 * Point the selected image at `nextSrc`, durably.
 *
 * `confirmedMultiInstance` is required when the tag renders more than once (e.g. inside `{{#each}}`
 * or a twice-included partial).
 *
 * `isGenerating` is injected to keep `lib/direct-edit/` free of store imports.
 */
export async function applyImageSrc(
  projectId: string,
  selection: PreviewSelection,
  nextSrc: string,
  opts?: { confirmedMultiInstance?: boolean; isGenerating?: () => boolean; record?: WriteRecorder },
): Promise<ApplyResult> {
  // A write landing mid-generation races the agent's own edits over the same files.
  if (opts?.isGenerating?.()) return { ok: false, reason: 'generating', filesWritten: [] };

  const resolution = resolveSelection(selection);
  if (resolution.kind === 'unresolvable') {
    return { ok: false, reason: 'unresolvable', filesWritten: [] };
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

  const file = resolution.file;

  let original: string;
  try {
    original = asText((await vfs.readFile(projectId, file)).content);
  } catch {
    return { ok: false, reason: 'missing-file', file, filesWritten: [] };
  }

  // A stale `tagStart` usually still lands on *some* valid open tag, which would pass a `<`-plus-
  // letter check and rewrite the `src` of an unrelated element permanently. The tag name is what
  // narrows it.
  const tag = readOpenTagAt(original, resolution.tagStart);
  if (!tag || (selection.tagName && tag.tagName !== selection.tagName.toLowerCase())) {
    return { ok: false, reason: 'stale-index', file, filesWritten: [] };
  }

  const rewrite = replaceSrcAt(original, resolution.tagStart, nextSrc);
  if (!rewrite.ok) {
    // `not-a-tag` cannot arrive here — the check above already read the tag — but it is mapped
    // rather than assumed away, and `stale-index` is what it would mean.
    if (rewrite.reason === 'not-a-tag') return { ok: false, reason: 'stale-index', file, filesWritten: [] };
    return { ok: false, reason: rewrite.reason, file, filesWritten: [] };
  }

  // Identical content is not written. The write is what forces the recompile, and a recompile that
  // changes nothing costs the user their toolbar and their scroll position for no reason.
  if (rewrite.content === original) return { ok: true, filesWritten: [] };

  await vfs.updateFile(projectId, file, rewrite.content);
  opts?.record?.({ path: file, before: original, after: rewrite.content, silent: false });
  return { ok: true, file, filesWritten: [file] };
}
