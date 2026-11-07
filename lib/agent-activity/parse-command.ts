import { parseSedArgs } from '@/lib/vfs/shell-commands';
import { normalizePath } from '@/lib/vfs/shell/paths';

/**
 * What one agent action was, read off the command it ran.
 *
 * The agent has a single `bash` tool, so every action is a shell command and "what it did" has to be
 * recovered from that string. This is the one place that recovers it. Surfaces phrase the result
 * themselves: the generation shelf wants a tense and the raw target, the quick-edit dock wants a
 * redacted line, and neither should be re-deriving the vocabulary.
 *
 * Deliberately shallow. It classifies the leading command and finds the file it acted on; it does
 * not understand pipelines, expansion or quoting beyond what those two need.
 */

export type ActionKind =
  | 'write' | 'read' | 'edit'
  | 'list' | 'search'
  | 'create' | 'delete' | 'move' | 'copy'
  | 'evaluate' | 'delegate' | 'lookup' | 'image' | 'database' | 'build' | 'ask'
  // Describe mode's setup agent: the brief, the spec, and the proposal to create the project.
  | 'brief' | 'spec' | 'propose'
  | 'preview' | 'run'
  | 'other';

export interface ParsedAction {
  kind: ActionKind;
  /**
   * The project path the command acts on, when it names one, the first when it names several.
   * Resolved from the root as the shell resolves it (`normalizePath`): the VFS has no working
   * directory and `cd` changes nothing, so `cd / && cat scripts/main.js` reads `/scripts/main.js`.
   * Null for commands that act on no file, and for a glob.
   */
  path: string | null;
  /** Every path the command acts on, `path` first: `cat /a.html /b.css` reads two. Empty when it names none. */
  paths: string[];
  /**
   * The raw fragment the target was read from: a path, a search pattern, a command name.
   * Derived from model output, so a surface that must not show tool arguments uses `path` instead.
   */
  detail: string | null;
}

/**
 * A relative argument that reads as a file: a path whose last part has an extension. Arguments that
 * are not files do not, so a sed script (`s/a/b/`), a line range (`1,80p`) or a count (`40`) is
 * never taken for one.
 */
const RELATIVE_FILE = /^(?:\.\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]+$/;

/**
 * An argument as a project path, or null when it is not one. Quotes around it are dropped. A path
 * that climbs with `..` is not one: the project has nothing above its root.
 */
function asPath(token: string | null): string | null {
  if (!token) return null;
  const bare = token.replace(/^(['"])(.*)\1$/, '$2');
  if (/(^|\/)\.\.(\/|$)/.test(bare)) return null;
  if (bare.startsWith('/')) {
    if (bare.length < 2 || /[\s*?]/.test(bare)) return null;
  } else if (!RELATIVE_FILE.test(bare)) {
    return null;
  }
  return normalizePath(bare) ?? null;
}

/**
 * The first absolute path in the command, used when the token the verb points at is not one.
 *
 * `sed -n '1,80p' -e x /index.html` puts its file somewhere the per-verb rules do not look, and a
 * quoted script fragment never starts with a slash, so a scan is both simpler and more reliable
 * than another special case.
 */
function firstAbsolutePath(segment: string): string | null {
  for (const token of segment.split(/\s+/)) {
    const path = token.startsWith('/') ? asPath(token) : null;
    if (path) return path;
  }
  return null;
}

/** The command's words as the shell passes them: split at spaces outside quotes, the quotes dropped. */
function shellWords(cmd: string): string[] {
  return [...cmd.matchAll(/(?:[^\s'"]+|'[^']*'?|"[^"]*"?)+/g)]
    .map(([word]) => word.replace(/'([^']*)'?|"([^"]*)"?/g, (_, single?: string, double?: string) => single ?? double ?? ''));
}

/**
 * The file arguments of a command that takes several, `cat a b` or `rm -f a b`: every argument but
 * the flags. A flag's value (`head -n 40`) never reads as a file, so it falls away in `asPath`.
 */
function fileArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith('-'));
}

/**
 * The action, with the paths among `targets`, or failing those the first absolute path anywhere in
 * the segment. A kind that acts on no file passes no targets.
 */
function action(kind: ActionKind, detail: string | null, segment: string, targets: Array<string | null> | null = null): ParsedAction {
  if (targets === null) return { kind, path: null, paths: [], detail };
  const named = [...new Set(targets.map(asPath).filter((p): p is string => p !== null))];
  const paths = named.length > 0 ? named : [firstAbsolutePath(segment)].filter((p): p is string => p !== null);
  return { kind, path: paths[0] ?? null, paths, detail };
}

/**
 * Where a redirect writes, when it writes to a path: `cat > styles/a.css << 'EOF'`. A `>` inside
 * quotes is text, such as a CSS selector in a sed script or a comparison in a search pattern, so
 * quoted text is blanked before looking, at its own length, and the target read from the command.
 * A quote that does not close runs to the end, since `leadingSegment` can cut a pattern at its `&&`.
 */
function redirectTarget(cmd: string): string | null {
  const unquoted = cmd.replace(/(['"])(.*?)(\1|$)/g, (_, quote: string, text: string, close: string) => quote + '_'.repeat(text.length) + close);
  for (const match of unquoted.matchAll(/(?:^|\s)>>?\s*(\S+)/g)) {
    const end = (match.index ?? 0) + match[0].length;
    const target = cmd.slice(end - match[1].length, end);
    if (asPath(target)) return target;
  }
  return null;
}

/**
 * The part of the command that says what the action was.
 *
 * A chain is one action to a reader, and only its first command carries the intent: for
 * `cat /index.html | grep hero` the answer is a read of index.html, not a search for `hero`. The
 * head line is taken first so a heredoc body cannot be mistaken for a continuation, and a bare pipe
 * only splits when it is spaced, which leaves a quoted `"a|b"` search pattern intact.
 *
 * A leading `cd` is skipped rather than classified. The agent habitually writes `cd / && build`,
 * and taking the first segment literally made the action a `cd` — which matches no verb, so the
 * whole command read as "Working" and a run of them read as "Working x10", while the verb that
 * would have named it sat in the next segment.
 */
function leadingSegment(command: string): string {
  const head = command.split('\n')[0];
  const segments = head.split(/(?:&&|\|\|)|\s\|\s|;/).map((part) => part.trim()).filter(Boolean);
  const meaningful = segments.find((part) => !/^cd(\s|$)/.test(part));
  return (meaningful ?? segments[0] ?? '').trim();
}

/**
 * Drop the stderr plumbing before the verb is read.
 *
 * `cat /a.md 2>/dev/null` is a read, but the read branch refuses any command containing `>` so
 * that `cat /a > /b` is not reported as a read of `/a`. The stderr forms carry no such meaning,
 * so they are removed instead of being allowed to defeat the check.
 */
function withoutStderrRedirect(command: string): string {
  return command.replace(/\s2>(?:&1|\S+)/g, '').trim();
}

export function parseCommand(rawCommand: string): ParsedAction | null {
  const trimmed = rawCommand.trim();
  if (!trimmed) return null;
  const cmd = withoutStderrRedirect(leadingSegment(trimmed));
  if (!cmd) return null;

  const args = cmd.split(/\s+/);

  // The setup agent's commands carry their content in a heredoc (`brief --merge << 'EOF'`,
  // `spec --append "Audience" << 'EOF'`), which would otherwise read as a write.
  if (/^brief\b/.test(cmd)) return action('brief', args[0], cmd);
  if (/^spec\b/.test(cmd)) return action('spec', args[0], cmd);
  if (/^propose-create\b/.test(cmd)) return action('propose', args[0], cmd);

  // A redirection or heredoc is a write however the line started, so both are tested before the
  // verb: `cat /a.html > /b.html` writes b.html and is not a read of a.html.
  const redirect = redirectTarget(cmd);
  if (redirect) return action('write', redirect, cmd, [redirect]);

  if (/<<-?\s*['"]?\w+/.test(cmd)) {
    return action('write', asPath(args[1] ?? null) ? args[1] : 'file', cmd, [args[1] ?? null]);
  }

  if (/^(cat|head|tail|nl|wc)\s+/.test(cmd) && !/>/.test(cmd)) {
    return action('read', args[args.length - 1], cmd, fileArgs(args.slice(1)));
  }

  // `sed` edits only in place; without it, it prints, which is how the agent reads a range of lines.
  // Its file is found as the shell's sed finds it, so a quoted script after the file is not one.
  if (/^sed\s+/.test(cmd)) {
    const { inPlace, filePath } = parseSedArgs(shellWords(cmd).slice(1));
    return action(inPlace ? 'edit' : 'read', filePath || 'file', cmd, [filePath || null]);
  }
  if (/^ss\s+/.test(cmd)) {
    const last = args[args.length - 1];
    return action('edit', last ?? 'file', cmd, [last ?? null]);
  }

  if (/^touch\s+/.test(cmd)) return action('edit', args[args.length - 1], cmd, fileArgs(args.slice(1)));
  // An echo's words are text, not files: only an absolute path at the end is taken for one.
  if (/^echo\s+/.test(cmd)) {
    const match = cmd.match(/\s['"]?(\/[^\s'"]+)['"]?\s*$/);
    return match ? action('edit', match[1], cmd, [match[1]]) : action('edit', 'file', cmd);
  }

  if (/^(ls|tree|find)\b/.test(cmd)) return action('list', args[1] ?? '/', cmd, [args[1] ?? null]);

  if (/^(grep|rg)\s+/.test(cmd)) {
    return action('search', args.slice(1, 3).join(' '), cmd);
  }

  if (/^mkdir\s+/.test(cmd)) {
    const targets = fileArgs(args.slice(1));
    return action('create', targets[0] ?? null, cmd, targets);
  }

  if (/^(rm|rmdir)\s+/.test(cmd)) return action('delete', args[args.length - 1], cmd, fileArgs(args.slice(1)));
  if (/^mv\s+/.test(cmd)) return action('move', args[args.length - 1], cmd, [args[args.length - 1]]);
  if (/^cp\s+/.test(cmd)) return action('copy', args[args.length - 1], cmd, [args[args.length - 1]]);

  if (/^status\b/.test(cmd)) return action('evaluate', 'progress', cmd);

  // `delegate` is the pre-v1.70.0 spelling of `agent` and is still accepted by the coordinator.
  if (/^(agent|delegate)\s+/.test(cmd)) {
    return action('delegate', args[1] ?? 'agent', cmd);
  }

  if (/^(search|curl)\s+/.test(cmd)) return action('lookup', args[0], cmd);
  if (/^generate-image\b/.test(cmd)) return action('image', 'generate-image', cmd);
  if (/^sqlite3\b/.test(cmd)) return action('database', 'sqlite3', cmd);
  if (/^(runtime|build)\b/.test(cmd)) return action('build', args[0], cmd);
  if (/^preview\b/.test(cmd)) return action('preview', args[1] ?? null, cmd, [args[1] ?? null]);
  // `python3` as well as `python`: \b does not match between `n` and `3`.
  if (/^(python\d*|lua\d*)\b/.test(cmd)) return action('run', args[0], cmd);
  if (/^ask\b/.test(cmd)) return action('ask', 'ask', cmd);

  return action('other', args[0], cmd);
}

/**
 * The command in a tool call's arguments, as the executor reported them.
 *
 * Arguments arrive as the JSON string the model produced, so a partial or malformed value is
 * expected rather than exceptional and yields no command at all.
 */
export function toolCommand(argsJson: unknown): string | null {
  if (typeof argsJson !== 'string') return null;
  try {
    const args = JSON.parse(argsJson);
    const command = args?.command ?? args?.cmd;
    return typeof command === 'string' ? command : null;
  } catch {
    return null;
  }
}

/** The action behind a tool call, from the arguments the executor reported. */
export function parseToolArgs(argsJson: unknown): ParsedAction | null {
  const command = toolCommand(argsJson);
  return command === null ? null : parseCommand(command);
}
