import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, normalizePath, truncate } from '../runtime';

/** `ls` — list files. */
export async function lsCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, ctx, redirect } = env;

  // Support flags: -R (recursive), -l/-la/-lh (long format with size & date).
  const lsFlags = new Set<string>();
  const lsPaths: string[] = [];
  for (const a of args) {
    if (a && a.startsWith('-')) lsFlags.add(a);
    else if (a) lsPaths.push(a);
  }
  const recursive = lsFlags.has('-R') || lsFlags.has('-r');
  const longFormat = lsFlags.has('-l') || lsFlags.has('-la') || lsFlags.has('-al') || lsFlags.has('-lh') || lsFlags.has('-lha') || lsFlags.has('-lah');
  const humanReadable = lsFlags.has('-lh') || lsFlags.has('-lha') || lsFlags.has('-lah') || lsFlags.has('-h');

  const formatFileSize = (bytes: number): string => {
    if (!humanReadable) return String(bytes).padStart(8);
    if (bytes < 1024) return `${bytes}B`.padStart(8);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`.padStart(8);
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`.padStart(8);
  };

  const formatFileLong = (f: { path: string; size?: number; updatedAt?: Date }) => {
    const size = formatFileSize(f.size || 0);
    const date = f.updatedAt ? new Date(f.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '                ';
    return `${size}  ${date}  ${f.path}`;
  };

  // A directory's entries: its children, or with -R everything under it.
  const listUnder = async (dir: string) => {
    if (!recursive) return vfs.listDirectory(projectId, dir, { includeTransient: true });
    const entries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
    const prefix = dir === '/' ? '/' : (dir.endsWith('/') ? dir : dir + '/');
    return entries.filter((e: { path: string }) => e.path === dir || e.path.startsWith(prefix));
  };

  // Multiple paths: each could be a file or directory
  if (lsPaths.length > 1) {
    const lines: string[] = [];
    for (let pi = 0; pi < lsPaths.length; pi++) {
      const np = normalizePath(lsPaths[pi]);
      if (!np) continue;
      // Try as file first
      try {
        const file = await vfs.readFile(projectId, np);
        lines.push(longFormat ? formatFileLong(file) : file.path);
        continue;
      } catch { /* not a file — try as directory */ }
      // Try as directory
      const dirFiles = await listUnder(np);
      if (dirFiles.length > 0) {
        if (pi > 0) lines.push(''); // blank line between directory sections
        lines.push(`${np}:`);
        const sorted = dirFiles.sort((a, b) => a.path.localeCompare(b.path));
        for (const f of sorted) {
          lines.push(longFormat ? formatFileLong(f) : f.path);
        }
      } else {
        lines.push(`ls: ${np}: No such file or directory`);
      }
    }
    const lsOutput = lines.join('\n');
    const lsResult: ShellResult = { stdout: truncate(lsOutput), stderr: '', exitCode: 0 };
    if (redirect) return applyRedirectGuarded(vfs, projectId, lsResult.stdout, redirect, ctx);
    return lsResult;
  }

  // Single path: a file, else a directory listing. Without the file probe (which the
  // multi-path branch above already does) `ls -la /bundle.js` listed the file as a directory,
  // came back empty at exit 0, and read as a missing file.
  const lsPath = normalizePath(lsPaths[0]) || '/';
  if (lsPaths.length === 1) {
    try {
      const file = await vfs.readFile(projectId, lsPath);
      const fileResult: ShellResult = {
        stdout: longFormat ? formatFileLong(file) : file.path,
        stderr: '',
        exitCode: 0
      };
      if (redirect) return applyRedirectGuarded(vfs, projectId, fileResult.stdout, redirect, ctx);
      return fileResult;
    } catch { /* not a file — fall through to the directory listing */ }
  }

  const sorted = (await listUnder(lsPath)).sort((a, b) => a.path.localeCompare(b.path));
  const lsOutput = longFormat
    ? sorted.map(f => formatFileLong(f)).join('\n')
    : sorted.map(f => f.path).join('\n');
  const lsResult: ShellResult = { stdout: truncate(lsOutput), stderr: '', exitCode: 0 };
  if (redirect) return applyRedirectGuarded(vfs, projectId, lsResult.stdout, redirect, ctx);
  return lsResult;
}
