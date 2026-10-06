import JSZip from 'jszip';
import { formatBytes } from './format';
import { validateArchivePath } from './paths';
import { ArchiveError, said } from './text';
import type { ArchiveEntry, ArchiveIssue } from './types';

/**
 * Budgets for a single archive. Absolute, never a compression ratio: a legitimate 500 KB
 * repetitive file compresses roughly 1000:1, so any ratio threshold tuned to catch bombs also
 * rejects ordinary large SVG, JSON and CSV.
 */
export const MAX_ENTRIES = 5000;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/**
 * Ceiling on the compressed file as it arrives, before anything parses it.
 *
 * The same number as the uncompressed budget, which is not a coincidence: real content cannot
 * compress to more than its own size, so a zip bigger than this either unpacks past
 * MAX_TOTAL_BYTES anyway or is mostly headers — and a flood of headers is the case this exists
 * for, since loadAsync reads the entire central directory before MAX_ENTRIES can say anything.
 */
export const MAX_FILE_SIZE = MAX_TOTAL_BYTES;

export interface ReadZipOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  /** Ceiling on the compressed input. A caller may tighten it; the default stands on its own. */
  maxFileSize?: number;
  /**
   * Whether the sizes the archive declares may be used. They come from the central directory,
   * which whoever built the archive wrote, so they are a hint and never a guarantee. Turning this
   * off leaves only the running total during `read()` — which is what actually has to hold, so the
   * tests exercise it on its own.
   */
  trustDeclaredSizes?: boolean;
}

export interface ReadZipResult {
  entries: ArchiveEntry[];
  /** Entries that could not be accepted. The rest of the archive still reads. */
  issues: ArchiveIssue[];
}

/**
 * Turn a user-supplied zip into normalized, path-checked entries.
 *
 * This is the import path's security boundary: everything downstream treats an `ArchiveEntry.path`
 * as safe to write and an entry's bytes as bounded, and neither is true of anything else in a zip.
 *
 * A bad path is an issue and skips one entry; a blown budget throws, because there is no sensible
 * partial import of an archive that is trying to exhaust memory.
 */
export async function readZipArchive(file: File, options?: ReadZipOptions): Promise<ReadZipResult> {
  const maxEntries = options?.maxEntries ?? MAX_ENTRIES;
  const maxTotalBytes = options?.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const trustDeclaredSizes = options?.trustDeclaredSizes ?? true;
  const maxFileSize = options?.maxFileSize ?? MAX_FILE_SIZE;

  // First, and before the bytes are read: every other budget here runs after loadAsync has already
  // parsed the whole central directory, so this is the only guard that can precede a header flood.
  if (file.size > maxFileSize) {
    throw new ArchiveError('zipTooLarge', { limit: formatBytes(maxFileSize) });
  }

  const zip = await loadZip(file);

  // Directory entries carry no content and no path a file could be written to. They also appear
  // for parents that were never stored — a traversal name resolves to a bare '/' folder entry.
  const fileEntries = Object.values(zip.files).filter((entry) => !entry.dir);

  if (fileEntries.length > maxEntries) {
    throw new ArchiveError('zipTooManyEntries', { count: fileEntries.length, max: maxEntries });
  }

  if (trustDeclaredSizes) {
    // Only ever grounds to refuse, never grounds to accept: an archive that under-declares passes
    // here and is stopped by the running total below.
    let declaredTotal = 0;
    for (const entry of fileEntries) declaredTotal += declaredSizeOf(entry) ?? 0;
    if (declaredTotal > maxTotalBytes) throw budgetExceeded(maxTotalBytes);
  }

  const issues: ArchiveIssue[] = [];
  const entries: ArchiveEntry[] = [];
  // Shared across every entry: the budget is for the archive, not for one file at a time.
  let totalBytes = 0;
  const claimed = new Set<string>();

  for (const entry of fileEntries) {
    const result = validateArchivePath(entry.name, entry.unsafeOriginalName);
    if (!result.ok) {
      // The name as stored, so the user recognizes it. `entry.name` has already had the traversal
      // resolved out of it, and reporting `evil.txt` for `../../evil.txt` hides the reason.
      issues.push({
        path: entry.unsafeOriginalName ?? entry.name,
        code: result.code,
        message: result.message,
        text: result.text,
      });
      continue;
    }

    // Distinct stored names can still land on one path: loadAsync resolves '/a.txt' to '/a.txt'
    // and leaves 'a.txt' alone, so both reach here as separate entries. Downstream keys files by
    // path, so a second entry would shadow whatever the preview classified for the first — the
    // user approves one file's contents and applies another's. First one wins, deterministically.
    if (claimed.has(result.path)) {
      issues.push({
        path: result.path,
        code: 'path-rejected',
        ...said('duplicateInArchive'),
      });
      continue;
    }
    claimed.add(result.path);

    const declaredSize = trustDeclaredSizes ? declaredSizeOf(entry) : undefined;
    // What a previous read of this same entry added, so re-reading is not charged twice.
    let charged = 0;

    entries.push({
      path: result.path,
      declaredSize,
      // DOS dates have 2-second resolution and no timezone, so this is only ever good enough to
      // show beside a conflict — never to decide one.
      modifiedAt: entry.date instanceof Date && !Number.isNaN(entry.date.getTime())
        ? entry.date
        : undefined,
      read: () => {
        // Re-reading the same entry re-streams the same bytes, so refund the previous pass first
        // rather than charging the archive twice for one file.
        totalBytes -= charged;
        charged = 0;
        return readEntry(
          entry,
          (chunkLength) => {
            totalBytes += chunkLength;
            charged += chunkLength;
            return totalBytes <= maxTotalBytes;
          },
          maxTotalBytes
        );
      },
    });
  }

  return { entries, issues };
}

async function loadZip(file: File): Promise<JSZip> {
  // Read the bytes here rather than handing JSZip the File: its Blob reader needs FileReader,
  // which does not exist outside a browser.
  const buffer = await file.arrayBuffer();
  try {
    return await JSZip.loadAsync(buffer);
  } catch (error) {
    // JSZip's own wording is the useful part — it names a corrupt central directory or an
    // encrypted archive, which is what the user has to act on.
    const detail = error instanceof Error ? error.message : String(error);
    throw new ArchiveError('notZip', { detail });
  }
}

/**
 * Decompress one entry, checking the budget as the bytes arrive.
 *
 * Streamed rather than `entry.async('arraybuffer')` on purpose: the declared size is
 * attacker-controlled, so a bomb can claim eight bytes and inflate to gigabytes. Buffering first
 * and checking after would have already spent the memory the check exists to protect.
 */
async function readEntry(
  entry: JSZip.JSZipObject,
  charge: (chunkLength: number) => boolean,
  maxTotalBytes: number
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    const stream = internalStreamOf(entry);
    stream.on('data', (chunk) => {
      if (stopped) return;
      const withinBudget = charge(chunk.length);
      if (!withinBudget) {
        stopped = true;
        stream.pause();
        // Drop what was accumulated: holding it while the caller unwinds is the cost this whole
        // path exists to avoid.
        chunks.length = 0;
        reject(budgetExceeded(maxTotalBytes));
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.resume();
  });

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes.buffer;
}

/**
 * `internalStream` is part of JSZip's documented ZipObject API but absent from its typings, which
 * only describe `async` and the Node-only `nodeStream`.
 */
function internalStreamOf(entry: JSZip.JSZipObject): JSZip.JSZipStreamHelper<Uint8Array> {
  return (
    entry as unknown as {
      internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
    }
  ).internalStream('uint8array');
}

/**
 * The uncompressed size recorded for a loaded entry. It lives on `_data`, a private field whose
 * interface the typings deliberately keep commented out, so an absent value means unknown — never
 * zero.
 */
function declaredSizeOf(entry: JSZip.JSZipObject): number | undefined {
  const size = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data
    ?.uncompressedSize;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  return size;
}

function budgetExceeded(maxTotalBytes: number): Error {
  return new ArchiveError('unpackedTooLarge', { limit: formatBytes(maxTotalBytes) });
}
