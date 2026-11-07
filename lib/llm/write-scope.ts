/**
 * Per-agent write scoping. A restricted agent (e.g. the interview agent) may
 * read anywhere but write only within a single directory. The guard lives next
 * to the existing read-only gate in tool-registry; these are its pure,
 * unit-testable helpers. Paths containing `..` are rejected outright — the VFS
 * has no symlinks, so a plain reject is sufficient.
 */

import { alwaysWriteCommands, isScriptCommand, isSedInPlaceFlag, parseSedArgs } from '@/lib/vfs/shell-commands';
import { sqliteChangesData } from './permissions';
import { normalizePath } from '@/lib/vfs/shell/paths';

/** Derived from the command registry so a new writing command cannot be missed here. */
const WRITE_COMMANDS = alwaysWriteCommands();

function hasRedirect(cmd: string[]): boolean {
  return cmd.includes('>') || cmd.includes('>>');
}

/**
 * Which commands change the VFS: tool-registry's isWriteOperation() less its sqlite3 case, a change
 * to a deployment's data, which checkWriteScope refuses on its own.
 */
function isWriteCommand(cmd: string[]): boolean {
  const c = cmd[0];
  if (WRITE_COMMANDS.has(c)) return true;
  if (c === 'sed' && cmd.slice(1).some(isSedInPlaceFlag)) return true;
  if (c === 'curl' && (cmd.includes('-o') || cmd.includes('--output'))) return true;
  if (hasRedirect(cmd)) return true;
  return false;
}

/**
 * Whether a command line writes anything, across every stage and chained command in it.
 *
 * The MCP `bash` tool picks the scope it demands from this. It used `classifyCommand`, whose own
 * header calls it a display grouping rather than a description, so a write reached through a pipe
 * read as a plain command: the call asked only for `projects:read`, and the change notification
 * that tells an open browser to pull never fired.
 */
export function commandLineWrites(command: string): boolean {
  return command
    .split(/\n|\||&&|\|\||;/)
    .map(segment => segment.trim())
    .filter(Boolean)
    .some(segment => isWriteCommand(segment.split(/\s+/)));
}

/** A path token as the shell resolves it. */
function toAbsolute(p: string): string {
  return normalizePath(p) || '/';
}

/** Every value given to one of `flags`. The shell keeps the last, so each one is checked. */
function flagValues(cmd: string[], flags: string[]): string[] | null {
  const values = cmd.flatMap((arg, i) => (flags.includes(arg) ? [cmd[i + 1]] : []));
  return values.every(Boolean) ? values : null;
}

/** What a command writes from its own arguments, its redirects taken off. */
function ownTargets(cmd: string[]): string[] | null {
  const c = cmd[0];
  const rest = cmd.slice(1);
  const nonFlags = rest.filter(a => !a.startsWith('-'));

  if (c === 'curl') return flagValues(cmd, ['-o', '--output']);

  if (c === 'generate-image') {
    // Writes the image to --out/-o when given, otherwise to /.generated/.
    const outs = flagValues(cmd, ['--out', '-o']);
    return outs === null ? null : outs.length > 0 ? outs : ['/.generated/'];
  }

  if (c === 'runtime') {
    // Changing the runtime rewrites the project's prompt file; the path is not in argv.
    return ['/.PROMPT.md'];
  }

  if (c === 'sed') {
    // A sed that prints writes nothing; one that edits in place writes the file the shell's sed
    // reads, wherever it stands among the expressions.
    if (!rest.some(isSedInPlaceFlag)) return [];
    const file = parseSedArgs(rest).filePath;
    return file ? [file] : null;
  }

  if (!WRITE_COMMANDS.has(c)) return [];

  if (c === 'cp') {
    // cp copies its first operand to its second. A glob in the source expands after this check,
    // so any match can become the destination, and the source counts as written too.
    if (nonFlags.length < 2) return null;
    return /[*?]/.test(nonFlags[0]) ? nonFlags : nonFlags.slice(1);
  }

  if (c === 'mv') {
    // A source and a destination at least. A move takes its sources away, so they are written too.
    return nonFlags.length < 2 ? null : nonFlags;
  }

  // ss, touch, mkdir, rm, rmdir — non-flag args are the targets
  return nonFlags.length > 0 ? nonFlags : null;
}

/**
 * Extract the write target path(s) from a command, normalized to absolute.
 *   []      → the command does not write.
 *   null    → the command writes but the target could not be determined (caller fails closed).
 *   [paths] → the write target(s).
 */
export function writeTargets(cmd: string[]): string[] | null {
  if (!isWriteCommand(cmd)) return [];

  // Every redirect target, and what the command writes itself. The shell writes to the first
  // redirect and hands any later one to the command as words, but each has to be in scope.
  const redirects = flagValues(cmd, ['>', '>>']);
  if (redirects === null) return null;
  const isRedirect = (arg: string | undefined) => arg === '>' || arg === '>>';
  const own = ownTargets(cmd.filter((arg, i) => !isRedirect(arg) && !isRedirect(cmd[i - 1])));
  if (own === null) return null;
  return [...own, ...redirects].map(toAbsolute);
}

/** True if `path` is a file strictly inside `scope` (and contains no `..`). */
export function isPathWithinScope(scope: string, path: string): boolean {
  if (!scope) return true;
  if (path.includes('..')) return false;
  const s = scope.endsWith('/') ? scope : scope + '/';
  // The scope directory itself is in-scope (e.g. mkdir/rmdir of the dir the
  // agent writes into) — operating on it escapes nothing.
  if (path === s.slice(0, -1)) return true;
  return path.startsWith(s);
}

/** Decide whether a command's writes are permitted under an agent's writeScope. */
export function checkWriteScope(
  cmd: string[],
  scope: string | undefined,
): { allowed: boolean; reason?: string } {
  if (!scope) return { allowed: true };
  if (sqliteChangesData(cmd)) {
    return { allowed: false, reason: `this agent may only write files within ${scope}, not change a deployment's data` };
  }
  // Scripts run in a sandbox that cannot reach project files, but what they write to /output/ is
  // kept (tool-registry's bash description), so under a scope that is where they write.
  const targets = isScriptCommand(cmd[0]) ? ['/output/'] : writeTargets(cmd);
  if (targets === null) {
    return { allowed: false, reason: `this agent may only write within ${scope}, and the write target could not be verified` };
  }
  for (const t of targets) {
    if (!isPathWithinScope(scope, t)) {
      return { allowed: false, reason: `this agent may only write within ${scope} (attempted: ${t})` };
    }
  }
  return { allowed: true };
}
