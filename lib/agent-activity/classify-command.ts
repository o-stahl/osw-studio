import { parseCommand } from './parse-command';

/**
 * Which group a shell command belongs to in the transcript.
 *
 * Four buckets, and they are a display grouping rather than a description: they pick the icon and
 * the heading a tool call gets, and `agent` is also how the processor finds the sub-agent call whose
 * progress it is following. `parseCommand` in this directory answers the other question, what the
 * command did and to which file, in finer kinds.
 *
 * The two are not one function because the coarser answer is not a fold of the finer one:
 *
 * - `echo "---"` parses as an edit, since `echo` is how a file gets appended to, but on its own it
 *   writes nothing and belongs in `bash`. Folding every writing kind into `write` would move it.
 * - A read names its file as surely as a write does, so the presence of a path cannot stand in for
 *   "this wrote something" either.
 * - A heredoc is a write whatever opens it, including a verb `parseCommand` does not know (`tee`).
 *
 * So the `agent` and `status` buckets are derived, which is where the duplication actually cost
 * something: both files carried the `agent|delegate` spelling, and the alias has been renamed once
 * already. The write rules stay written out here, at the granularity this answer needs.
 */
type CommandCategory = 'bash' | 'write' | 'status' | 'agent';

export function classifyCommand(cmd: string | string[] | undefined): CommandCategory {
  if (!cmd) return 'bash';
  const s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd)).trimStart();

  // Derived, so the sub-agent spelling and the task-completion commands are listed once.
  // `parseCommand` also looks past a leading `cd` and reads a chain by its first command, so
  // `cd / && status` lands in the same bucket as `status`, which the old regexes missed.
  const kind = parseCommand(s)?.kind;
  if (kind === 'delegate') return 'agent';
  if (kind === 'evaluate' || kind === 'build') return 'status';

  if (/<<-?\s*['"]?\w+/.test(s)) return 'write';
  if (/^cat\s*>/.test(s)) return 'write';
  if (/^cat\b/.test(s) && /(?<![2&])>>?\s*\//.test(s)) return 'write';
  // What parseCommand made of it, which reads the in-place flag as the shell's sed does.
  if (/^sed\s/.test(s) && (kind === 'edit' || kind === 'write')) return 'write';
  if (/^ss\b/.test(s)) return 'write';
  if (/^(mkdir|touch|rm|mv|cp)\b/.test(s)) return 'write';
  // An absolute-path redirect is a write even where the verb reads. `2>` and `&>` are plumbing, not
  // content, which is what the lookbehind keeps out.
  if (/^echo\b/.test(s) && /(?<![2&])>>?\s*\//.test(s)) return 'write';

  return 'bash';
}
