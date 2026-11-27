import type { ShellEnv, ShellResult } from '../types';
import { normalizePath } from '../runtime';

const fail = (message: string, exitCode = 1): ShellResult => ({ stdout: '', stderr: `mv: ${message}`, exitCode });

/** Whether `path` is a directory, given the project's entries: one listed, or one with entries under it. */
function isDirectory(items: { path: string; type?: string }[], path: string): boolean {
  if (path === '/') return true;
  const prefix = path + '/';
  return items.some((item) => (item.type === 'directory' && item.path === path) || item.path.startsWith(prefix));
}

/**
 * `mv` — move or rename, as POSIX mv does it: a file already at the target is replaced, and a
 * directory at the target receives the source under its own name.
 */
export async function mvCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args } = env;
  const operands = args.filter((a) => a !== '-f');
  if (operands.length < 2) return fail('missing operands', 2);
  if (operands.length > 2) return fail('give one source and one target', 2);
  const from = normalizePath(operands[0]);
  let to = normalizePath(operands[1]);
  if (!from || !to) return fail('missing operands', 2);

  try {
    const items = await vfs.getAllFilesAndDirectories(projectId);
    const sourceIsFile = await vfs.fileExists(projectId, from);
    if (!sourceIsFile && !isDirectory(items, from)) {
      return fail(`cannot stat '${operands[0]}': No such file or directory`);
    }
    if (isDirectory(items, to)) to = `${to === '/' ? '' : to}/${from.split('/').pop()}`;
    if (to === from) return fail(`'${operands[0]}' and '${operands[1]}' are the same file`);

    if (!sourceIsFile) {
      if (to.startsWith(from + '/')) return fail(`cannot move '${operands[0]}' to a subdirectory of itself`);
      if (await vfs.fileExists(projectId, to)) return fail(`cannot overwrite non-directory '${to}' with directory '${operands[0]}'`);
      await vfs.renameDirectory(projectId, from, to);
    } else if (await vfs.fileExists(projectId, to)) {
      const file = await vfs.readFile(projectId, from);
      await vfs.updateFile(projectId, to, file.content);
      await vfs.deleteFile(projectId, from);
    } else {
      await vfs.renameFile(projectId, from, to);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
