/**
 * The `status` command as written on a shell line: `cd / && build && status --task "…" --done "…"
 * --remaining "none" --complete`.
 *
 * Read off the command text, so it works on a call that has not run yet or whose output was not
 * kept. The shell parses the arguments properly when the command runs (escaped quotes and all);
 * these patterns take a quoted value up to its closing quote, which is what models write.
 */

/** A `status` call anywhere on the line, as its own command. */
export const STATUS_SEGMENT_RE = /(?:^|&&|\|\||;|\|)\s*status\b/i;

export interface StatusFlags {
  task: string;
  done: string;
  remaining: string;
  complete: boolean;
  /** `--complete` or `--incomplete` was given, rather than inferred. */
  hasExplicitFlag: boolean;
}

/** The flags of the `status` call on a command line, or null when it has none or lacks --task/--done. */
export function parseStatusCommand(cmd: string): StatusFlags | null {
  if (!STATUS_SEGMENT_RE.test(cmd)) return null;
  const flag = (name: string) =>
    cmd.match(new RegExp(`--${name}\\s+"([^"]*)"`)) ||
    cmd.match(new RegExp(`--${name}\\s+'([^']*)'`)) ||
    cmd.match(new RegExp(`--${name}\\s+(\\S+)`));
  const task = flag('task');
  const done = flag('done');
  if (!task || !done) return null;
  const remaining = flag('remaining');
  const hasComplete = /--complete\b/.test(cmd);
  const hasIncomplete = /--incomplete\b/.test(cmd);
  return {
    task: task[1],
    done: done[1],
    remaining: remaining ? remaining[1] : 'none',
    complete: hasComplete && !hasIncomplete,
    hasExplicitFlag: hasComplete || hasIncomplete,
  };
}
