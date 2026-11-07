/**
 * OswsToolExecutor - Handles individual tool call execution with signal extraction.
 *
 * Responsibilities:
 * - Sanitize tool names (strip harmony tokens)
 * - Validate tool access per agent type
 * - Dispatch to toolRegistry
 * - Extract signals from results (statusComplete, statusResult, setupComplete, awaitingUser)
 * - Emit progress events (tool_status, tool_result)
 * - Provide onAfterExecute hook for facade checkpoint logic
 */

import type { ToolExecutor, ToolCall, ToolResult, ToolExecContext, ToolDef, ProgressReporter } from './core/types';
import { STATUS_SEGMENT_RE, parseStatusCommand, type StatusFlags } from './status-command';
import { toolRegistry, ToolExecutionContext } from './tool-registry';
import { Agent } from './agent';
import { generalCommandNames, setupOnlyCommandNames } from '@/lib/vfs/shell-commands';
import type { ApprovalRequest, ApprovalOutcome, PermissionMode, GateDecision } from './permissions';

const HARMONY_TOKEN_STRIP_RE = /<\|[^|]*\|>/g;

export interface OswsToolExecutorConfig {
  projectId: string;
  progress: ProgressReporter;
  getAgent: () => Agent;
  chatMode: boolean;
  abortSignal: AbortSignal;
  generateImage?: (prompt: string, opts: { aspectRatio?: string; imageSize?: string }) => Promise<{ base64: string; mimeType: string }>;
  onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalOutcome>;
  permissionMode?: PermissionMode;
  permissionOverrides?: Record<string, GateDecision>;
  /** Conversation-scoped file-version map for the read-before-edit guard.
   *  Owned by the orchestrator (persists across messages) and shared with child
   *  executors, so a baseline recorded in one task survives into the next. */
  readVersions?: Map<string, number>;
  /** Delegate a build to the browser (server-side generation only). */
  onBuildRequested?: () => Promise<{ success: boolean; errors?: string[] }>;
  /** Delegate a web search to the browser (server-side generation only). */
  onSearchRequested?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Server-side generation: pause (awaiting_user) on gated commands instead of prompting. */
  pauseForApproval?: boolean;
}

export class OswsToolExecutor implements ToolExecutor {
  onAfterExecute?: (toolCall: ToolCall, result: ToolResult, durationMs: number) => Promise<void>;

  constructor(private config: OswsToolExecutorConfig) {}

  getDefinitions(agentType: string): ToolDef[] {
    const agent = this.config.getAgent();
    const defs = toolRegistry.getDefinitions(agent.tools, agentType);
    const isServerSide = !!this.config.onBuildRequested || typeof window === 'undefined';
    return defs.map(d => {
      let description = d.description;
      if (isServerSide && d.name === 'bash') {
        description = description
          .replace(/, python, python3, lua/, '')
          .replace(/Run scripts: python[^\n]*\n/g, '');
      }
      return {
        name: d.name,
        description,
        parameters: d.parameters as Record<string, unknown>,
      };
    });
  }

  async execute(toolCall: ToolCall, context: ToolExecContext): Promise<ToolResult> {
    const startedAt = Date.now();

    // 1. Sanitize tool name (strip <|...|> harmony tokens)
    const rawName = toolCall.function?.name;
    const toolId = rawName?.replace(HARMONY_TOKEN_STRIP_RE, '').trim();

    if (!toolId) {
      return {
        tool_call_id: toolCall.id,
        content: 'Error: Tool call has no function name. Available tools: bash.',
        success: false,
      };
    }

    // 2. Validate tool access
    const agent = this.config.getAgent();
    if (!agent.hasTool(toolId)) {
      const errorMsg = this.buildToolAccessError(toolId, agent.type);
      this.config.progress.onEvent('tool_status', {
        toolCallId: toolCall.id,
        toolName: toolId,
        status: 'failed',
        args: toolCall.function?.arguments,
      });
      return { tool_call_id: toolCall.id, content: errorMsg, success: false };
    }

    // 3. Emit executing status
    this.config.progress.onEvent('tool_status', {
      toolCallId: toolCall.id,
      toolName: toolId,
      status: 'executing',
      args: toolCall.function.arguments,
    });

    // 4. Dispatch to registry with signal/ask/setup detection
    let setupComplete = false;
    let awaitingUser = false;

    const execContext: ToolExecutionContext = {
      agentType: context.agentType,
      isReadOnly: context.isReadOnly || this.config.chatMode,
      writeScope: agent.writeScope,
      onProgress: (event, data) => {
        // `approval_required` (server-side gated command) pauses the run the same way `ask`
        // does — the client then shows a persisted Allow/Deny prompt and restarts the task.
        if (event === 'ask' || event === 'approval_required') awaitingUser = true;
        if (event === 'project_ready') setupComplete = true;
        this.config.progress.onEvent(event, data);
      },
      generateImage: this.config.generateImage,
      onApprovalNeeded: this.config.onApprovalNeeded,
      permissionMode: this.config.permissionMode,
      permissionOverrides: this.config.permissionOverrides,
      readVersions: this.config.readVersions,
      onBuildRequested: this.config.onBuildRequested,
      onSearchRequested: this.config.onSearchRequested,
      pauseForApproval: this.config.pauseForApproval,
    };

    try {
      const resultContent = await Promise.race([
        toolRegistry.execute(toolCall, this.config.projectId, execContext),
        new Promise<string>((_, reject) => {
          if (this.config.abortSignal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          this.config.abortSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        }),
      ]);

      const isError = resultContent.startsWith('Error:');
      const signals = this.extractSignals(toolCall, resultContent, setupComplete, awaitingUser, isError);

      const result: ToolResult = {
        tool_call_id: toolCall.id,
        content: resultContent,
        success: !isError,
        ...(Object.keys(signals).length > 0 && { signals }),
      };

      this.config.progress.onEvent('tool_status', {
        toolCallId: toolCall.id,
        toolName: toolId,
        status: isError ? 'failed' : 'completed',
        result: resultContent,
        ...(isError && { error: resultContent }),
      });
      this.config.progress.onEvent('tool_result', { toolCallId: toolCall.id, result: resultContent });

      if (this.onAfterExecute) await this.onAfterExecute(toolCall, result, Date.now() - startedAt);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        tool_call_id: toolCall.id,
        content: `Error: ${errorMessage}`,
        success: false,
      };

      this.config.progress.onEvent('tool_status', {
        toolCallId: toolCall.id,
        toolName: toolId,
        status: 'failed',
        error: errorMessage,
      });

      if (this.onAfterExecute) await this.onAfterExecute(toolCall, result, Date.now() - startedAt);

      return result;
    }
  }

  /**
   * Extract signals from a tool call result. Inspects the command and output
   * to detect status completions, setup events, and user-awaiting states.
   */
  private extractSignals(
    toolCall: ToolCall,
    output: string,
    setupComplete: boolean,
    awaitingUser: boolean,
    isError = false,
  ): Record<string, unknown> {
    const signals: Record<string, unknown> = {};

    if (setupComplete) signals.setupComplete = true;
    if (awaitingUser) signals.awaitingUser = true;

    // A failed command completes nothing. Models chain `edit && build && status --complete`;
    // when the edit fails the chain stops there and `status` never runs, but the flag is
    // still in the command text, and honouring it ended the task on an unapplied edit.
    if (isError) return signals;

    // Parse the command from tool call arguments
    let cmd = '';
    try {
      const args = JSON.parse(toolCall.function.arguments);
      cmd = typeof (args.command ?? args.cmd) === 'string' ? (args.command ?? args.cmd) : '';
    } catch {
      return signals;
    }

    // Detect status commands (also when chained after another command)
    if (STATUS_SEGMENT_RE.test(cmd)) {
      // Simple complete detection: command contains "complete" flag but not "--incomplete"
      if (/--complete\b/i.test(cmd) && !/--incomplete\b/i.test(cmd)) {
        signals.statusComplete = true;
      }

      // Also detect "status complete ..." shorthand
      if (/^\s*status\s+complete\b/i.test(cmd)) {
        signals.statusComplete = true;
      }

      // Full status result extraction
      const statusResult = this.extractStatusResult(cmd, output);
      if (statusResult) {
        signals.statusResult = statusResult;
        if (statusResult.complete) signals.statusComplete = true;
      }
    }

    return signals;
  }

  /**
   * Extract structured status result from a shell command or its output.
   * Detects: `status --task "..." --done "..." --remaining "..." --complete`
   */
  private extractStatusResult(
    cmd: string,
    output: string
  ): StatusFlags | null {
    // If the output contains an error, the status command failed - don't trust command-level parsing
    const hasError = output && /^Error:\s/im.test(output);

    // 1. Check shell output for Remaining:/Complete: lines (from cli-shell status handler)
    // Prefer output over command parsing — the shell parsed the arguments
    // properly (escaped quotes etc.), the command regexes below cannot.
    // Task:/Done: lines only exist in the legacy full-echo format.
    if (output) {
      const taskLine = output.match(/^Task:\s*(.+)/im);
      const doneLine = output.match(/^Done:\s*(.+)/im);
      const remainingLine = output.match(/^Remaining:\s*(.*)/im);
      const completeLine = output.match(/^Complete:\s*(yes|no)/im);
      if (completeLine) {
        return {
          task: taskLine ? taskLine[1].trim() : '',
          done: doneLine ? doneLine[1].trim() : '',
          remaining: remainingLine ? remainingLine[1].trim() : 'none',
          complete: completeLine[1].toLowerCase() === 'yes',
          hasExplicitFlag: true,
        };
      }
    }

    // 2. Fallback: check the command itself for `status --task ... --done ... --remaining ...`
    // Skip if the output had errors - the command may have been malformed
    if (!hasError) {
      const parsed = parseStatusCommand(cmd);
      if (parsed) return parsed;
    }

    return null;
  }

  /**
   * Build a helpful error message when a tool is not accessible to the current agent.
   * Guides the model to use the correct tool invocation pattern.
   */
  private buildToolAccessError(toolId: string, agentType: string): string {
    const knownBashCommands = generalCommandNames();
    const setupOnlyCommands = setupOnlyCommandNames();
    const isSetupCommand = setupOnlyCommands.has(toolId);
    const isBashCommand = knownBashCommands.has(toolId) || (isSetupCommand && agentType === 'setup');

    if (toolId === 'ss') {
      return `Error: "ss" is not a tool — it is a bash command. Call it via the bash tool:\n\n  bash({ command: "ss /file << 'EOF'\\nsearch text\\n=======\\nreplacement text\\nEOF" })`;
    }

    if (isBashCommand) {
      return `Error: "${toolId}" is not a tool — it is a bash command. Use the bash tool to run it:\n\n  bash({ command: "${toolId} ..." })`;
    }

    const isServerSide = !!this.config.onBuildRequested || typeof window === 'undefined';
    const commandList = agentType === 'setup'
      ? 'brief, spec, ask, propose-create'
      : isServerSide
        ? 'ls, tree, cat, head, tail, rg, grep, find, mkdir, touch, rm, mv, cp, echo, sed, ss, wc, sort, uniq, tr, curl, sqlite3, preview, build, status'
        : 'ls, tree, cat, head, tail, rg, grep, find, mkdir, touch, rm, mv, cp, echo, sed, ss, wc, sort, uniq, tr, curl, sqlite3, python, python3, lua, preview, build, status';

    return `Error: Unknown tool "${toolId}". Available tools: bash.\n\nThe bash tool supports these commands: ${commandList}`;
  }
}
