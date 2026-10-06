import { vfs } from '../index';
import { formatBytes } from './format';
import { validateArchivePath } from './paths';
import { MAX_ENTRIES, MAX_TOTAL_BYTES } from './read-zip';
import { ArchiveError, said } from './text';
import type { ArchiveEntry, ArchiveIssue } from './types';

/**
 * Walk a dropped DataTransfer entry into a flat list of `{file, path}` pairs, where `path`
 * preserves the dropped folder structure under `parentPath`.
 *
 * Uses the webkit entry API because it is the only way to recurse into a dropped directory:
 * `item.getAsFile()` on a folder hands back a zero-byte File carrying the folder's name, which
 * downstream then tries to import as a file of an unrecognized type.
 */
export const collectEntryFiles = async (
  entry: FileSystemEntry | null | undefined,
  parentPath: string
): Promise<Array<{ file: File; path: string }>> => {
  const joinPath = (dir: string, name: string) =>
    dir === '/' ? `/${name}` : `${dir}/${name}`;

  if (entry?.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file: File = await new Promise((resolve, reject) =>
      fileEntry.file(resolve, reject)
    );
    return [{ file, path: joinPath(parentPath, entry.name) }];
  }
  if (entry?.isDirectory) {
    const myPath = joinPath(parentPath, entry.name);
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const results: Array<{ file: File; path: string }> = [];
    // readEntries may return in batches — loop until empty.
    while (true) {
      const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (!batch.length) break;
      for (const child of batch) {
        const sub = await collectEntryFiles(child, myPath);
        results.push(...sub);
      }
    }
    return results;
  }
  return [];
};

// Ensure every ancestor directory in `path` exists. VFS.createFile only
// creates the immediate parent via updateFileTree, which leaves gaps for
// deeply nested uploads like /a/b/c/file.png when /a and /a/b don't exist.
//
// `silent` is passed straight to createDirectory. A caller writing a whole archive in one batch
// suppresses the per-file event and dispatches one of its own at the end; without the same
// suppression here, every new directory would fire `filesChanged` and recompile the preview in
// the middle of the import. Omitted, the per-directory event stays.
export const ensureAncestorDirs = async (
  projectId: string,
  filePath: string,
  options?: { silent?: boolean }
) => {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop(); // drop file name
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    await vfs.createDirectory(projectId, acc, options);
  }
};

export interface FolderEntriesOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
}

export interface FolderEntriesResult {
  entries: ArchiveEntry[];
  /** Paths that could not be accepted. The rest of the drop still reads. */
  issues: ArchiveIssue[];
}

/**
 * Turn the output of `collectEntryFiles` into the same normalized, path-checked entries a zip
 * produces, so nothing downstream has to know which of the two the user gave it.
 *
 * The budgets are the zip reader's, deliberately, even though a folder drop carries none of the
 * threats they were written for: `File.size` comes from the OS rather than an attacker-authored
 * central directory, and nothing here decompresses, so no entry can inflate past what it claims.
 * They stay because downstream — the analyzer, the preview, apply — reads whatever it is handed
 * and cannot tell the sources apart; leaving one path unbounded would mean the bound downstream
 * relies on simply does not hold half the time. The realistic case is a user dropping a project
 * folder with `node_modules` in it, and refusing 60,000 files by name is more useful than
 * grinding through them.
 *
 * Because the sizes are trustworthy, one up-front sum settles the byte budget — there is no need
 * for the zip reader's per-chunk running total, which exists only because a declared size is a
 * claim and not a fact.
 */
export function folderToArchiveEntries(
  collected: Array<{ file: File; path: string }>,
  options?: FolderEntriesOptions
): FolderEntriesResult {
  const maxEntries = options?.maxEntries ?? MAX_ENTRIES;
  const maxTotalBytes = options?.maxTotalBytes ?? MAX_TOTAL_BYTES;

  // Counted before any path is judged, matching the zip reader: a budget exists to refuse the
  // input, and filtering it down first would be the work the budget is meant to avoid.
  if (collected.length > maxEntries) {
    throw new ArchiveError('folderTooManyFiles', { count: collected.length, max: maxEntries });
  }

  let totalBytes = 0;
  for (const { file } of collected) totalBytes += file.size;
  if (totalBytes > maxTotalBytes) {
    throw new ArchiveError('folderTooLarge', { limit: formatBytes(maxTotalBytes) });
  }

  const entries: ArchiveEntry[] = [];
  const issues: ArchiveIssue[] = [];
  const claimed = new Set<string>();

  for (const { file, path } of collected) {
    // No `unsafeOriginalName`: these names come from the browser's entry API a segment at a time,
    // so there is no stored string a '..' could have survived in.
    const result = validateArchivePath(path);
    if (!result.ok) {
      issues.push({ path, code: result.code, message: result.message, text: result.text });
      continue;
    }

    // Two collected paths can still normalize to one: the entry API walk yields '/a.txt' while the
    // no-entry-API fallback yields 'a.txt' for the same drop, and a drop may mix both. Downstream
    // keys files by path, so a second entry would shadow whatever the preview classified for the
    // first. First one wins, deterministically, and the loser is reported rather than vanishing.
    if (claimed.has(result.path)) {
      issues.push({
        path: result.path,
        code: 'path-rejected',
        ...said('duplicateInFolder'),
      });
      continue;
    }
    claimed.add(result.path);

    entries.push({
      path: result.path,
      declaredSize: file.size,
      modifiedAt: file.lastModified ? new Date(file.lastModified) : undefined,
      read: () => file.arrayBuffer(),
    });
  }

  return { entries, issues };
}
