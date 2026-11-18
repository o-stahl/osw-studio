import { VirtualFileSystem } from './index';
import { supportedCommandList } from './shell-commands';
import { getShellHandler } from './shell/index';
import { normalizePath } from './shell/runtime';
import type { ShellContext, ShellResult } from './shell/types';

/**
 * Strip bash stderr/stdout redirect operators that are no-ops in the virtual shell.
 * LLMs reflexively append patterns like `2>/dev/null`, `&>/dev/null`, `2>&1`, etc.
 * Handles both fused (`2>/dev/null`) and split (`2>` `/dev/null`) token forms.
 */
function stripBashRedirects(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // Exact fd-duplication: 2>&1
    if (token === '2>&1') continue;
    // Bare redirect operator (2>, 2>>, 1>, 1>>, &>, &>>) — skip it AND the next token (the target path)
    if (/^(?:2|1|&)>>?$/.test(token)) { i++; continue; }
    // Fused redirect+path (2>/dev/null, 1>/tmp/err, &>/dev/null, 2>>/dev/null, etc.)
    if (/^(?:2|1|&)>>?./.test(token)) continue;
    result.push(token);
  }
  return result;
}

/**
 * Extract redirect operator from args: > (overwrite) or >> (append)
 * Returns cleaned args and redirect info
 */
function extractRedirect(args: string[]): { cleanArgs: string[]; redirect?: { file: string; append: boolean } } {
  const appendIdx = args.indexOf('>>');
  const overwriteIdx = args.indexOf('>');

  // Use whichever redirect appears first; prefer >> when at the same position
  let idx: number;
  if (appendIdx !== -1 && overwriteIdx !== -1) {
    idx = appendIdx <= overwriteIdx ? appendIdx : overwriteIdx;
  } else {
    idx = appendIdx !== -1 ? appendIdx : overwriteIdx;
  }
  if (idx === -1) return { cleanArgs: args };

  const append = args[idx] === '>>';
  const file = args[idx + 1];
  if (!file) return { cleanArgs: args }; // No file after redirect — leave as-is

  const cleanArgs = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { cleanArgs, redirect: { file, append } };
}

async function vfsShellExecute(
  vfs: VirtualFileSystem,
  projectId: string,
  cmd: string[],
  stdin?: string,
  ctx?: ShellContext
): Promise<ShellResult> {
  // Validate inputs
  if (!projectId || typeof projectId !== 'string') {
    return { stdout: '', stderr: 'Invalid project ID provided', exitCode: 2 };
  }

  if (!cmd || cmd.length === 0) {
    return { stdout: '', stderr: 'No command provided', exitCode: 2 };
  }

  const cleanCmd = stripBashRedirects(
    cmd.filter(arg => arg !== undefined && arg !== null && arg !== '')
  );
  if (cleanCmd.length === 0) {
    return { stdout: '', stderr: 'No valid command arguments provided', exitCode: 2 };
  }

  // Handle ; separator - execute all sequentially regardless of exit codes.
  // Each segment goes back through vfsShellExecute, not vfsShellExecuteSingle: a segment can
  // still contain a pipe, and only this function splits those. Recursing on Single silently
  // dropped every `| wc -l` that appeared inside a chain. Terminates because the split removed
  // the operator this branch matched on.
  if (cleanCmd.some(arg => arg === ';')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === ';') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute all commands sequentially regardless of exit codes
    const allStdout: string[] = [];
    const allStderr: string[] = [];
    let lastExitCode = 0;
    let lastExitReason: string | undefined;

    for (const singleCmd of commands) {
      const result = await vfsShellExecute(vfs, projectId, singleCmd, undefined, ctx);
      if (result.stdout) allStdout.push(result.stdout);
      if (result.stderr) allStderr.push(result.stderr);
      lastExitCode = result.exitCode;
      lastExitReason = result.exitReason;
    }

    return {
      stdout: allStdout.join('\n'),
      stderr: allStderr.join('\n'),
      exitCode: lastExitCode,
      exitReason: lastExitReason
    };
  }

  // Handle && command chaining - execute sequentially, stop on first failure
  if (cleanCmd.some(arg => arg === '&&')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '&&') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute commands sequentially
    const allStdout: string[] = [];
    const allStderr: string[] = [];
    let lastExitReason: string | undefined;

    for (const singleCmd of commands) {
      const result = await vfsShellExecute(vfs, projectId, singleCmd, undefined, ctx);
      if (result.stdout) allStdout.push(result.stdout);
      if (result.stderr) allStderr.push(result.stderr);
      lastExitReason = result.exitReason;

      // Stop on first failure (that's && semantics)
      if (result.exitCode !== 0) {
        return {
          stdout: allStdout.join('\n'),
          stderr: allStderr.join('\n'),
          exitCode: result.exitCode,
          exitReason: result.exitReason
        };
      }
    }

    return {
      stdout: allStdout.join('\n'),
      stderr: allStderr.join('\n'),
      exitCode: 0,
      exitReason: lastExitReason
    };
  }

  // Handle || fallback - execute sequentially, skip remaining on first success
  if (cleanCmd.some(arg => arg === '||')) {
    const commands: string[][] = [];
    let currentCmd: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '||') {
        if (currentCmd.length > 0) {
          commands.push(currentCmd);
          currentCmd = [];
        }
      } else {
        currentCmd.push(arg);
      }
    }
    if (currentCmd.length > 0) {
      commands.push(currentCmd);
    }

    // Execute commands sequentially, stop on first success
    let lastResult: ShellResult = { stdout: '', stderr: '', exitCode: 1 };
    for (const singleCmd of commands) {
      lastResult = await vfsShellExecute(vfs, projectId, singleCmd, undefined, ctx);
      if (lastResult.exitCode === 0) {
        return lastResult;
      }
    }

    return lastResult;
  }

  // Handle pipe chains: cmd1 | cmd2 | cmd3
  if (cleanCmd.some(arg => arg === '|')) {
    const segments: string[][] = [];
    let currentSeg: string[] = [];

    for (const arg of cleanCmd) {
      if (arg === '|') {
        if (currentSeg.length > 0) {
          segments.push(currentSeg);
          currentSeg = [];
        }
      } else {
        currentSeg.push(arg);
      }
    }
    if (currentSeg.length > 0) segments.push(currentSeg);

    if (segments.length < 2) {
      return vfsShellExecuteSingle(vfs, projectId, cleanCmd, undefined, ctx);
    }

    // Execute pipe chain left-to-right, passing stdout as stdin
    let pipeStdin: string | undefined = stdin;
    for (let i = 0; i < segments.length; i++) {
      const result = await vfsShellExecuteSingle(vfs, projectId, segments[i], pipeStdin, ctx);
      if (result.exitCode !== 0) return result;
      pipeStdin = result.stdout;
    }

    return { stdout: pipeStdin || '', stderr: '', exitCode: 0 };
  }

  return vfsShellExecuteSingle(vfs, projectId, cleanCmd, stdin, ctx);
}

/**
 * Expand glob patterns (*, ?) in arguments against the VFS file listing.
 * Converts e.g. `/scripts/*.js` into ['/scripts/main.js', '/scripts/app.js'].
 * Only expands args that contain glob characters and aren't flags.
 * If a pattern matches nothing, the original arg is kept (bash default).
 */
async function expandGlobs(
  vfs: VirtualFileSystem,
  projectId: string,
  args: string[]
): Promise<string[]> {
  // Quick check: any args need expansion?
  if (!args.some(a => a && !a.startsWith('-') && (a.includes('*') || a.includes('?')))) {
    return args;
  }

  // Get all file paths once
  const allEntries = await vfs.getAllFilesAndDirectories(projectId, { includeTransient: true });
  const allPaths = allEntries.map((e: any) => e.path as string);

  const expanded: string[] = [];
  for (const arg of args) {
    if (!arg || arg.startsWith('-') || (!arg.includes('*') && !arg.includes('?'))) {
      expanded.push(arg);
      continue;
    }

    // Normalize path (adds / prefix if missing)
    const normalized = normalizePath(arg) || arg;

    // Convert glob to regex: escape regex chars, then replace * and ?
    const regexStr = normalized
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');

    const regex = new RegExp(`^${regexStr}$`);
    const matches = allPaths.filter(p => regex.test(p)).sort();

    if (matches.length > 0) {
      expanded.push(...matches);
    } else {
      expanded.push(arg); // No matches — keep original
    }
  }

  return expanded;
}

// Commands where file-path arguments should be glob-expanded.
// Excludes: rg, grep, sed (pattern args), find (-name takes its own glob),
// echo (text content), curl (URLs), status (special).
const GLOB_EXPAND_COMMANDS = new Set([
  'wc', 'ls', 'cat', 'rm', 'rmdir', 'cp', 'mv', 'touch',
]);

const SHELL_KEYWORDS = new Set([
  'for', 'while', 'until', 'do', 'done',
  'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function',
]);

async function vfsShellExecuteSingle(
  vfs: VirtualFileSystem,
  projectId: string,
  cleanCmd: string[],
  stdin?: string,
  ctx?: ShellContext
): Promise<ShellResult> {
  // Extract redirect operators (> or >>) before processing the command
  const { cleanArgs: argsAfterRedirect, redirect } = extractRedirect(cleanCmd.slice(1));
  const program = cleanCmd[0];
  const args = GLOB_EXPAND_COMMANDS.has(program)
    ? await expandGlobs(vfs, projectId, argsAfterRedirect)
    : argsAfterRedirect;

  try {
    const handler = getShellHandler(program);
    if (handler) {
      // Awaited here, or a handler that throws answers past the `catch` below and takes the whole
      // command line with it.
      return await handler({ vfs, projectId, args, stdin, ctx, redirect });
    }

    // A loop splits on `;` into several unknown commands, so one `for` line came back as three
    // `command not found` blocks carrying three copies of the command list: about 9KB that never
    // says the construct is unsupported.
    if (SHELL_KEYWORDS.has(program)) {
      return {
        stdout: '',
        stderr: `${program}: the shell has no loops or conditionals. Run the commands one after another, or use a command that takes several paths at once (cat /a /b, rg -n pattern /).`,
        exitCode: 127,
      };
    }

    {
        const bashHint = program === 'bash' ? `
Don't use "bash" as a command - call the bash tool directly with your command.
Wrong: {"command": "bash -c ls -la"}
Right: {"command": "ls -la"}
` : '';

        return {
          stdout: '',
          stderr: `${program}: command not found${bashHint}

Supported commands: ${supportedCommandList()}
Operators: | (pipe), > (redirect), >> (append), && (chain), || (fallback), ; (sequence)

Correct shell tool usage:
  {"cmd": ["ls", "/"]}                        - List files
  {"cmd": ["ls", "-R", "/"]}                  - List files recursively
  {"cmd": ["tree", "/", "-L", "2"]}           - Show directory tree (max depth 2)
  {"cmd": ["cat", "/file.txt"]}               - Read entire file
  {"cmd": ["head", "-n", "20", "/file.txt"]}  - Read first 20 lines
  {"cmd": ["tail", "-n", "20", "/file.txt"]}  - Read last 20 lines
  {"cmd": ["head", "-c", "600", "/file.txt"]} - Read first 600 characters
  {"cmd": ["rg", "-C", "3", "pattern", "/"]}  - Search with 3 lines context (recommended)
  {"cmd": ["rg", "-A", "2", "-B", "1", "pattern"]} - Search with custom context
  {"cmd": ["grep", "-n", "pattern", "/file.txt"]} - Search with line numbers
  {"cmd": ["grep", "-F", "literal", "/file.txt"]} - Search literal string
  {"cmd": ["find", "/", "-name", "*.js"]}     - Find files by name
  {"cmd": ["mkdir", "-p", "/path/to/dir"]}    - Create directory (with parents)
  {"cmd": ["touch", "/file.txt"]}             - Create empty file
  {"cmd": ["rm", "-rf", "/dirname"]}          - Delete directory recursively
  {"cmd": ["mv", "/old.txt", "/new.txt"]}     - Move/rename files
  {"cmd": ["cp", "-r", "/src", "/dest"]}      - Copy files/directories
  {"cmd": ["echo", "Hello World"]}            - Output text
  {"cmd": ["echo", "content", ">", "/file.txt"]} - Write text to file
  {"cmd": ["sed", "s/old/new/g", "/file.txt"]}  - Text substitution (stdout)
  {"cmd": ["sed", "-i", "s/old/new/g", "/file.txt"]} - In-place edit
  {"cmd": ["cat", "/f.txt", "|", "grep", "class", "|", "head", "-n", "5"]} - Pipe chain
  {"cmd": ["grep", "-n", "div", "/f.txt", ">", "/results.txt"]} - Redirect to file
  {"cmd": ["find", "/", "-type", "f", "|", "wc", "-l"]} - Count files
  {"cmd": ["wc", "-l", "/file.txt"]}             - Count lines in file
  {"cmd": ["curl", "localhost/"]}                 - View compiled HTML output
  {"cmd": ["curl", "localhost/about"]}            - View compiled page (path resolution)
  {"cmd": ["curl", "-I", "localhost/"]}           - Response headers only
  {"cmd": ["search", "query"]}                    - Web search via configured provider
  {"cmd": ["sqlite3", "SELECT * FROM users"]} - Execute SQL (Server Mode)
  {"cmd": ["sqlite3", "-json", "SELECT * FROM products"]} - SQL output as JSON

Note: Use ss for editing existing files, cat > for new file creation, sed -i for single-line substitutions. Use rg (ripgrep) instead of grep for better context management.
Note: sqlite3 is only available in Server Mode and when a deployment context is selected.`,
          exitCode: 127
        };
      }
  } catch (e: any) {
    return { stdout: '', stderr: e?.message || String(e), exitCode: 1 };
  }
}

// Create a global instance that can be imported
export const vfsShell = {
  execute: async (
    projectId: string,
    cmd: string[],
    stdin?: string,
    ctx?: ShellContext
  ): Promise<{ success: boolean; stdout?: string; stderr?: string; exitCode?: number; exitReason?: string }> => {
    const { getActiveVFS } = await import('./index');
    const activeVFS = getActiveVFS();
    await activeVFS.init();
    const result = await vfsShellExecute(activeVFS, projectId, cmd, stdin, ctx);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      exitReason: result.exitReason
    };
  }
};

export type { ShellContext, ShellResult };
