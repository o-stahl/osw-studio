// lib/llm/core/agent-loop.ts
// Portable agent execution loop — no browser imports, no VFS, no Next.js, no configManager.
// Coordinates: ProviderAdapter, ToolExecutor, ContextManager, ProgressReporter, CostTracker.

import type {
  ProviderAdapter,
  ToolExecutor,
  ContextManager,
  ProgressReporter,
  CostTracker,
  AgentLoopConfig,
  AgentLoopResult,
  ParsedResponse,
  ToolResult,
  ToolCall,
  ToolExecContext,
  ContentBlock,
} from './types';

// --- Helper functions ---

/** Harmony format token pattern (GPT-OSS and other harmony-format models) */
const HARMONY_TOKEN_RE = /<\|[^|]*\|>/;

/**
 * Detect if content contains malformed tool calls written as text/markdown
 * instead of proper function calling invocations.
 */
function detectMalformedToolCalls(content: string): boolean {
  if (!content) return false;

  const patterns = [
    /```(?:shell|bash|sh)\s*\n[\s\S]*?\n```/,
    /^(?:bash|shell)\s*\{\s*["']?(?:command|cmd)["']?\s*:/m,
    /^(?:bash|shell)\s*\[\s*["']/m,
    /```json\s*\n\s*\{\s*["']?(?:command|cmd)["']?\s*:/,
  ];

  const hasPattern = patterns.some(p => p.test(content));
  if (!hasPattern) return false;

  const trimmed = content.trim();
  if (trimmed.length < 200) return true;

  const endsWithToolPattern = /(?:bash|shell)\s*\{\s*["']?(?:command|cmd)["']?\s*:.*\}\s*$/.test(trimmed) ||
                               /```(?:shell|bash|sh)\s*\n[\s\S]*?\n```\s*$/.test(trimmed);
  return endsWithToolPattern;
}

/**
 * Extract shell commands from text when the model doesn't support native tool calling.
 */
function extractToolCallsFromText(content: string): ToolCall[] | undefined {
  if (!content) return undefined;

  const commands: string[] = [];
  let match;

  // Pattern 1: ```bash/shell/sh code blocks
  const bashBlockRe = /```(?:bash|shell|sh)\s*\n([\s\S]*?)\n```/g;
  while ((match = bashBlockRe.exec(content)) !== null) {
    const block = match[1].trim();
    if (block) commands.push(block);
  }

  // Pattern 2: ```tool_code blocks (Gemini-style)
  const toolCodeRe = /```tool_code\s*\n([\s\S]*?)\n```/g;
  while ((match = toolCodeRe.exec(content)) !== null) {
    const block = match[1].trim();
    const runCmdMatch = block.match(/(?:bash|shell)\.run_command\(["']([\s\S]*?)["']\)/);
    if (runCmdMatch) {
      commands.push(runCmdMatch[1].replace(/\\"/g, '"'));
    }
  }

  // Pattern 3: bash{"command": "..."} or shell{"cmd": "..."} etc.
  const toolJsonRe = /(?:bash|shell)\s*\(?\s*\{\s*["']?(?:command|cmd)["']?\s*:\s*["']([\s\S]*?)["']\s*\}\s*\)?/g;
  while ((match = toolJsonRe.exec(content)) !== null) {
    if (match[1].trim()) commands.push(match[1].trim());
  }

  if (commands.length === 0) return undefined;

  return commands.map((cmd, i) => ({
    id: `text-tool-${Date.now()}-${i}`,
    type: 'function' as const,
    function: {
      name: 'bash',
      arguments: JSON.stringify({ command: cmd }),
    },
  }));
}

/**
 * Generate a normalized signature for a tool call to detect duplicates.
 */
function getToolCallSignature(toolCall: ToolCall): string {
  const toolName = toolCall.function?.name || 'unknown';
  try {
    const args = JSON.parse(toolCall.function.arguments);
    if (toolName === 'bash' || toolName === 'shell') {
      const rawCmd = args.command ?? args.cmd;
      const cmd = Array.isArray(rawCmd)
        ? rawCmd.join(' ')
        : String(rawCmd || '');
      return `${toolName}:${cmd}`;
    }
    return `${toolName}:${toolCall.function.arguments}`;
  } catch {
    return `${toolName}:${toolCall.function.arguments}`;
  }
}

/**
 * Detect repeating patterns in a window of tool call signatures.
 * Checks for cycles of length 2-4 that repeat at least `threshold` times.
 * Returns the cycle length if found, null otherwise.
 */
function detectRepeatingPattern(signatures: string[], threshold: number): number | null {
  const len = signatures.length;
  for (let cycleLen = 2; cycleLen <= 4; cycleLen++) {
    if (len < cycleLen * threshold) continue;
    const checkLen = cycleLen * threshold;
    const tail = signatures.slice(len - checkLen);
    const cycle = tail.slice(0, cycleLen);
    let isRepeating = true;
    for (let i = cycleLen; i < checkLen; i++) {
      if (tail[i] !== cycle[i % cycleLen]) {
        isRepeating = false;
        break;
      }
    }
    if (isRepeating) return cycleLen;
  }
  return null;
}

// --- Constants ---

const MALFORMED_TOOL_CALL_ERROR = `⛔ CRITICAL ERROR: You wrote a tool call as TEXT instead of invoking it.

This is WRONG - you wrote text like:
  bash{"command": "..."}
  \`\`\`bash
  command
  \`\`\`

This is RIGHT - invoke tools directly via function calling:
  Call bash tool with parameter command="your command"

You MUST use function calling. DO NOT write tool syntax as text.
STOP writing text. START invoking tools. Try again NOW.`;

const MALFORMED_TOOL_CALL_PERSISTENT_REMINDER = `

⚠️ REMINDER: You have been writing tool calls as text instead of invoking them.
EVERY time you want to use a tool, you MUST invoke it via function calling.
DO NOT write bash{"command":...} as text - INVOKE the tools directly.`;

const wrongToolNameError = (name: string) =>
  `⛔ "${name}" is not a tool. The ONLY tool is \`bash\` — run every command through it: bash({ command: "${name} ..." }). Re-issue your last action as a single bash tool call.`;

const NUDGE_MESSAGE = 'Before finishing, run the status command:\n  status --task "..." --done "..." --remaining "..." --complete';

const TOOL_ERROR_RETRY_MESSAGE = 'Your previous command failed (likely a streaming issue). Continue your work — retry writing the file. If the file is large, split it into multiple smaller cat commands.';

const REASONING_ONLY_RETRY_MESSAGE = 'Your previous response contained only reasoning — no tool call and no user-visible text reached the conversation. Do not stop after thinking: invoke the bash tool via function calling to act (e.g. command="ls /"), or reply with your answer as plain text.';

const MAX_MALFORMED_RETRIES = 2;
const MAX_REASONING_ONLY_RETRIES = 2;

// Tool outputs at or above this size that byte-for-byte repeat an earlier
// result in the live context are replaced with a marker. Small outputs
// ("Command succeeded…", build acks) repeat legitimately and stay verbatim.
const RESULT_DEDUP_MIN_CHARS = 500;

const RESULT_DEDUP_MARKER = '(Output identical to a previous tool result above — not repeated to save context.)';

const MALFORMED_THRESHOLD_FOR_REMINDER = 3;
const PATTERN_REPEAT_THRESHOLD = 2;
const PATTERN_WINDOW_SIZE = 8;

/**
 * Wrap a harness-injected message so the model (and anyone reading the
 * history) can distinguish it from genuine user input. Still sent with
 * role 'user' — models weight user messages far more reliably than system
 * messages deep into a conversation.
 */
function harnessMessage(text: string): string {
  return `<automated_reminder>\n${text}\n</automated_reminder>`;
}

// --- Status result type ---

interface StatusResult {
  task: string;
  done: string;
  remaining: string;
  complete: boolean;
  hasExplicitFlag: boolean;
}

// --- AgentLoop class ---

export class AgentLoop {
  private stopped = false;
  private abortController = new AbortController();
  private turnCount = 0;
  private toolCallCount = 0;
  private nudgeCount = 0;
  private malformedToolCallRetries = 0;
  private totalMalformedToolCalls = 0;
  private reasoningOnlyRetries = 0;
  private lastToolCallSignature: string | null = null;
  private duplicateToolCallCount = 0;
  private recentToolSignatures: string[] = [];
  private lastIterationHadToolError = false;
  private lastStatusResult: StatusResult | null = null;
  // Context size from THIS loop's most recent response. Do not read promptTokens
  // from the shared CostTracker — parallel child loops record into it too, so
  // its last value may describe another loop's context.
  private lastPromptTokens = 0;

  private config: AgentLoopConfig;
  private provider: ProviderAdapter;
  private executor: ToolExecutor;
  private context: ContextManager;
  private progress: ProgressReporter;
  private cost: CostTracker;

  constructor(deps: {
    config: AgentLoopConfig;
    provider: ProviderAdapter;
    executor: ToolExecutor;
    context: ContextManager;
    progress: ProgressReporter;
    cost: CostTracker;
  }) {
    this.config = deps.config;
    this.provider = deps.provider;
    this.executor = deps.executor;
    this.context = deps.context;
    this.progress = deps.progress;
    this.cost = deps.cost;
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
  }

  async run(userPrompt: string | ContentBlock[]): Promise<AgentLoopResult> {
    this.context.addUserMessage(userPrompt);
    this.cost.resetTurn();

    let exitReason = '';

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      if (this.stopped) {
        exitReason = 'stopped';
        this.progress.onEvent('stopped', { reason: 'user' });
        break;
      }

      this.progress.onEvent('iteration', {
        current: iteration + 1,
        max: this.config.maxIterations,
        agent: this.config.agentType,
      });
      this.progress.onEvent('waiting', {});

      // Call provider
      let response: ParsedResponse;
      try {
        response = await this.provider.call({
          messages: this.context.getSanitizedMessages(),
          tools: this.executor.getDefinitions(this.config.agentType),
          signal: this.abortController.signal,
        });
      } catch (error) {
        if (this.stopped) {
          exitReason = 'stopped';
          this.progress.onEvent('stopped', { reason: 'user' });
          break;
        }
        if (this.config.onProviderError && error instanceof Error) {
          const action = await this.config.onProviderError(error);
          if (action === 'stop') {
            exitReason = 'error_stop';
            break;
          }
          continue;
        }
        throw error;
      }

      this.turnCount++;

      // Record usage/cost
      if (response.usage) {
        this.cost.record(response.usage, this.provider.getProvider(), this.provider.getModel());
        if (response.usage.promptTokens) this.lastPromptTokens = response.usage.promptTokens;
      }

      // Early-aborted mid-stream because the model called a tool that isn't
      // 'bash' (the only tool). The arguments were never generated, so there's
      // nothing to execute — nudge toward bash and retry.
      if (response.invalidToolName) {
        this.malformedToolCallRetries++;
        this.totalMalformedToolCalls++;
        if (this.malformedToolCallRetries <= MAX_MALFORMED_RETRIES) {
          // Keep any reasoning so the retry doesn't re-derive it from scratch.
          if (response.reasoningDetails?.length || (response.content && response.content.trim())) {
            this.context.addAssistantTurn({ content: response.content, reasoningDetails: response.reasoningDetails });
          }
          this.context.addUserMessage(harnessMessage(wrongToolNameError(response.invalidToolName)));
          this.progress.onEvent('malformed_tool_call', {
            retry: this.malformedToolCallRetries,
            maxRetries: MAX_MALFORMED_RETRIES,
            totalFailures: this.totalMalformedToolCalls,
            invalidToolName: response.invalidToolName,
          });
          continue;
        }
        // Over the retry limit — fall through; with no tool calls this is handled
        // as a finish/nudge below.
      }

      // Filter harmony artifacts from tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        response.toolCalls = response.toolCalls.filter(tc => {
          const rawName = tc.function?.name || '';
          return !HARMONY_TOKEN_RE.test(rawName);
        });
        if (response.toolCalls.length === 0) {
          response.toolCalls = undefined;
        }
      }

      // For models without native tool support: extract tool calls from text
      if (!this.provider.supportsTools() && response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
        const extracted = extractToolCallsFromText(response.content);
        if (extracted && extracted.length > 0) {
          response.toolCalls = extracted;
        }
      }

      // Detect malformed tool calls (tools WERE sent but model wrote text)
      if (this.provider.supportsTools() && response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
        if (detectMalformedToolCalls(response.content)) {
          this.malformedToolCallRetries++;
          this.totalMalformedToolCalls++;

          if (this.malformedToolCallRetries <= MAX_MALFORMED_RETRIES) {
            this.context.addAssistantTurn({ content: response.content });
            let errorMessage = MALFORMED_TOOL_CALL_ERROR;
            if (this.totalMalformedToolCalls >= MALFORMED_THRESHOLD_FOR_REMINDER) {
              errorMessage += MALFORMED_TOOL_CALL_PERSISTENT_REMINDER;
            }
            this.context.addUserMessage(harnessMessage(errorMessage));
            this.progress.onEvent('malformed_tool_call', {
              retry: this.malformedToolCallRetries,
              maxRetries: MAX_MALFORMED_RETRIES,
              totalFailures: this.totalMalformedToolCalls,
            });
            continue;
          }
          // Over consecutive limit - fall through
        }
      } else if (response.toolCalls && response.toolCalls.length > 0) {
        this.malformedToolCallRetries = 0;
        this.reasoningOnlyRetries = 0;
      }

      // --- NO TOOL CALLS: model wants to finish ---
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const hasContent = !!(response.content && response.content.trim());
        const hasReasoning = !!response.reasoningDetails?.length;

        // Explore/plan/setup agents exit immediately
        if (this.config.agentType === 'explore' || this.config.agentType === 'plan' || this.config.agentType === 'setup') {
          if (hasContent) {
            this.context.addAssistantTurn({ content: response.content, reasoningDetails: response.reasoningDetails });
          }
          exitReason = 'agent_type_exit';
          break;
        }

        // Persist the turn even when it is reasoning-only — dropping it would
        // erase the model's own thinking from history, so retries start from
        // scratch and produce near-identical reasoning every iteration.
        if (hasContent || hasReasoning) {
          this.context.addAssistantTurn({ content: response.content, reasoningDetails: response.reasoningDetails });
        }

        // Check structured status result
        if (this.lastStatusResult) {
          if (this.lastStatusResult.complete) {
            const gateResult = await this.runCompletionGate();
            if (gateResult) {
              this.context.addUserMessage(harnessMessage(gateResult));
              this.lastStatusResult = null;
              continue;
            }
            exitReason = 'status_complete';
            this.progress.onEvent('exit_reason', { reason: 'status_complete', iteration });
            break;
          } else if (this.lastStatusResult.hasExplicitFlag) {
            // Explicit --incomplete. With a message and no tool calls the model did no work and
            // addressed the user: a hand-back, not progress. Continuing re-prompts it with nothing
            // new, and it answers its own question rather than waiting. Without a message it is
            // mid-task and simply reported progress, so carry on.
            if (hasContent) {
              this.lastStatusResult = null;
              exitReason = 'awaiting_user';
              this.progress.onEvent('exit_reason', { reason: 'awaiting_user', iteration });
              break;
            }
            this.lastStatusResult = null;
            this.nudgeCount = 0;
            continue;
          } else {
            // No flag - check remaining field
            const rem = this.lastStatusResult.remaining.trim().toLowerCase();
            if (!rem || rem === 'none' || rem === 'n/a' || rem === 'nothing') {
              const gateResult = await this.runCompletionGate();
              if (gateResult) {
                this.context.addUserMessage(harnessMessage(gateResult));
                this.lastStatusResult = null;
                continue;
              }
              exitReason = 'status_remaining_empty';
              this.progress.onEvent('exit_reason', { reason: 'status_remaining_empty', iteration });
              break;
            } else {
              this.lastStatusResult = null;
              this.nudgeCount = 0;
              continue;
            }
          }
        }

        // Interview: a content turn with no status is a question — pause for the
        // user instead of nudging toward completion.
        if (this.config.agentType === 'interview' && hasContent) {
          exitReason = 'awaiting_user';
          this.progress.onEvent('exit_reason', { reason: 'awaiting_user', iteration });
          break;
        }

        // After tool error + empty response: inject retry prompt
        if (this.lastIterationHadToolError && !hasContent) {
          this.lastIterationHadToolError = false;
          this.context.addUserMessage(harnessMessage(TOOL_ERROR_RETRY_MESSAGE));
          this.progress.onEvent('tool_error_retry', { iteration });
          continue;
        }

        // Reasoning-only response: the model thought but never acted (its tool
        // call was lost upstream or never emitted). The status nudge is the
        // wrong feedback here — tell it directly to act via function calling.
        if (!hasContent && hasReasoning && this.reasoningOnlyRetries < MAX_REASONING_ONLY_RETRIES) {
          this.reasoningOnlyRetries++;
          this.progress.onEvent('reasoning_only_retry', {
            attempt: this.reasoningOnlyRetries,
            max: MAX_REASONING_ONLY_RETRIES,
            iteration,
          });
          this.context.addUserMessage(harnessMessage(REASONING_ONLY_RETRY_MESSAGE));
          continue;
        }

        // Nudge: ask model to report status
        if (this.nudgeCount < this.config.maxNudges) {
          this.nudgeCount++;
          this.progress.onEvent('nudge', { attempt: this.nudgeCount, max: this.config.maxNudges });
          this.context.addUserMessage(harnessMessage(NUDGE_MESSAGE));
          continue;
        }

        // Exhausted nudges
        exitReason = 'nudge_exhaustion';
        this.progress.onEvent('exit_reason', { reason: 'nudge_exhaustion', nudges: this.config.maxNudges, iteration });
        break;
      }

      // --- HAS TOOL CALLS: execute them ---
      const { results: toolResults, terminated } = await this.executeToolCalls(response.toolCalls);

      // Add assistant + tool results to context. Executed tools may have had
      // side effects, so they must be committed even when terminating —
      // getSanitizedMessages() synthesizes placeholders for unexecuted calls.
      this.context.addAssistantTurn(response);
      this.context.addToolResults(toolResults);

      // If execution was terminated by duplicate/pattern detection
      if (terminated) {
        exitReason = 'loop_detected';
        break;
      }

      // Track tool errors
      this.lastIterationHadToolError = toolResults.some(r => !r.success);

      // Check compaction — use this loop's reported prompt tokens, fall back to local estimate
      const promptTokens = this.lastPromptTokens || this.context.getTokenEstimate();
      if (this.context.needsCompaction(promptTokens)) {
        const preTokens = promptTokens;
        const compactionUsage = await this.context.compact(this.provider, { signal: this.abortController.signal });
        if (compactionUsage) {
          this.cost.record(compactionUsage, this.provider.getProvider(), this.provider.getModel());
        }
        const postEstimate = this.context.getTokenEstimate();
        this.progress.onEvent('compaction', { preCompactTokens: preTokens, postCompactEstimate: postEstimate });
      }

      // Check signals from tool results
      let shouldBreak = false;
      for (const result of toolResults) {
        if (!result.signals) continue;

        if (result.signals.statusComplete) {
          this.lastStatusResult = result.signals.statusResult as StatusResult || {
            task: '', done: '', remaining: 'none', complete: true, hasExplicitFlag: true,
          };
        }
        if (result.signals.statusResult) {
          this.lastStatusResult = result.signals.statusResult as StatusResult;
        }
        if (result.signals.setupComplete) {
          exitReason = 'setup_complete';
          shouldBreak = true;
        }
        if (result.signals.awaitingUser) {
          exitReason = 'awaiting_user';
          shouldBreak = true;
        }
      }

      if (shouldBreak) break;

      // If statusComplete found immediately after tool execution, check gate
      if (this.lastStatusResult?.complete) {
        const gateResult = await this.runCompletionGate();
        if (gateResult) {
          this.context.addUserMessage(harnessMessage(gateResult));
          this.lastStatusResult = null;
          continue;
        }
        exitReason = 'status_complete_post_tool';
        this.progress.onEvent('exit_reason', { reason: 'status_complete_post_tool', iteration });
        break;
      }
    }

    // Determine exit reason if loop exhausted
    if (!exitReason) {
      exitReason = 'max_iterations';
      this.progress.onEvent('exit_reason', { reason: 'max_iterations', maxIterations: this.config.maxIterations });
    }

    const success = exitReason === 'status_complete' ||
                    exitReason === 'status_complete_post_tool' ||
                    exitReason === 'status_remaining_empty' ||
                    exitReason === 'agent_type_exit' ||
                    exitReason === 'setup_complete' ||
                    exitReason === 'awaiting_user';

    const summary = this.buildSummary(exitReason);

    return {
      success,
      summary,
      exitReason,
      totalCost: this.cost.getTotalCost(),
      totalUsage: this.cost.getTotalUsage(),
      toolCount: this.toolCallCount,
      turnCount: this.turnCount,
    };
  }

  /**
   * Execute tool calls with duplicate/pattern detection.
   * `terminated` is true when execution stopped early due to loop detection;
   * `results` always contains everything that actually executed.
   */
  private async executeToolCalls(toolCalls: ToolCall[]): Promise<{ results: ToolResult[]; terminated: boolean }> {
    const results: ToolResult[] = [];
    const execContext: ToolExecContext = {
      agentType: this.config.agentType,
      isReadOnly: this.config.isReadOnly,
      turnId: this.turnCount,
    };

    for (const toolCall of toolCalls) {
      if (this.stopped) break;

      // Duplicate detection
      const currentSignature = getToolCallSignature(toolCall);

      if (this.lastToolCallSignature === currentSignature) {
        this.duplicateToolCallCount++;

        // Return error result for duplicate
        results.push({
          tool_call_id: toolCall.id,
          content: `Loop detected: Duplicate tool call #${this.duplicateToolCallCount}. Please try a different approach.`,
          success: false,
        });

        this.progress.onEvent('tool_status', {
          toolIndex: results.length - 1,
          status: 'failed',
          error: `Loop detected - duplicate tool call #${this.duplicateToolCallCount}`,
        });

        // Terminate if too many consecutive duplicates
        if (this.duplicateToolCallCount >= this.config.maxDuplicateToolCalls) {
          this.progress.onEvent('exit_reason', { reason: 'loop_detected', duplicates: this.duplicateToolCallCount });
          return { results, terminated: true };
        }

        continue;
      }

      // Reset duplicate counter on non-duplicate
      this.duplicateToolCallCount = 0;
      this.lastToolCallSignature = currentSignature;

      // Pattern detection (sliding window)
      this.recentToolSignatures.push(currentSignature);
      if (this.recentToolSignatures.length > PATTERN_WINDOW_SIZE) {
        this.recentToolSignatures.shift();
      }
      if (this.recentToolSignatures.length === PATTERN_WINDOW_SIZE) {
        const repeating = detectRepeatingPattern(this.recentToolSignatures, PATTERN_REPEAT_THRESHOLD);
        if (repeating) {
          this.progress.onEvent('exit_reason', { reason: 'pattern_detected', cycleLength: repeating });
          return { results, terminated: true };
        }
      }

      // Execute the tool (tool-executor emits tool_status events)
      try {
        const result = await this.executor.execute(toolCall, execContext);
        results.push(this.dedupRepeatedResult(result, results));
        this.toolCallCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          tool_call_id: toolCall.id,
          content: `Error: ${errorMessage}`,
          success: false,
        });
        this.progress.onEvent('tool_status', {
          toolIndex: results.length - 1,
          toolName: toolCall.function?.name,
          status: 'failed',
          error: errorMessage,
        });
      }
    }

    return { results, terminated: false };
  }

  /**
   * Replace a large tool output with a marker when an identical result is
   * already in the live context (e.g. re-reading an unchanged file). Only
   * matches verbatim copies still present post-compaction — if the earlier
   * copy was compacted away or truncated, the fresh output is kept.
   */
  private dedupRepeatedResult(result: ToolResult, currentBatch: ToolResult[]): ToolResult {
    if (!result.success || result.content.length < RESULT_DEDUP_MIN_CHARS) return result;

    const seenInContext = this.context.getMessages().some(
      m => m.role === 'tool' && typeof m.content === 'string' && m.content === result.content
    );
    const seenInBatch = currentBatch.some(r => r.content === result.content);
    if (!seenInContext && !seenInBatch) return result;

    return { ...result, content: RESULT_DEDUP_MARKER };
  }

  /**
   * Run the completion gate if configured.
   * Returns the error string if gate rejects, null if gate accepts (or not configured).
   */
  private async runCompletionGate(): Promise<string | null> {
    if (!this.config.completionGate) return null;
    return await this.config.completionGate();
  }

  private buildSummary(exitReason: string): string {
    switch (exitReason) {
      case 'status_complete':
      case 'status_complete_post_tool':
        return 'Completed successfully (status --complete)';
      case 'status_remaining_empty':
        return 'Completed (no remaining work)';
      case 'agent_type_exit':
        return `Completed (${this.config.agentType} agent finished)`;
      case 'setup_complete':
        return 'Setup complete';
      case 'awaiting_user':
        return 'Paused awaiting user input';
      case 'stopped':
        return 'Stopped by user';
      case 'error_stop':
        return 'Stopped due to error';
      case 'nudge_exhaustion':
        return `Exited after ${this.config.maxNudges} nudge attempts without status`;
      case 'loop_detected':
        return 'Terminated due to tool call loop detection';
      case 'max_iterations':
        return `Reached maximum iterations (${this.config.maxIterations})`;
      default:
        return `Exited: ${exitReason}`;
    }
  }
}

// Export helpers for testing
export { detectMalformedToolCalls, extractToolCallsFromText, getToolCallSignature, detectRepeatingPattern };
