import type { ShellEnv, ShellResult } from '../types';
import { parseHeadTailArgs } from '../internals';
import { applyRedirectGuarded, normalizePath, truncate } from '../runtime';

/**
 * `head` and `tail`: the same arguments and file handling, differing only in which end they take.
 * Several files print one after another, each under a `==> path <==` header as GNU does; a file
 * that cannot be read is reported on stderr and the rest still print.
 */
export async function headOrTail(env: ShellEnv, cmd: 'head' | 'tail'): Promise<ShellResult> {
  const { vfs, projectId, args, stdin, ctx, redirect } = env;

  const parsed = parseHeadTailArgs(args, cmd);
  if ('error' in parsed) return { stdout: '', stderr: parsed.error, exitCode: 2 };
  const { count, bytes, filePaths, fromStart } = parsed;

  // As GNU does: `head -n -N` is all but the last N, `tail -n N` and `tail -n -N` the last N, and
  // `tail -n +N` everything from the Nth on. Returns the start and end of what is taken.
  const range = (length: number): [number, number] => {
    if (cmd === 'head') return [0, count >= 0 ? Math.min(count, length) : Math.max(length + count, 0)];
    if (fromStart) return [Math.min(Math.max(count - 1, 0), length), length];
    return [Math.max(length - Math.abs(count), 0), length];
  };

  const take = (text: string): string => {
    if (bytes) return text.slice(...range(text.length));
    // A final newline ends the last line rather than starting another.
    const ended = /\r?\n$/.test(text);
    const lines = text.split(/\r?\n/);
    if (ended) lines.pop();
    const [start, end] = range(lines.length);
    return lines.slice(start, end).join('\n') + (ended && end === lines.length && end > start ? '\n' : '');
  };

  const finish = (result: ShellResult) =>
    redirect ? applyRedirectGuarded(vfs, projectId, result.stdout, redirect, ctx) : result;

  if (filePaths.length === 0) {
    if (stdin !== undefined) return finish({ stdout: truncate(take(stdin)), stderr: '', exitCode: 0 });
    return { stdout: '', stderr: `${cmd}: missing file path`, exitCode: 2 };
  }

  const sections: string[] = [];
  const errors: string[] = [];
  for (const filePath of filePaths) {
    const path = normalizePath(filePath);
    if (!path) {
      errors.push(`${cmd}: missing file path`);
      continue;
    }
    try {
      const file = await vfs.readFile(projectId, path);
      if (typeof file.content !== 'string') {
        errors.push(`${cmd}: ${path}: binary file`);
        continue;
      }
      const body = take(file.content);
      sections.push(filePaths.length > 1 ? `==> ${path} <==\n${body}` : body);
    } catch (e) {
      errors.push(`${cmd}: ${path}: ${(e instanceof Error && e.message) || 'file not found'}`);
    }
  }

  const stdout = truncate(sections.join('\n\n'));
  const stderr = errors.join('\n');
  if (sections.length === 0) return { stdout: '', stderr, exitCode: 1 };
  const result = await finish({ stdout, stderr: '', exitCode: 0 });
  return errors.length ? { ...result, stderr: [result.stderr, stderr].filter(Boolean).join('\n'), exitCode: 1 } : result;
}
