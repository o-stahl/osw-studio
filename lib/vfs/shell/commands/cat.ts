import type { ShellEnv, ShellResult } from '../types';
import { applyRedirectGuarded, normalizePath, recordFileVersion, truncate } from '../runtime';

/** `cat` — read entire file. */
export async function catCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

  // Support up to 5 files at once
  const MAX_FILES = 5;
  const filePaths = args.filter(a => a && !a.startsWith('-')).map(p => normalizePath(p));

  // If no file args but stdin is available, pass through stdin
  if (filePaths.length === 0 && stdin !== undefined) {
    const result: ShellResult = { stdout: truncate(stdin), stderr: '', exitCode: 0 };
    if (redirect) return applyRedirectGuarded(vfs, projectId, result.stdout, redirect, ctx);
    return result;
  }

  if (filePaths.length === 0) {
    return { stdout: '', stderr: 'cat: missing file path', exitCode: 2 };
  }

  if (filePaths.length > MAX_FILES) {
    return {
      stdout: '',
      stderr: `cat: too many files. You requested ${filePaths.length} files, but cat supports a maximum of ${MAX_FILES} files at a time. Please split into multiple cat calls.`,
      exitCode: 2
    };
  }

  const outputs: string[] = [];
  let hadError = false;
  const errorMessages: string[] = [];

  for (const path of filePaths) {
    if (!path) {
      errorMessages.push('cat: invalid path');
      hadError = true;
      continue;
    }

    if (path.startsWith('/-')) {
      errorMessages.push(`cat: invalid path "${path}" (looks like an option)`);
      hadError = true;
      continue;
    }

    if (path === '/<<' || path?.startsWith('/<<') || path === '<<' || path?.startsWith('<<')) {
      errorMessages.push(`cat: heredoc syntax error — the << operator was not parsed correctly. Write each file in a separate tool call instead of chaining multiple heredocs.`);
      hadError = true;
      continue;
    }

    try {
      const file = await vfs.readFile(projectId, path);
      if (typeof file.content !== 'string') {
        errorMessages.push(`cat: ${path}: binary or non-text file`);
        hadError = true;
      } else {
        // For multiple files, add a header
        if (filePaths.length > 1) {
          outputs.push(`=== ${path} ===\n${file.content}`);
        } else {
          outputs.push(file.content);
        }
        // A full `cat` gives the agent a current, complete view of the file —
        // this is what qualifies a later overwrite of it.
        recordFileVersion(ctx, path, file);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errorMessages.push(`cat: ${path}: ${errMsg}`);
      hadError = true;
    }
  }

  const stdout = outputs.join('\n\n');
  const stderr = errorMessages.join('\n');

  const catResult: ShellResult = { stdout: truncate(stdout), stderr, exitCode: hadError ? 1 : 0 };
  if (!redirect) return catResult;
  // What could be read still goes to the file, as in a shell; a path that could not be is then the answer.
  const written = await applyRedirectGuarded(vfs, projectId, catResult.stdout, redirect, ctx);
  return !hadError || written.exitCode !== 0 ? written : { stdout: '', stderr, exitCode: 1 };
}
