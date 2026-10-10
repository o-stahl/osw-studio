/**
 * Tool Registry - Central registry for all available tools
 * Replaces if/else chains with declarative tool definitions and handlers
 */

import { ToolDefinition, ToolCall } from './types';
import { getActiveVFS } from '@/lib/vfs';
import { vfsShell } from '@/lib/vfs/cli-shell';
import { alwaysWriteCommands } from '@/lib/vfs/shell-commands';
import { logger } from '../utils';
import { checkWriteScope } from './write-scope';
import {
  isJSONTruncationError,
  attemptJSONRepair,
} from './json-repair';
import { scriptRunner } from '@/lib/scripting/script-runner';
import type { ScriptRuntime } from '@/lib/scripting/types';
import { classifyGateKey, needsApproval, capabilityLabel, type ApprovalRequest, type ApprovalOutcome } from './permissions';
import { configManager } from '@/lib/config/storage';
import { apiFetch } from '@/lib/api/backend-status';
import { readWorkspaceCookie } from '@/lib/web/workspace-cookie';

export type ToolId = 'bash';

/**
 * Narrow shell description used by the describe-mode setup agent. Lists only
 * the four setup-time commands and intentionally omits VFS commands like
 * cat/rg/ls — setup runs without project context, so VFS commands have
 * nothing to act on and would confuse the model.
 */
const SETUP_BASH_DESCRIPTION = `Run setup commands during project intake.

Commands:
- brief --merge << 'EOF'
  { "name": "...", "runtime": "handlebars", "template": "blank", ... }
  EOF
  Merge JSON into the project brief. Call this when the user reveals config (name, pages, runtime, etc.).
  Brief fields: name, type, runtime, template, pages (string[]), language, direction, styling, capabilities, notes.

- spec --append "Section heading" << 'EOF'
  prose content
  EOF
  Append substantive context to .DESIGN.md under a section heading. Reuse existing section headings to grow them rather than creating duplicates.

- ask [--prompt "Question"] "Option A" "Option B" "Option C"
  Present tappable chip options to the user. The current iteration ends and the loop resumes when the user selects an option (their selection becomes the next message). Use for closed-ended choices.

- propose-create
  Signal the project is ready to create. The brief must contain name, runtime, and template. Enables the user's "Create now" button. The user may continue adjusting after this; call again if needed.

All commands are passed as the command argument to the bash tool. Do NOT call brief, spec, ask, or propose-create as separate tools — they are bash commands, not standalone tools.`;

interface ToolExecutor {
  /**
   * Execute the tool with given arguments
   * @param projectId - Current project ID
   * @param args - Tool arguments (parsed JSON)
   * @param context - Execution context (agent type, read-only mode, etc.)
   * @returns Tool execution result
   */
  execute(
    projectId: string,
    args: any,
    context: ToolExecutionContext
  ): Promise<string>;
}

export interface ToolExecutionContext {
  agentType?: string;
  isReadOnly?: boolean;
  writeScope?: string; // If set, writes are restricted to this directory prefix
  onProgress?: (event: string, data?: any) => void;
  /** Resolves the project's image-generation model + key and produces an image.
   *  Absent when the project has no image model configured. */
  generateImage?: (prompt: string, opts: { aspectRatio?: string; imageSize?: string }) => Promise<{ base64: string; mimeType: string }>;
  /** Held-promise approval gate. Absent when no interactive UI is available;
   *  in that case gated commands are allowed (cannot prompt, do not block). */
  onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalOutcome>;
  /** Overrides the permission mode source (defaults to configManager/localStorage).
   *  Set on server runs where localStorage is unavailable. */
  permissionMode?: import('./permissions').PermissionMode;
  permissionOverrides?: Record<string, import('./permissions').GateDecision>;
  /** Conversation-scoped map backing the read-before-edit guard (path → updatedAt ms).
   *  Threaded to the shell so whole-chunk writes can be checked against the agent's
   *  last full read. Absent on callers that don't track it (guard disabled). */
  readVersions?: Map<string, number>;
  /** Delegate a build to the browser (server-side generation only). */
  onBuildRequested?: () => Promise<{ success: boolean; errors?: string[] }>;
  /** Delegate a web search to the browser (server-side generation only). */
  onSearchRequested?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Server-side generation: instead of prompting (no UI), a gated command emits
   *  `approval_required` and pauses the run (awaiting_user). The user approves/denies
   *  when they return, which restarts the task. Browser runs leave this unset and use
   *  the held-promise `onApprovalNeeded` prompt instead. */
  pauseForApproval?: boolean;
}

interface RegisteredTool {
  id: ToolId;
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/**
 * Tool Registry - Manages all available tools
 */
export class ToolRegistry {
  private tools: Map<ToolId, RegisteredTool> = new Map();

  constructor() {
    this.registerBuiltInTools();
  }

  /**
   * Register all built-in tools
   */
  private registerBuiltInTools(): void {
    // Bash tool - Execute commands in the virtual file system
    this.register({
      id: 'bash',
      definition: {
        name: 'bash',
        description: `Run commands in the virtual file system.

Commands: cat, head, tail, ls, tree, grep, rg, find, mkdir, mv, cp, rm, touch, sed, ss, echo, wc, sort, uniq, tr, curl, search, sqlite3, python, python3, lua, preview, build, status, agent, runtime, ask.
Pipes (cmd1 | cmd2), redirects (> file, >> file), heredocs (<< 'EOF'), chaining (&&, ||, ;), and brace expansion ({a,b,c}) are supported.
Run scripts: python <file>, lua <file> (for computation/output only — they run in a sandbox and CANNOT edit project files; use ss or cat > for edits). Files written to /output/ persist. Show output in preview: preview <path>.

Edit existing files: ss /file << 'EOF'\\nsearch\\n=======\\nreplacement\\nEOF
Create new files: cat > /file << 'EOF'\\ncontent\\nEOF

One command at a time as a single string.`,
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to execute'
            }
          },
          required: ['command']
        }
      },
      executor: {
        execute: async (projectId, args, context) => {
          // Accept both 'command' (canonical) and 'cmd' (legacy/model habit)
          const rawCmd = args.command ?? args.cmd;
          if (typeof rawCmd !== 'string') {
            return 'Error: command must be a string. Pass the complete command as a single string (e.g., "ls -la /")';
          }

          // NOTE: do NOT HTML-unescape the whole command here. The raw string also
          // carries heredoc bodies (file content written via `cat >`/`ss`), and unescaping
          // those corrupts literal entities — e.g. an escapeHtml() implementation that writes
          // `.replace(/&/g, '&amp;')` would collapse to `.replace(/&/g, '&')`. Unescaping is
          // applied later, only to the command portion, once the heredoc body is separated out.
          let cmdString = rawCmd;

          // Newline-separated compound commands (multiple statements, possibly including
          // chained heredocs) are split here first. splitNewlineCommands is the single
          // authoritative parser for heredoc boundaries: it iterates line-by-line and
          // recognises a closing delimiter as a line whose trim equals the opener. This
          // lets a sequence like
          //   cat > /a << 'EOF'
          //   content-a
          //   EOF
          //   cat > /b << 'EOF'
          //   content-b
          //   EOF
          // split into two independent commands instead of one giant heredoc body.
          if (cmdString.includes('\n')) {
            const multiCmds = splitNewlineCommands(cmdString);
            if (multiCmds.length > 1) {
              const outputs: string[] = [];
              let completedCount = 0;
              for (const singleCmd of multiCmds) {
                const lineResult = await this.get('bash')!.executor.execute(projectId, { command: singleCmd }, context);
                if (lineResult && lineResult !== 'Command succeeded with no output') {
                  outputs.push(lineResult);
                }
                if (lineResult.startsWith('Error')) {
                  if (completedCount > 0) {
                    outputs.unshift(`(${completedCount}/${multiCmds.length} commands succeeded before this error)`);
                  }
                  break;
                }
                completedCount++;
              }
              return outputs.length > 0 ? outputs.join('\n') : 'Command succeeded with no output';
            }
          }

          // Single logical command from here on — at most one heredoc.
          // Supports both orderings:
          //   cat > file << 'EOF'\ncontent\nEOF   (standard)
          //   cat << 'EOF' > file\ncontent\nEOF   (reversed — common with Gemini models)
          // Also handles trailing commands after the heredoc (e.g., ... EOF\npython file.py).
          let heredocStdin: string | undefined;
          let trailingCommands: string | undefined;
          const heredocMatch = cmdString.match(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\1(?:[ \t]*\n([\s\S]+))?\s*$/);
          if (heredocMatch) {
            heredocStdin = heredocMatch[3];
            cmdString = cmdString.slice(0, heredocMatch.index!).trim();
            const afterDelimiter = (heredocMatch[2] || '').trim();
            if (afterDelimiter) {
              cmdString = cmdString + ' ' + afterDelimiter;
            }
            if (heredocMatch[4]) {
              trailingCommands = heredocMatch[4].trim();
            }
          } else {
            // Fallback: heredoc regex failed (e.g., truncated stream missing closing delimiter).
            // Detect << in the command and extract everything after the first newline as stdin.
            const fallbackMatch = cmdString.match(/^([^\n]*?)\s*<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]+)$/);
            if (fallbackMatch) {
              const beforeHeredoc = fallbackMatch[1].trim();
              const delimiter = fallbackMatch[2];
              const afterDelimiter = (fallbackMatch[3] || '').trim();
              let content = fallbackMatch[4];
              const closingRe = new RegExp('\\n' + delimiter + '\\s*$');
              content = content.replace(closingRe, '');
              heredocStdin = content;
              cmdString = afterDelimiter ? beforeHeredoc + ' ' + afterDelimiter : beforeHeredoc;
            }
          }

          // Unescape HTML entities on the COMMAND portion only. The heredoc body
          // (heredocStdin) is deliberately left untouched so file content is written verbatim.
          cmdString = unescapeHtmlEntities(cmdString);
          if (trailingCommands) trailingCommands = unescapeHtmlEntities(trailingCommands);

          // Parse command string into array
          const cmdArray = parseBashCommand(cmdString);

          // Check for && / || / ; chain operators — handle at this level so
          // python/lua/preview/cd work when chained (e.g., "python main.py && preview /output/chart.html")
          if (cmdArray.some(t => t === '&&' || t === '||' || t === ';')) {
            const segments = splitChainOperators(cmdArray);
            const outputs: string[] = [];

            for (let i = 0; i < segments.length; i++) {
              if (i > 0) {
                const prevOp = segments[i - 1].nextOp;
                const prevResult = outputs[outputs.length - 1] || '';
                const prevSuccess = !prevResult.startsWith('Error');
                if (prevOp === '&&' && !prevSuccess) break;
                if (prevOp === '||' && prevSuccess) continue;
                // ';' — always proceed to next command
              }

              const segResult = await executeShellSegment(
                projectId, segments[i].args, context,
                i === segments.length - 1 ? heredocStdin : undefined
              );
              if (segResult) outputs.push(segResult);
            }

            const combined = outputs.join('\n').trim();
            return combined || 'Command succeeded with no output';
          }

          // Single command (no chaining)
          const mainResult = await executeShellSegment(projectId, cmdArray, context, heredocStdin);

          // If there are trailing commands after a heredoc (e.g., EOF\npython file.py),
          // execute them sequentially as a chained && command.
          if (trailingCommands) {
            const outputs: string[] = [];
            if (mainResult.startsWith('Error')) {
              return mainResult;
            }
            if (mainResult) outputs.push(mainResult);

            const lines = trailingCommands.split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
              const trailArray = parseBashCommand(line);
              if (trailArray.length === 0) continue;

              const trailResult = await executeShellSegment(projectId, trailArray, context);
              if (trailResult.startsWith('Error')) {
                return outputs.length > 0
                  ? outputs.join('\n') + '\n' + trailResult
                  : trailResult;
              }
              if (trailResult) outputs.push(trailResult);
            }

            return outputs.length > 0 ? outputs.join('\n') : 'Command succeeded with no output';
          }

          return mainResult || 'Command succeeded with no output';
        }
      }
    });

  }

  /**
   * Register a new tool
   */
  register(tool: RegisteredTool): void {
    this.tools.set(tool.id, tool);
  }

  /**
   * Get a tool by ID
   */
  get(id: ToolId): RegisteredTool | undefined {
    return this.tools.get(id);
  }

  /**
   * Get tool definition by ID. Pass agentType to get a per-agent description
   * variant (e.g. setup mode gets a shell description that lists only the
   * four setup commands instead of the full VFS shell command set).
   */
  getDefinition(id: ToolId, agentType?: string): ToolDefinition | undefined {
    const tool = this.tools.get(id);
    if (!tool) return undefined;
    if (id === 'bash' && agentType === 'setup') {
      return { ...tool.definition, description: SETUP_BASH_DESCRIPTION };
    }
    return tool.definition;
  }

  /**
   * Get all tool definitions for a list of tool IDs.
   */
  getDefinitions(toolIds: string[], agentType?: string): ToolDefinition[] {
    return toolIds
      .map(id => this.getDefinition(id as ToolId, agentType))
      .filter((def): def is ToolDefinition => def !== undefined);
  }

  /**
   * Execute a tool call
   */
  async execute(
    toolCall: ToolCall,
    projectId: string,
    context: ToolExecutionContext
  ): Promise<string> {
    const toolId = toolCall.function?.name as string;
    const tool = this.get(toolId as ToolId);

    if (!tool) {
      // 'bash' is the only registered tool, and tool-executor rejects any other
      // tool name (via agent.hasTool) before reaching here — so this is just a
      // defensive guard.
      return `Error: Unknown tool "${toolId}"`;
    }

    try {
      const args = JSON.parse(toolCall.function.arguments);
      return await tool.executor.execute(projectId, args, context);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a JSON truncation error - attempt smart repair
      if (isJSONTruncationError(error)) {
        logger.warn(
          `[ToolRegistry] JSON truncation detected for ${toolId}, attempting repair. Original: ${JSON.stringify(toolCall.function.arguments)}`
        );

        const repairResult = attemptJSONRepair(toolCall.function.arguments);

        if (repairResult.success) {
          const repairedCommand = repairResult.repaired?.command ?? repairResult.repaired?.cmd;
          if (toolId === 'bash' && typeof repairedCommand === 'string') {
            const repairedCmd: string = repairedCommand;
            const validation = validateRepairedBashCommand(repairedCmd);

            if (!validation.ok) {
              // Check if this is a truncated heredoc write — salvage what we can.
              // The cmd may contain partial heredoc content (e.g., "cat > /file << 'EOF'\n...content...")
              // or the truncation happened before the << was complete (e.g., "cat > /file <").
              const redirectMatch = repairedCmd.match(/>\s*(\S+)/);
              const hasHeredocContent = /<<-?\s*['"]?\w+['"]?[^\n]*\n/.test(repairedCmd);

              if (hasHeredocContent && redirectMatch) {
                // Heredoc with content that got truncated — execute it.
                // The fallback heredoc extractor in the executor will parse out the content.
                logger.warn(`[ToolRegistry] Repaired shell command has truncated heredoc, executing salvaged write`);
                const result = await tool.executor.execute(projectId, repairResult.repaired, context);
                // Append a note so the model knows the file was written but content was cut off
                const targetFile = redirectMatch[1];
                return result + `\n\nNote: Your output was truncated mid-write. The file ${targetFile} was written with partial content. Continue writing from where you left off using cat >> ${targetFile} (append mode) or rewrite the remainder.`;
              }

              // No salvageable heredoc content — truly broken command
              logger.warn(`[ToolRegistry] Repaired shell command is syntactically broken (${validation.reason}), refusing to execute`);
              return `Error: Command was cut off during streaming — nothing was written. Retry the file write. If the file is large, split into multiple smaller cat commands.`;
            }
            logger.warn(`[ToolRegistry] Repaired shell JSON, executing truncated command`);
            return await tool.executor.execute(projectId, repairResult.repaired, context);
          }
          logger.warn(`[ToolRegistry] Repaired ${toolId} but safety unknown, not executing`);
          return `Error: ${errorMessage}\n\nNote: JSON repair succeeded but operation type is unclear. Please split into smaller operations.`;
        }

        // JSON repair failed — but for bash heredoc writes we can still try to salvage.
        // Extract command content directly from the raw truncated JSON string.
        if (toolId === 'bash') {
          const rawArgs = toolCall.function.arguments;
          // Match: {"command": "cat > /file << 'DELIM'\ncontent... (or legacy "cmd")
          const rawHeredoc = rawArgs.match(/["'](?:command|cmd)["']\s*:\s*["']((?:cat|tee)\s+.*?>\s*(\S+).*?<<-?\s*['"]?\w+['"]?[^\n]*\\n[\s\S]{20,})/);
          if (rawHeredoc) {
            const unescaped = rawHeredoc[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            logger.warn(`[ToolRegistry] JSON repair failed but salvaged heredoc from raw JSON for ${rawHeredoc[2]}`);
            try {
              const result = await tool.executor.execute(projectId, { command: unescaped }, context);
              return result + `\n\nNote: Your output was truncated mid-write. The file ${rawHeredoc[2]} was written with partial content. Continue writing from where you left off using cat >> ${rawHeredoc[2]} (append mode) or rewrite the remainder.`;
            } catch {
              // Fall through to generic error
            }
          }
        }

        logger.error(`[ToolRegistry] JSON repair failed for ${toolId}:`, repairResult.error);
        return `Error: ${errorMessage}\n\nJSON repair failed. The tool call was likely truncated due to max_tokens limit. Split into smaller operations.`;
      }

      // Not a truncation error - return regular error
      logger.error(`Tool execution error (${toolId}):`, errorMessage);
      return `Error: ${errorMessage}`;
    }
  }

}

// Trailing incomplete operators that indicate the command was cut mid-syntax.
// Requires the operator to be at EOS after trimming whitespace, preceded by
// whitespace or start-of-string so operators appearing inside arguments aren't
// mistaken for trailing truncation.
const TRAILING_INCOMPLETE_OPERATOR_RE = /(?:^|\s)(?:<<?|>>?|\|\|?|&&)\s*$/;

function validateRepairedBashCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = cmd.replace(/\s+$/, '');
  if (!trimmed) {
    return { ok: false, reason: 'command is empty after repair' };
  }
  if (TRAILING_INCOMPLETE_OPERATOR_RE.test(trimmed)) {
    return {
      ok: false,
      reason: 'command ends with a dangling redirect, pipe, or logical operator'
    };
  }
  return { ok: true };
}

/**
 * Execute a single shell command segment (no && / || chaining).
 * Handles cd, python/lua, preview, server commands, and VFS shell fallthrough.
 * Returns empty string for success-no-output, 'Error: ...' for failures.
 */
export async function checkCommandPermission(
  cmdArray: string[],
  context: ToolExecutionContext,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const gateKey = classifyGateKey(cmdArray);
  if (!gateKey) return { allowed: true };

  const mode = context.permissionMode ?? configManager.getPermissionMode();
  const overrides = context.permissionOverrides ?? configManager.getPermissionOverrides();
  if (!needsApproval(gateKey, mode, overrides)) return { allowed: true };

  // Server-side generation: no live UI. Emit `approval_required` (which the tool executor
  // turns into an awaiting_user pause) and decline this attempt. The client shows a persisted
  // Allow/Deny prompt; the user's choice restarts the task with the decision applied.
  if (context.pauseForApproval) {
    const command = cmdArray.join(' ');
    context.onProgress?.('approval_required', { gateKey, command, capabilityLabel: capabilityLabel(gateKey) });
    return {
      allowed: false,
      reason: `Paused: awaiting your approval for ${capabilityLabel(gateKey)} ("${cmdArray[0]}"). The task will continue once you allow or deny it — do not retry.`,
    };
  }

  // Gated but no interactive UI -> allow (cannot prompt, must not hang).
  if (!context.onApprovalNeeded) return { allowed: true };

  const outcome = await context.onApprovalNeeded({
    command: cmdArray.join(' '),
    gateKey,
    capabilityLabel: capabilityLabel(gateKey),
  });

  if (outcome === 'always') configManager.setPermissionOverride(gateKey, 'allow');
  if (outcome === 'deny') {
    // In server-side generation there is no UI to prompt, so the runner's callback declines
    // automatically — do not blame the user, and name the capability so the reason is actionable.
    return { allowed: false, reason: `${capabilityLabel(gateKey)} is not available for "${cmdArray[0]}" here (declined). Do not retry; continue without it.` };
  }
  return { allowed: true };
}

/**
 * The stages of a pipeline, so each can be checked as the separate command the shell runs it as.
 * A command with no `|` is a single stage, which is why every caller can use this unconditionally.
 */
function pipelineStages(cmdArray: string[]): string[][] {
  if (!cmdArray.includes('|')) return [cmdArray];
  const stages: string[][] = [];
  let current: string[] = [];
  for (const token of cmdArray) {
    if (token === '|') {
      if (current.length > 0) stages.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) stages.push(current);
  return stages;
}

async function executeShellSegment(
  projectId: string,
  cmdArray: string[],
  context: ToolExecutionContext,
  heredocStdin?: string
): Promise<string> {
  const command = cmdArray[0];
  if (!command) return 'Error: empty command';

  // A pipeline is one command here and several in the shell, which splits on `|` and runs each
  // stage. Gating only `cmdArray` read the first stage and let every later one through, so
  // `ls / | rm /file` wrote under a read-only grant. Each stage is checked as its own command.
  for (const stage of pipelineStages(cmdArray)) {
    const stageCommand = stage[0];
    if (!stageCommand) continue;

    const permission = await checkCommandPermission(stage, context);
    if (!permission.allowed) {
      return permission.reason;
    }

    // Block write operations in read-only mode
    if (context.isReadOnly && isWriteOperation(stage)) {
      return `Error: Write operations are disabled in read-only mode. "${stageCommand}" is not allowed.`;
    }

    // Enforce per-agent write scope (reads unrestricted; writes confined to a directory)
    if (context.writeScope) {
      const scopeCheck = checkWriteScope(stage, context.writeScope);
      if (!scopeCheck.allowed) {
        return `Error: ${scopeCheck.reason}.`;
      }
    }
  }

  // cd — no-op (VFS has no working directory concept)
  if (command === 'cd') {
    return '';
  }

  // Script execution commands (python, python3, lua)
  if (command === 'python' || command === 'python3' || command === 'lua') {
    if (typeof window === 'undefined') {
      return `Error: ${command} execution requires the browser runtime (Pyodide/Fengari). This command is not available during server-side generation. Write the script file and it will run when the user opens the preview.`;
    }

    const sr: ScriptRuntime = command === 'lua' ? 'lua' : 'python';

    // Fast-fail when the browser is known to be offline. The runtime (Pyodide/wasmoon) is
    // fetched from a CDN on first use, so there is no point spinning up the worker and
    // waiting for a fetch that will fail. (navigator.onLine === true is not a guarantee of
    // reachability — the CDN could still be blocked — so the worker also reports load
    // failures with an actionable message.)
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return `Error: ${command} is unavailable — the ${sr === 'lua' ? 'Lua' : 'Python'} runtime is downloaded from a CDN on first use and the browser is offline. Write the script to a file for the user to run later; do not retry ${command} until connectivity is restored.`;
    }

    // Resolve the program source. Preferred form is `python <file>` (the only form the
    // system prompt documents). We also gracefully accept the shapes models reach for when
    // they go off-script — inline code (`-c '<code>'`) and stdin (`python - << 'EOF'`) — by
    // running the source through a synthetic entry point rather than treating `-c`/`-` as a
    // file path (which used to produce a confusing "Entry point not found: /-c").
    const arg1 = cmdArray[1];
    let entryPoint: string;
    let inlineSource: string | undefined;
    const inlineEntry = sr === 'lua' ? '/__inline__.lua' : '/__inline__.py';
    if (arg1 === '-c') {
      inlineSource = cmdArray[2];
      if (inlineSource == null) return `Error: Usage: ${command} -c '<code>'`;
      entryPoint = inlineEntry;
    } else if (arg1 === '-' || (arg1 === undefined && heredocStdin != null)) {
      if (!heredocStdin) return `Error: Usage: ${command} <file>  (or pipe code via: ${command} - << 'EOF' … EOF)`;
      inlineSource = heredocStdin;
      entryPoint = inlineEntry;
    } else {
      if (!arg1) return `Error: Usage: ${command} <file>`;
      entryPoint = arg1.startsWith('/') ? arg1 : '/' + arg1;
    }

    // Scan the source to decide whether to warn that sandbox file writes are discarded.
    let scanSource: string | undefined = inlineSource;
    if (scanSource == null) {
      try {
        const v = getActiveVFS();
        await v.init();
        const f = await v.readFile(projectId, entryPoint);
        if (typeof f.content === 'string') scanSource = f.content;
      } catch { /* missing entry point is reported by the runner below */ }
    }
    const writeAdvisory = scriptMayWriteFiles(scanSource, sr)
      ? '\n\n(note: scripts run in an isolated sandbox — writes to project files are NOT saved (only stdout above and files under /output/ persist). To edit files use ss or cat >.)'
      : '';

    return new Promise<string>((resolve) => {
      const output: string[] = [];
      let resolved = false;

      const unsubscribe = scriptRunner.onOutput((msg) => {
        switch (msg.type) {
          case 'stdout': output.push(msg.data); break;
          case 'stderr': output.push(`[stderr] ${msg.data}`); break;
          case 'error': output.push(`[error] ${msg.data}`); break;
          case 'complete':
            unsubscribe();
            resolved = true;
            const text = output.join('\n').trim();
            if (msg.exitCode === 0) {
              const base = text || 'Script completed with no output';
              resolve(base + writeAdvisory);
            } else {
              resolve(`Error (exit ${msg.exitCode}):\n${text}`);
            }
            break;
        }
      });

      scriptRunner.execute(projectId, sr, entryPoint, inlineSource).catch((err) => {
        if (!resolved) {
          unsubscribe();
          resolve(`Error: ${err}`);
        }
      });
    });
  }

  // Preview navigation command
  if (command === 'preview') {
    const targetPath = cmdArray[1] || '/';
    const normalizedPath = targetPath.startsWith('/') ? targetPath : '/' + targetPath;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('showPreview'));
      window.dispatchEvent(new CustomEvent('previewNavigate', { detail: { path: normalizedPath } }));
    }

    return `Preview navigated to ${normalizedPath}`;
  }

  // Server-side execution (sqlite3)
  const activeVFS = getActiveVFS();
  const serverCommands = ['sqlite3'];
  const deploymentId = activeVFS.getRuntimeDeploymentId();

  if (serverCommands.includes(command) && deploymentId) {
    try {
      // Use workspace-scoped URL if in server mode with a workspace cookie
      const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
      const workspaceId = isServerMode ? readWorkspaceCookie() : undefined;
      const bashUrl = workspaceId ? `/api/w/${workspaceId}/bash/execute` : '/api/bash/execute';
      const response = await apiFetch(bashUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deploymentId, cmd: cmdArray })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return `Error: ${errorData.stderr || 'Server request failed'}`;
      }

      const result = await response.json();

      if (result.exitCode === 0) {
        return result.stdout && result.stdout.trim().length > 0 ? result.stdout : '';
      } else {
        return `Error: ${result.stderr || 'Command failed'}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Server request failed'; // i18n-ignore: returned to the agent
      return `Error: ${message}`;
    }
  }

  // Delegate — handled at orchestrator level, never reaches here in normal flow.
  // Safety net: if it does, return an error directing to proper usage.
  if (command === 'agent' || command === 'delegate') {
    return 'Error: agent requires a type. Usage: bash({ command: "agent explore|task|plan \'prompt\'" })';
  }

  // VFS shell fallthrough (handles pipes, redirects, etc.)
  const result = await vfsShell.execute(projectId, cmdArray, heredocStdin, {
    onProgress: context.onProgress,
    generateImage: context.generateImage,
    readVersions: context.readVersions,
    onBuildRequested: context.onBuildRequested,
    onSearchRequested: context.onSearchRequested,
  });

  // Refresh server context if shell command modified .server/ files
  if (isWriteOperation(cmdArray) && cmdArray.some(a => a.includes('/.server/'))) {
    if (activeVFS.hasServerContext()) {
      await activeVFS.refreshServerContext();
    }
  }

  if (!result.success) {
    const message = result.stderr && result.stderr.trim().length > 0 ? result.stderr : 'Command failed';
    return `Error: ${message}`;
  }

  return result.stdout && result.stdout.trim().length > 0 ? result.stdout : '';
}

/**
 * Split a parsed command array by && and || chain operators into segments.
 */
function splitChainOperators(cmdArray: string[]): { args: string[]; nextOp: '&&' | '||' | ';' | null }[] {
  const segments: { args: string[]; nextOp: '&&' | '||' | ';' | null }[] = [];
  let current: string[] = [];

  for (const token of cmdArray) {
    if (token === '&&' || token === '||' || token === ';') {
      if (current.length > 0) {
        segments.push({ args: current, nextOp: token as '&&' | '||' | ';' });
        current = [];
      }
    } else {
      current.push(token);
    }
  }

  if (current.length > 0) {
    segments.push({ args: current, nextOp: null });
  }

  return segments;
}

/**
 * Heuristic: does this script source attempt to write/delete files on disk?
 * Used only to decide whether to append the "sandbox writes aren't saved" advisory —
 * false positives merely add one advisory line; false negatives are the costly case, so
 * the patterns lean broad on the filesystem-mutating APIs.
 */
function scriptMayWriteFiles(src: string | undefined, runtime: ScriptRuntime): boolean {
  if (!src) return false;
  if (runtime === 'lua') {
    return /\bio\.open\s*\(|\bio\.write\s*\(|\bos\.(remove|rename)\s*\(/.test(src);
  }
  return /\bwrite_text\s*\(|\bwrite_bytes\s*\(|\bopen\s*\([^)]*,\s*['"][^'"]*[wax]|\bos\.(remove|rename|replace|mkdir|makedirs|rmdir)\s*\(|\bshutil\.\w+\s*\(|\.unlink\s*\(/.test(src);
}

/**
 * Unescape HTML entities that models sometimes emit in tool call arguments.
 * Applied only to the command portion of a bash string — never to heredoc bodies.
 */
function unescapeHtmlEntities(cmd: string): string {
  if (!cmd.includes('&')) return cmd;
  return cmd
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Parse a shell command string into an array of arguments
 */
export function parseBashCommand(cmdStr: string): string[] {
  const args: string[] = [];
  const wasQuoted: boolean[] = [];
  // Offset in each token just past its final closing quote. Everything from there on was typed
  // unquoted, so it is the only part an operator may be split out of.
  const quotedEnds: number[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let escaped = false;
  let argWasQuoted = false;
  let quotedEnd = 0;

  for (let i = 0; i < cmdStr.length; i++) {
    const char = cmdStr[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (inQuotes) {
      if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
        quotedEnd = current.length;
      } else if (quoteChar === '"' && char === '\\') {
        // Double quotes: only \" and \\ are escape sequences; other backslashes are literal
        const next = cmdStr[i + 1];
        if (next === '"' || next === '\\') {
          escaped = true;
          continue;
        }
        current += char;
      } else {
        // Single quotes: everything is literal (including backslashes)
        current += char;
      }
    } else {
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"' || char === "'") {
        inQuotes = true;
        quoteChar = char;
        argWasQuoted = true;
      } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        if (current.length > 0 || argWasQuoted) {
          args.push(current);
          wasQuoted.push(argWasQuoted);
          quotedEnds.push(quotedEnd);
          current = '';
          argWasQuoted = false;
          quotedEnd = 0;
        }
      } else {
        current += char;
      }
    }
  }

  if (current.length > 0 || argWasQuoted) {
    args.push(current);
    wasQuoted.push(argWasQuoted);
    quotedEnds.push(quotedEnd);
  }

  const split = splitOperatorTokens(args, wasQuoted, quotedEnds);

  // Expand brace patterns like {a,b,c} — but not inside quoted arguments (matches bash behavior)
  return expandBraces(split.args, split.wasQuoted);
}

/** `;`, `&&`, `||` and `|`, longest first so `||` is not read as two pipes. */
const OPERATOR_SPLIT_RE = /(\|\||&&|;|\|)/;

/**
 * A glued output redirect: `ls>out.txt`, `cat a>>b`.
 *
 * The operator must be followed by something a filename can start with. That lookahead is what
 * keeps `-->` intact — a trailing `>` with no target is not a redirect, and HTML written without
 * quotes is far more common here than a redirect someone forgot to space out.
 */
const GLUED_REDIRECT_RE = /(>>|>)(?=[\w./~])/;

/** `2>`, `1>>`, `&>`, `2>/dev/null`, `2>&1` — stripBashRedirects matches these whole, so leave them. */
const FD_REDIRECT_RE = /^(?:0|1|2|&)>>?/;

/** Tokens carrying a `<` are treated as content, not redirection: `<p>hi</p>` must survive intact. */
function canSplitRedirect(token: string): boolean {
  return !token.includes('<') && !FD_REDIRECT_RE.test(token) && GLUED_REDIRECT_RE.test(token);
}

/**
 * Separate control operators that were written without surrounding spaces.
 *
 * Everything downstream detects operators by whole-token equality, so `head -c 600; echo` left
 * `600;` as one token and the `;` was never seen — the pipe splitter then swallowed the rest of
 * the line and the last bare word became the command's file argument. Unquoted operators are
 * separators in bash regardless of spacing, so splitting here matches the shell being imitated.
 *
 * Quoted arguments are left alone: `echo "a;b"` is one literal argument, as in bash.
 */
function splitOperatorTokens(
  args: string[],
  wasQuoted: boolean[],
  quotedEnds: number[]
): { args: string[]; wasQuoted: boolean[] } {
  const outArgs: string[] = [];
  const outQuoted: boolean[] = [];
  const isOperator = (s: string) => s === ';' || s === '&&' || s === '||' || s === '|';

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // Only the run after the last closing quote is eligible. Testing the whole token treated
    // `echo '---'; date` as one quoted argument, so the `;` never became an operator and `date`
    // was swallowed as an argument to echo.
    const qEnd = quotedEnds[i] ?? 0;
    const head = token.slice(0, qEnd);
    const tail = token.slice(qEnd);
    if (!OPERATOR_SPLIT_RE.test(tail) && !canSplitRedirect(tail)) {
      outArgs.push(token);
      outQuoted.push(wasQuoted[i]);
      continue;
    }

    const pieces: string[] = [];
    for (const chained of tail.split(OPERATOR_SPLIT_RE)) {
      if (chained === '') continue;
      const split = canSplitRedirect(chained) ? chained.split(GLUED_REDIRECT_RE) : [chained];
      for (const piece of split) {
        if (piece !== '') pieces.push(piece);
      }
    }

    // The quoted run belongs to whatever came before the first operator: its own argument when
    // the tail opens with one (`'---';`), otherwise glued to the first piece (`'q'x;y` → `qx`).
    if (head) {
      if (pieces.length === 0 || isOperator(pieces[0])) {
        outArgs.push(head);
        outQuoted.push(true);
      } else {
        pieces[0] = head + pieces[0];
      }
    }
    for (const piece of pieces) {
      outArgs.push(piece);
      outQuoted.push(head !== '' && piece.startsWith(head));
    }
  }

  return { args: outArgs, wasQuoted: outQuoted };
}

/**
 * Expand brace patterns in arguments (e.g., "file{1,2,3}.txt" -> ["file1.txt", "file2.txt", "file3.txt"])
 * Skips quoted arguments — bash does not expand braces inside quotes.
 */
function expandBraces(args: string[], wasQuoted?: boolean[]): string[] {
  const expanded: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (wasQuoted?.[i]) {
      expanded.push(arg);
      continue;
    }
    // Check if arg contains brace expansion pattern
    const braceMatch = arg.match(/^(.+)\{([^}]+)\}(.*)$/);

    if (braceMatch) {
      const [, prefix, items, suffix] = braceMatch;
      const itemList = items.split(',').map(item => item.trim());
      for (const item of itemList) {
        expanded.push(prefix + item + suffix);
      }
    } else {
      expanded.push(arg);
    }
  }

  return expanded;
}

/**
 * Check if a command is a write operation
 */
function isWriteOperation(cmd: string[]): boolean {
  if (!cmd || cmd.length === 0) return false;

  // From the command registry, so a new writing command is gated here without a second edit.
  if (alwaysWriteCommands().has(cmd[0])) {
    return true;
  }

  // sed -i is a write operation (in-place edit), sed without -i is read-only (stdout)
  if (cmd[0] === 'sed' && cmd.includes('-i')) {
    return true;
  }

  // curl -o/--output writes to a file; plain curl is read-only
  if (cmd[0] === 'curl' && (cmd.includes('-o') || cmd.includes('--output'))) {
    return true;
  }

  // Check for echo with redirection (echo > file or echo >> file)
  if (cmd[0] === 'echo') {
    // Look for > or >> in any argument
    return cmd.some(arg => arg === '>' || arg === '>>');
  }

  // Check for redirection operators in any command
  // This catches cases like: cat file > output.txt
  return cmd.some(arg => arg === '>' || arg === '>>');
}

/**
 * Check if a string has unbalanced quotes (i.e., we're inside an open quote).
 * Respects escape sequences in double quotes (\" is not a closing quote).
 * In single quotes, backslash is literal (no escaping) per POSIX.
 */
function hasUnbalancedQuotes(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inDouble) { i++; continue; }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

/**
 * Split a newline-separated command string into individual commands,
 * preserving heredoc blocks and multiline quoted strings as part of their parent command.
 * E.g., "mkdir -p dir\ncat > file << 'EOF'\ncontent\nEOF\nls" → 3 commands
 */
export function splitNewlineCommands(cmdStr: string): string[] {
  const lines = cmdStr.split('\n');
  const commands: string[] = [];
  let current = '';
  let heredocDelimiter: string | null = null;

  for (const line of lines) {
    if (heredocDelimiter) {
      // Inside a heredoc — accumulate until we hit the end delimiter
      current += '\n' + line;
      if (line.trim() === heredocDelimiter) {
        // Heredoc closed — the command is complete. Flush it now and reset so the
        // heredoc BODY never feeds the quote-balance heuristic below. Otherwise a body
        // with an odd number of quotes makes hasUnbalancedQuotes(current) true and the
        // NEXT chained heredoc command gets swallowed as a fake quote-continuation
        // (e.g. three chained `cat > f << 'EOF'` blocks collapsing into two).
        heredocDelimiter = null;
        const trimmed = current.trim();
        if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
        current = '';
      }
      continue;
    }

    // Inside an unclosed quote — accumulate until quotes balance
    if (current && hasUnbalancedQuotes(current)) {
      current += '\n' + line;
      continue;
    }

    // Check if this line starts a heredoc
    const heredocStart = line.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (heredocStart) {
      if (current) {
        const trimmed = current.trim();
        if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
        current = '';
      }
      current = line;
      heredocDelimiter = heredocStart[1];
      continue;
    }

    // Regular line — accumulate in current buffer
    // (don't push directly — next iteration's unbalanced quote check needs to see it)
    if (current) {
      const prevTrimmed = current.trim();
      if (prevTrimmed && !prevTrimmed.startsWith('#')) commands.push(prevTrimmed);
    }
    current = line;
  }

  // Flush remaining
  if (current) {
    const trimmed = current.trim();
    if (trimmed && !trimmed.startsWith('#')) commands.push(trimmed);
  }

  return commands;
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
