/**
 * Shared plumbing for the shell's command handlers.
 *
 * These were module-private helpers inside cli-shell's 2300-line switch. They take everything
 * they need as arguments — no closure over the dispatcher — so each command could move into its
 * own file without untangling anything.
 */

import { VirtualFileSystem } from '../index';
import { getFileTypeFromPath, type FileType } from '../types';
import type { ShellContext, ShellResult } from './types';
import { normalizePath } from './paths';

const TRUNCATE_CHARS = 100_000;

/** File types whose content is bytes, which a redirect cannot write. */
const BYTE_FORMATS: ReadonlySet<FileType> = new Set<FileType>(['image', 'video', 'audio', 'font']);

export function truncate(out: string): string {
  if (out.length <= TRUNCATE_CHARS) return out;
  return out.slice(0, TRUNCATE_CHARS) + `\n\n… [${out.length - TRUNCATE_CHARS} chars truncated] …`;
}

export { normalizePath };

export async function ensureDirectory(vfs: VirtualFileSystem, projectId: string, path: string) {
  if (path === '/' || !path) return;
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (let i = 0; i < parts.length; i++) {
    cur = '/' + parts.slice(0, i + 1).join('/');
    try {
      // relies on createDirectory being idempotent
      await vfs.createDirectory(projectId, cur);
    } catch {
      // ignore
    }
  }
}

/**
 * Apply redirect: write stdout to file (> = overwrite, >> = append)
 */
async function writeRedirect(
  vfs: VirtualFileSystem,
  projectId: string,
  content: string,
  redirect: { file: string; append: boolean }
): Promise<ShellResult> {
  const path = normalizePath(redirect.file);
  if (!path) return { stdout: '', stderr: 'redirect: missing file path', exitCode: 2 };

  // Everything a redirect writes is text, so an image, font, audio or video file written this way
  // is stored as characters and comes out broken, with nothing to say so. Refused instead. Only the
  // named byte formats: a name with no extension falls back to 'binary' and is usually text.
  const type = getFileTypeFromPath(path);
  if (BYTE_FORMATS.has(type)) {
    return {
      stdout: '',
      stderr: `redirect: ${path}: ${type} files hold bytes and the shell writes text, so this would store a broken file. \`curl -o ${path} <url>\` saves a download byte for byte.`,
      exitCode: 1,
    };
  }

  try {
    const dirPath = path.split('/').slice(0, -1).join('/') || '/';
    if (dirPath !== '/') await ensureDirectory(vfs, projectId, dirPath);

    if (redirect.append) {
      // Append: read existing + append
      let existing = '';
      try {
        const file = await vfs.readFile(projectId, path);
        if (typeof file.content === 'string') existing = file.content;
      } catch { /* file doesn't exist yet */ }
      const newContent = existing ? existing + '\n' + content : content;
      try { await vfs.createFile(projectId, path, newContent); }
      catch { await vfs.updateFile(projectId, path, newContent); }
    } else {
      // Overwrite
      try { await vfs.createFile(projectId, path, content); }
      catch { await vfs.updateFile(projectId, path, content); }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: '', stderr: `redirect: ${path}: ${e?.message || 'cannot write file'}`, exitCode: 1 };
  }
}

function versionMs(file: { updatedAt: Date }): number {
  return new Date(file.updatedAt).getTime();
}

/** Record that the agent now has a current, full view of `path` at its version. */
export function recordFileVersion(ctx: ShellContext | undefined, path: string, file: { updatedAt: Date }): void {
  ctx?.readVersions?.set(path, versionMs(file));
}

/**
 * Decide whether a write to `path` may proceed and whether it should update the
 * baseline afterward.
 *
 * - `block`: non-null only for a `wholeChunk` write when the agent has a baseline
 *   for the file AND it changed since — a confirmed conflict. Surgical writes
 *   (wholeChunk=false) never block. New files, matching baselines, and untracked
 *   callers never block.
 * - `wasCurrent`: true when the agent's view is accurate (no baseline yet, matching
 *   baseline, or new file). Only then should a successful write record the new
 *   version — otherwise a surgical edit applied to a stale file would "launder" the
 *   baseline and let a later whole-chunk write slip past the guard.
 */
export async function checkWrite(
  vfs: VirtualFileSystem,
  projectId: string,
  ctx: ShellContext | undefined,
  path: string,
  wholeChunk: boolean,
): Promise<{ block: ShellResult | null; wasCurrent: boolean }> {
  if (!ctx?.readVersions) return { block: null, wasCurrent: false };
  const known = ctx.readVersions.get(path);
  let current: { updatedAt: Date };
  try {
    current = await vfs.readFile(projectId, path);
  } catch {
    return { block: null, wasCurrent: true }; // new file — the agent's write defines it
  }
  const cur = versionMs(current);
  const wasCurrent = known === undefined || known === cur;
  if (wholeChunk && known !== undefined && known !== cur) {
    return {
      block: {
        stdout: '',
        stderr: `refusing to edit ${path}: it changed since you last read it (edited outside this conversation). Run \`cat ${path}\` to see the current content, then redo your edit.`,
        exitCode: 1,
      },
      wasCurrent,
    };
  }
  return { block: null, wasCurrent };
}

/**
 * Like applyRedirect, but for full-file overwrites (`>`, not `>>`) it first runs
 * the whole-chunk staleness guard and, on success, records the new version so the
 * agent can overwrite its own write again without re-reading.
 */
export async function applyRedirectGuarded(
  vfs: VirtualFileSystem,
  projectId: string,
  content: string,
  redirect: { file: string; append: boolean },
  ctx: ShellContext | undefined,
): Promise<ShellResult> {
  const path = normalizePath(redirect.file);
  let wasCurrent = false;
  if (!redirect.append && path) {
    const chk = await checkWrite(vfs, projectId, ctx, path, true);
    if (chk.block) return chk.block;
    wasCurrent = chk.wasCurrent;
  }
  const result = await writeRedirect(vfs, projectId, content, redirect);
  if (result.exitCode === 0 && !redirect.append && path && wasCurrent) {
    try {
      recordFileVersion(ctx, path, await vfs.readFile(projectId, path));
    } catch { /* best-effort version record */ }
  }
  return result;
}
