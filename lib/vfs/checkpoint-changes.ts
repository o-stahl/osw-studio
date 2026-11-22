/**
 * How much changed between two checkpoints of a project: files added, removed or edited, and the
 * lines going in and out of text files.
 *
 * Lines are compared as a count of each distinct line on either side rather than by a diff, so the
 * cost stays linear in the size of the files. A block moved within a file counts as its lines out
 * and in again, close to what a line diff reports for ordinary edits.
 */

export interface CheckpointChanges {
  /** Files added, removed or edited. */
  files: number;
  /** Lines in text files that are new. */
  added: number;
  /** Lines in text files that went. */
  removed: number;
}

/**
 * A checkpoint's files as compared: the text of each text file, and for a binary file its length
 * and a fingerprint, which avoids keeping a copy of every image in memory.
 */
export type FileIndex = Map<string, string | { length: number; print: number }>;

/** Binary data is fingerprinted from at most this many of its characters, spread across it. */
const PRINT_SAMPLES = 1 << 20;

function fingerprint(data: string): number {
  const step = Math.max(1, Math.floor(data.length / PRINT_SAMPLES));
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += step) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // The last stretch, which a stride can step over.
  for (let i = Math.max(0, data.length - 64); i < data.length; i++) {
    hash ^= data.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function indexFiles(files: Map<string, string | { data: string; encoding?: 'base64' }>): FileIndex {
  const index: FileIndex = new Map();
  for (const [path, content] of files) {
    index.set(path, typeof content === 'string' ? content : { length: content.data.length, print: fingerprint(content.data) });
  }
  return index;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** A final newline ends the last line rather than starting another. */
function lineTotal(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function compareFiles(before: FileIndex, after: FileIndex): CheckpointChanges {
  const changes: CheckpointChanges = { files: 0, added: 0, removed: 0 };
  for (const [path, now] of after) {
    const then = before.get(path);
    if (then === undefined) {
      changes.files++;
      if (typeof now === 'string') changes.added += lineTotal(now);
      continue;
    }
    if (typeof now === 'string' && typeof then === 'string') {
      if (now === then) continue;
      changes.files++;
      const old = lineCounts(then);
      const fresh = lineCounts(now);
      for (const [line, count] of fresh) changes.added += Math.max(0, count - (old.get(line) ?? 0));
      for (const [line, count] of old) changes.removed += Math.max(0, count - (fresh.get(line) ?? 0));
      continue;
    }
    if (typeof now !== 'string' && typeof then !== 'string' && now.length === then.length && now.print === then.print) continue;
    // A binary file edited, or a file that turned from text to binary or back.
    changes.files++;
    if (typeof then === 'string') changes.removed += lineTotal(then);
    if (typeof now === 'string') changes.added += lineTotal(now);
  }
  for (const [path, then] of before) {
    if (after.has(path)) continue;
    changes.files++;
    if (typeof then === 'string') changes.removed += lineTotal(then);
  }
  return changes;
}
