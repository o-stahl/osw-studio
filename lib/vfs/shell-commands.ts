/**
 * The `bash` tool's command set, in one place.
 *
 * The list used to be re-encoded in several files that drifted apart: the "Supported commands"
 * error string, the write-scope allow-list, the analytics buckets and the unknown-command message.
 * Drift in the cosmetic copies is noise; drift in the functional ones is not — a command missing
 * from the write list is a command a scoped agent can write through.
 *
 * Mirrors the single-source-of-truth shape of lib/runtimes/registry.ts. A test compares this list
 * against the handler map in shell/index.ts, so adding a command without registering it fails.
 */

/**
 * How a command relates to the VFS:
 *  - `never`        reads or reports only
 *  - `always`       every invocation writes
 *  - `conditional`  writes only with certain flags (`sed -i`, `curl -o`); write-scope inspects argv
 */
type ShellWriteKind = 'never' | 'always' | 'conditional';

interface ShellCommandSpec {
  name: string;
  /** Alternate spellings dispatched to the same implementation. */
  aliases?: string[];
  writes: ShellWriteKind;
  /**
   * `shell` — dispatched by the switch in cli-shell.
   * `tool`  — intercepted by the tool layer before the shell sees it (scripts, previews, agents).
   */
  handledBy: 'shell' | 'tool';
  /** One line for the command list the agent is shown. */
  summary: string;
  /** Only available to the setup agent (project discussion), not the general coding loop. */
  setupOnly?: boolean;
  /** Runs a script in the sandbox, which cannot reach project files; what it writes to /output/ is kept. */
  script?: boolean;
}

export const SHELL_COMMANDS: ShellCommandSpec[] = [
  // ── Reading and searching ────────────────────────────────────────────────
  { name: 'ls', writes: 'never', handledBy: 'shell', summary: 'List files' },
  { name: 'tree', writes: 'never', handledBy: 'shell', summary: 'Show directory tree' },
  { name: 'cat', writes: 'never', handledBy: 'shell', summary: 'Read entire file' },
  { name: 'head', writes: 'never', handledBy: 'shell', summary: 'Read first lines (-n) or characters (-c)' },
  { name: 'tail', writes: 'never', handledBy: 'shell', summary: 'Read last lines (-n) or characters (-c)' },
  { name: 'rg', writes: 'never', handledBy: 'shell', summary: 'Search with context (preferred over grep)' },
  { name: 'grep', writes: 'never', handledBy: 'shell', summary: 'Search file contents' },
  { name: 'find', writes: 'never', handledBy: 'shell', summary: 'Find files by name or type' },
  { name: 'wc', writes: 'never', handledBy: 'shell', summary: 'Count lines, words or characters' },
  { name: 'sort', writes: 'never', handledBy: 'shell', summary: 'Sort lines' },
  { name: 'uniq', writes: 'never', handledBy: 'shell', summary: 'Collapse repeated lines' },
  { name: 'tr', writes: 'never', handledBy: 'shell', summary: 'Translate or delete characters' },
  { name: 'echo', writes: 'never', handledBy: 'shell', summary: 'Output text (writes when redirected)' },

  // ── Writing ─────────────────────────────────────────────────────────────
  { name: 'ss', writes: 'always', handledBy: 'shell', summary: 'Search-and-replace edit of an existing file' },
  { name: 'touch', writes: 'always', handledBy: 'shell', summary: 'Create an empty file' },
  { name: 'mkdir', writes: 'always', handledBy: 'shell', summary: 'Create a directory (-p for parents)' },
  { name: 'rm', writes: 'always', handledBy: 'shell', summary: 'Delete files or directories (-rf)' },
  { name: 'rmdir', writes: 'always', handledBy: 'shell', summary: 'Delete a directory, only when empty (-p also removes emptied parents)' },
  { name: 'mv', writes: 'always', handledBy: 'shell', summary: 'Move or rename' },
  { name: 'cp', writes: 'always', handledBy: 'shell', summary: 'Copy files or directories' },
  { name: 'sed', writes: 'conditional', handledBy: 'shell', summary: 'Text substitution; -i edits in place' },
  { name: 'generate-image', writes: 'always', handledBy: 'shell', summary: 'Generate an image into the project' },

  // ── Project and environment ─────────────────────────────────────────────
  { name: 'curl', writes: 'conditional', handledBy: 'shell', summary: 'Fetch a compiled page; -o writes the response' },
  { name: 'search', writes: 'never', handledBy: 'shell', summary: 'Web search via the configured provider' },
  { name: 'sleep', writes: 'never', handledBy: 'shell', summary: 'Pause briefly' },
  { name: 'sqlite3', writes: 'never', handledBy: 'shell', summary: 'Run SQL against a deployment database (Server Mode)' },
  { name: 'build', writes: 'never', handledBy: 'shell', summary: 'Compile the project and report errors' },
  { name: 'status', writes: 'never', handledBy: 'shell', summary: 'Report task progress and completion' },
  // Writes /.PROMPT.md when changing the runtime, which is why it counts as a write.
  { name: 'runtime', writes: 'always', handledBy: 'shell', summary: 'Show or change the project runtime' },

  // ── Conversation ────────────────────────────────────────────────────────
  { name: 'ask', writes: 'never', handledBy: 'shell', summary: 'Ask the user a question and wait' },
  { name: 'brief', writes: 'never', handledBy: 'shell', setupOnly: true, summary: 'Summarise the work for the user' },
  { name: 'spec', writes: 'never', handledBy: 'shell', setupOnly: true, summary: 'Record the agreed specification' },
  { name: 'propose-create', writes: 'never', handledBy: 'shell', setupOnly: true, summary: 'Propose creating a project from the discussion' },

  // ── Intercepted before the shell ────────────────────────────────────────
  { name: 'cd', writes: 'never', handledBy: 'tool', summary: 'Accepted and ignored; the VFS has no working directory' },
  { name: 'preview', writes: 'never', handledBy: 'tool', summary: 'Open a page in the preview pane' },
  // Script writes are detected from the source by scriptMayWriteFiles(), not from argv.
  { name: 'python', aliases: ['python3'], writes: 'conditional', handledBy: 'tool', script: true, summary: 'Run a Python script' },
  { name: 'lua', writes: 'conditional', handledBy: 'tool', script: true, summary: 'Run a Lua script' },
  { name: 'agent', aliases: ['delegate'], writes: 'conditional', handledBy: 'tool', summary: 'Run sub-agents (explore, task, plan)' },
];

const BY_NAME = new Map<string, ShellCommandSpec>();
for (const spec of SHELL_COMMANDS) {
  BY_NAME.set(spec.name, spec);
  for (const alias of spec.aliases ?? []) BY_NAME.set(alias, spec);
}

/** Every accepted spelling, aliases included. */
export function allShellCommandNames(): string[] {
  return [...BY_NAME.keys()].sort();
}


export function isKnownShellCommand(name: string): boolean {
  return BY_NAME.has(name);
}

/** Whether a command runs a script: `python`, `python3` or `lua`. */
export function isScriptCommand(name: string): boolean {
  return BY_NAME.get(name)?.script === true;
}

/**
 * Whether a `sed` argument asks for an in-place edit: `-i` (GNU), `-i ''` (BSD) or `-i.bak`, but not a
 * combined flag such as `-in` or `-ie`. The shell's own `sed` and every check of whether a command
 * writes read it from here, so a spelling the shell edits with cannot pass a check as a read.
 */
export function isSedInPlaceFlag(arg: string): boolean {
  return arg === '-i' || (arg.startsWith('-i') && arg.length > 2 && !/^-i[a-z]$/i.test(arg));
}

/** A `sed` command line as the shell's `sed` reads it. */
export interface SedArgs {
  inPlace: boolean;
  suppressOutput: boolean;
  expressions: string[];
  /** The last argument that is neither a flag nor shaped like an expression, or empty for none. */
  filePath: string;
}

/**
 * `sed`'s arguments, without the `sed`: `[-i] [-n] [-e expr]... 'expr' [file]`. An expression is told
 * from the file by its shape, wherever it stands, so `sed -i /a.html '/x/d'` edits /a.html. The
 * shell's `sed` and the write scope both read a command here, so the scope judges the file the shell
 * edits.
 */
export function parseSedArgs(args: string[]): SedArgs {
  let inPlace = false;
  let suppressOutput = false;
  const expressions: string[] = [];
  let filePath = '';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // -i (GNU), -i '' (BSD/macOS), -i.bak (backup extension) — all mean in-place
    if (isSedInPlaceFlag(a)) { inPlace = true; continue; }
    if (a === '-n') { suppressOutput = true; continue; }
    if (a === '-e' && args[i + 1]) { expressions.push(args[++i]); continue; }
    // Substitution expression (s/old/new/g)
    if (a.startsWith('s') && a.length > 2 && /[\/|#@]/.test(a[1])) {
      expressions.push(a);
      continue;
    }
    // Address-based expression (/pattern/d, 5,10d, $d, /p1/,/p2/c\text, etc.)
    // Must distinguish from file paths like /styles/style.css:
    //   Address: /re/d, /re/p, /re/n         (command letter at end of token)
    //            /re/c\text, /re/a\text, /re/i\text  (command letter + backslash)
    //            /re/,/re2/...                (range — comma right after the first addr)
    //   Path:    /dir/file.ext               (second slash followed by arbitrary text)
    // The previous heuristic `/^\/[^/]*\/[,dpcians]/` misclassified any path whose
    // basename began with d/p/c/i/a/n/s (e.g. /src/index.ts → command `i`).
    if (
      /^\d+!?[,dpcians{]/.test(a) ||
      /^[\\$]/.test(a) ||
      /^\/[^/]*\/(?:!?[dpn]$|!?[cai]\\|!?\{|,)/.test(a)
    ) {
      expressions.push(a);
      continue;
    }
    if (!a.startsWith('-') && a) filePath = a;
  }
  return { inPlace, suppressOutput, expressions, filePath };
}

/** Commands that write on every invocation. Conditional writers are argv-inspected by the caller. */
export function alwaysWriteCommands(): Set<string> {
  return new Set(
    SHELL_COMMANDS.filter((c) => c.writes === 'always').flatMap((c) => [c.name, ...(c.aliases ?? [])])
  );
}

/** Commands only the setup agent may run. */
export function setupOnlyCommandNames(): Set<string> {
  return new Set(SHELL_COMMANDS.filter((c) => c.setupOnly).map((c) => c.name));
}

/** Commands available to any agent — everything the general loop can call. */
export function generalCommandNames(): Set<string> {
  return new Set(
    SHELL_COMMANDS.filter((c) => !c.setupOnly).flatMap((c) => [c.name, ...(c.aliases ?? [])])
  );
}

/** The comma-separated list shown to the agent, in registry order. */
export function supportedCommandList(): string {
  return SHELL_COMMANDS.map((c) => c.name).join(', ');
}
