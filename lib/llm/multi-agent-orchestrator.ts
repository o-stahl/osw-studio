/**
 * Multi-Agent Orchestrator - Manages agent execution and tool orchestration
 * Handles conversation state, checkpointing, and event streaming
 */

import { Agent, AgentType, agentRegistry } from './agent';
import { toolRegistry, ToolExecutionContext } from './tool-registry';
import { vfs } from '@/lib/vfs';
import { checkpointManager, Checkpoint } from '@/lib/vfs/checkpoint';
import { saveManager } from '@/lib/vfs/save-manager';
import { configManager } from '@/lib/config/storage';
import { getProvider, getModelContextLength } from '@/lib/llm/providers/registry';
import { CostCalculator } from './cost-calculator';
import { ToolCall, UsageInfo, ContentBlock } from './types';
import { logger } from '@/lib/utils';
import { toast } from 'sonner';
import { registerOpenRouterPricingFromApi, registerPricingFromProviderModels } from './pricing-cache';
import { fetchAvailableModels } from './models-api';
import { parseStreamingResponse, buildFileTree, ReasoningDetail } from './streaming-parser';
import { drainRuntimeErrors, formatRuntimeErrors, resetRuntimeErrors } from '@/lib/preview/runtime-errors';
import { buildShellSystemPrompt, buildProjectContext, COMPACTION_PROMPT } from './system-prompt';
import { evaluateRelevantSkills } from './skill-evaluator';
import { skillsService } from '@/lib/vfs/skills';
import { track } from '@/lib/telemetry';
import { extractToolAnalytics } from '@/lib/telemetry/tool-analytics';
import { apiFetch } from '@/lib/api/backend-status';
import type { ServerOrchestratorContext } from '@/lib/server-generate/types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Harmony format token patterns (GPT-OSS and other harmony-format models) */
const HARMONY_TOKEN_RE = /<\|[^|]*\|>/;
const HARMONY_TOKEN_STRIP_RE = /<\|[^|]*\|>[a-z]*/gi;

/**
 * Detect if content contains malformed tool calls written as text/markdown
 * instead of proper function calling invocations.
 *
 * This specifically looks for patterns where the model writes out tool call
 * syntax as text rather than using the function calling API.
 */
function detectMalformedToolCalls(content: string): boolean {
  if (!content) return false;

  // Only detect when the ENTIRE response or a significant portion appears to be
  // an attempt to "write" a tool call as text. Look for patterns at line start
  // or as standalone statements.
  const patterns = [
    // Markdown code block with shell/bash
    /```(?:shell|bash|sh)\s*\n[\s\S]*?\n```/,
    // Line starting with shell{"cmd" (no leading text explanation)
    /^shell\s*\{\s*["']?cmd["']?\s*:/m,
    // Line starting with shell[ for array format
    /^shell\s*\[\s*["']/m,
    // JSON code block with cmd
    /```json\s*\n\s*\{\s*["']?cmd["']?\s*:/,
  ];

  // Check if ANY pattern matches
  const hasPattern = patterns.some(p => p.test(content));
  if (!hasPattern) return false;

  // Additional heuristic: if the content is SHORT and mostly just the tool call
  // pattern, it's likely a malformed tool call. If there's substantial text
  // around it (explanation), it might be intentional documentation.
  const trimmed = content.trim();

  // If the entire content is just a short tool-call-like pattern, flag it
  if (trimmed.length < 200) {
    return true;
  }

  // For longer content, only flag if the pattern appears at the very end
  // (model explaining then "calling" the tool as text)
  const endsWithToolPattern = /shell\s*\{\s*["']?cmd["']?\s*:.*\}\s*$/.test(trimmed) ||
                               /```(?:shell|bash|sh)\s*\n[\s\S]*?\n```\s*$/.test(trimmed);

  return endsWithToolPattern;
}

const MALFORMED_TOOL_CALL_ERROR = `⛔ CRITICAL ERROR: You wrote a tool call as TEXT instead of invoking it.

This is WRONG - you wrote text like:
  shell{"cmd": "..."}
  \`\`\`shell
  command
  \`\`\`

This is RIGHT - invoke tools directly via function calling:
  Call shell tool with parameter cmd="your command"

You MUST use function calling. DO NOT write tool syntax as text.
STOP writing text. START invoking tools. Try again NOW.`;

const MALFORMED_TOOL_CALL_PERSISTENT_REMINDER = `

⚠️ REMINDER: You have been writing tool calls as text instead of invoking them.
EVERY time you want to use a tool, you MUST invoke it via function calling.
DO NOT write shell{"cmd":...} as text - INVOKE the tools directly.`;

/**
 * Extract shell commands from text when the model doesn't support native tool calling.
 * Patterns: ```bash blocks, Gemini tool_code blocks, shell{} JSON syntax.
 */
function extractToolCallsFromText(content: string): import('./types').ToolCall[] | undefined {
  if (!content) return undefined;

  const commands: string[] = [];
  let match;

  // Pattern 1: ```bash/shell/sh code blocks
  const bashBlockRe = /```(?:bash|shell|sh)\s*\n([\s\S]*?)\n```/g;
  while ((match = bashBlockRe.exec(content)) !== null) {
    const block = match[1].trim();
    if (block) commands.push(block);
  }

  // Pattern 2: ```tool_code blocks (Gemini-style) — extract the command string
  // e.g. ```tool_code\nprint(shell.run_command("status --task ..."))\n```
  const toolCodeRe = /```tool_code\s*\n([\s\S]*?)\n```/g;
  while ((match = toolCodeRe.exec(content)) !== null) {
    const block = match[1].trim();
    // Extract command from shell.run_command("...") or print(shell.run_command("..."))
    const runCmdMatch = block.match(/shell\.run_command\(["']([\s\S]*?)["']\)/);
    if (runCmdMatch) {
      // Unescape \" sequences
      commands.push(runCmdMatch[1].replace(/\\"/g, '"'));
    }
  }

  // Pattern 3: shell{"cmd": "..."} or shell({"cmd": "..."})
  const shellJsonRe = /shell\s*\(?\s*\{\s*["']?cmd["']?\s*:\s*["']([\s\S]*?)["']\s*\}\s*\)?/g;
  while ((match = shellJsonRe.exec(content)) !== null) {
    if (match[1].trim()) commands.push(match[1].trim());
  }

  if (commands.length === 0) return undefined;

  return commands.map((cmd, i) => ({
    id: `text-tool-${Date.now()}-${i}`,
    type: 'function' as const,
    function: {
      name: 'shell',
      arguments: JSON.stringify({ cmd }),
    },
  }));
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];  // String or array of content blocks (for multimodal)
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: ReasoningDetail[];  // Reasoning blob preserved on assistant messages — required for multi-turn replay (Gemini, DeepSeek V4 Pro, etc.)
  // UI metadata for session recovery and display hints
  ui_metadata?: {
    checkpointId?: string;
    cost?: number;
    usage?: UsageInfo;
    isSyntheticError?: boolean;  // True if this is an auto-injected error message (e.g., malformed tool call correction)
    projectContext?: string;  // Project context injected into first user message (for collapsible UI display)
    displayContent?: string | ContentBlock[];  // Clean user prompt for UI (without injected context/hints)
    isCompactSummary?: boolean;  // True if this message is a compaction summary
    focusContext?: { domPath: string; snippet: string };  // Focus context from crosshair tool
    semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;  // Placed semantic blocks
  };
}

// Pending image for the chat UI
export interface PendingImage {
  id: string;
  data: string;      // base64 data (without prefix)
  mediaType: string; // 'image/png', 'image/jpeg', etc.
  preview: string;   // full data URL for display
}

export interface ConversationNode {
  id: string;
  agent_type: AgentType;
  messages: AgentMessage[];
  metadata: {
    started_at: number;
    completed_at?: number;
    cost: number;
    status: 'running' | 'completed' | 'failed';
  };
}

export interface MultiAgentResult {
  success: boolean;
  summary: string;
  conversation: ConversationNode[];
  totalCost: number;
  totalUsage: UsageInfo;
  checkpointId?: string;
  /** Telemetry: number of tool calls executed */
  toolCount?: number;
  /** Telemetry: number of LLM turns (iterations) completed */
  turnCount?: number;
  /** Telemetry: number of API errors encountered (including retried ones) */
  apiErrorCount?: number;
}

/**
 * Multi-Agent Orchestrator
 * Coordinates multiple agents with isolated conversation contexts
 */
export class MultiAgentOrchestrator {
  private projectId: string;
  private rootAgent: Agent;
  private conversations: Map<string, ConversationNode> = new Map();
  private currentConversationId: string;
  private onProgress?: (message: string, step?: unknown) => void;
  private totalCost = 0;
  private totalUsage: UsageInfo = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0
  };
  private stopped = false;
  private abortController = new AbortController();
  private pricingEnsured = new Set<string>();
  private chatMode: boolean;
  private model?: string;
  private lastToolCallSignature: string | null = null; // Loop detection
  private duplicateToolCallCount: number = 0; // Track consecutive duplicates
  private recentToolSignatures: string[] = []; // Window for pattern loop detection
  private readonly patternWindowSize = 8; // How many recent calls to track (max cycle 4 * threshold 2)
  private readonly patternRepeatThreshold = 2; // How many repeats of a pattern to trigger termination
  private nudgeCount = 0; // Track how many times we've nudged for status
  private readonly maxNudges = 3; // Max nudge attempts before giving up
  private lastIterationHadToolError = false; // Track if previous iteration had a failed tool call
  private lastStatusResult: { task: string; done: string; remaining: string; complete: boolean; hasExplicitFlag: boolean } | null = null; // Track status result
  private setupComplete = false; // Setup agent: propose-create was called
  private awaitingUserSelection = false; // ask command: pause loop until next user message
  private activeSubOrchestrators = new Set<MultiAgentOrchestrator>(); // Track running sub-agents for stop propagation
  private malformedToolCallRetries = 0; // Track consecutive retries for malformed tool call detection
  private totalMalformedToolCalls = 0; // Track total malformed calls in session (doesn't reset)
  private readonly maxMalformedRetries = 2; // Max consecutive retries before allowing through
  private readonly malformedThresholdForReminder = 3; // After this many total failures, add persistent reminder
  private compactionCount = 0;
  private pauseResolve: (() => void) | null = null;
  private toolCallCount = 0; // Telemetry: total tool calls executed
  private turnCount = 0; // Telemetry: total LLM turns completed
  private apiErrorCount = 0; // Telemetry: total API errors encountered
  private serverContext: ServerOrchestratorContext | null = null;

  /** Check if the current model supports native tool/function calling */
  private checkModelSupportsTools(): boolean {
    const { provider, model } = this.getProviderConfig();
    const cached = this.getConfig().getCachedModels(provider);
    if (cached?.models?.length) {
      const entry = (cached.models as import('@/lib/llm/providers/types').ProviderModel[])
        .find(m => m.id === model);
      if (entry && entry.supportsFunctions === false) return false;
    }
    return true;
  }

  private static readonly RECENT_KEEP_RATIO = 0.20; // Keep 20% of recent messages verbatim
  private static readonly SUMMARY_TOKEN_RATIO = 0.10; // Cap summary at 10% of limit
  private static readonly DEFAULT_COMPACTION_LIMIT = 128000;
  constructor(
    projectId: string,
    agentType: AgentType = 'orchestrator',
    onProgress?: (message: string, step?: unknown) => void,
    options?: { chatMode?: boolean; model?: string; serverContext?: ServerOrchestratorContext }
  ) {
    this.projectId = projectId;
    this.onProgress = onProgress;
    this.chatMode = options?.chatMode ?? false;
    this.model = options?.model;
    this.serverContext = options?.serverContext ?? null;

    // Get root agent (default to orchestrator)
    const agent = agentRegistry.get(agentType);
    if (!agent) {
      throw new Error(`Agent type "${agentType}" not found`);
    }
    this.rootAgent = agent;

    // Create root conversation
    this.currentConversationId = this.createConversation(agentType);
  }

  /** Get config — server context shim or browser configManager */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getConfig(): any {
    if (this.serverContext) {
      return this.serverContext.config;
    }
    return configManager;
  }

  /** Get VFS — server context VFS or browser singleton */
  private getVFS() {
    return this.serverContext?.vfs ?? vfs;
  }

  /** Emit a toast notification or route through server context */
  private notify(level: 'info' | 'error', message: string, options?: { duration?: number }) {
    if (this.serverContext) {
      this.serverContext.onEvent('notification', { level, message });
    } else {
      toast[level](message, options);
    }
  }

  /** Reset runtime errors (no-op in server context) */
  private resetErrors() {
    if (!this.serverContext) {
      resetRuntimeErrors();
    }
  }

  /** Drain runtime errors (returns [] in server context) */
  private drainErrors() {
    if (this.serverContext) return [];
    return drainRuntimeErrors();
  }

  /** Get API generate URL */
  private getApiUrl(): string {
    if (this.serverContext) {
      return this.serverContext.apiBaseUrl + '/api/generate';
    }
    return typeof window !== 'undefined'
      ? `${window.location.origin}/api/generate`
      : '/api/generate';
  }

  /**
   * Resume execution after an error pause.
   * Called when the user clicks "Continue" after fixing the issue.
   */
  continue(): void {
    if (this.pauseResolve) {
      // Create a fresh AbortController since the old one may have been aborted
      this.abortController = new AbortController();
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /**
   * Stop execution
   */
  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    // Also resolve any pending pause so the loop can exit
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    // Propagate stop to all running sub-orchestrators
    for (const sub of this.activeSubOrchestrators) {
      sub.stop();
    }
    logger.info('[MultiAgentOrchestrator] Execution stopped by user');
  }

  /**
   * Import previous conversation messages to restore context
   */
  importConversation(messages: AgentMessage[]): void {
    const rootConversation = this.conversations.get(this.currentConversationId);
    if (!rootConversation) {
      throw new Error('Cannot import conversation: root conversation not found');
    }

    // Replace messages array with imported history
    rootConversation.messages = messages;
    logger.info(`[MultiAgentOrchestrator] Imported ${messages.length} conversation messages`);
  }

  /**
   * Add message to conversation and emit event for persistence
   */
  private addMessage(conversationId: string, message: AgentMessage): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    conversation.messages.push(message);

    // Emit event for persistence (only for root conversation)
    if (conversationId === this.currentConversationId) {
      this.onProgress?.('conversation_message', { message });
    }
  }

  /**
   * Execute user prompt with optional images
   */
  async execute(
    userPrompt: string,
    options?: {
      images?: Array<{ data: string; mediaType: string }>;
      focusContext?: { domPath: string; snippet: string };
      semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
      displayPrompt?: string;  // Clean user prompt for UI display (without prepended context)
    }
  ): Promise<MultiAgentResult> {
    logger.info('[MultiAgentOrchestrator] Starting execution', { agent: this.rootAgent.type });

    // Reset state for new execution
    this.stopped = false;
    this.abortController = new AbortController();
    this.lastToolCallSignature = null;
    this.duplicateToolCallCount = 0;
    this.recentToolSignatures = [];
    this.nudgeCount = 0;
    this.malformedToolCallRetries = 0;
    this.lastStatusResult = null;
    this.lastIterationHadToolError = false;
    this.setupComplete = false;
    this.awaitingUserSelection = false;

    // Strip trailing nudge messages from a previous nudge_exhaustion exit.
    // Without this, the conversation ends with consecutive user messages that
    // cause the model to return empty responses on the next execution.
    const conversation = this.conversations.get(this.currentConversationId);
    if (conversation) {
      while (conversation.messages.length > 0) {
        const last = conversation.messages[conversation.messages.length - 1];
        if (last.role === 'user' && typeof last.content === 'string' && last.content.includes('Before finishing, run the status command')) {
          conversation.messages.pop();
        } else {
          break;
        }
      }
    }

    try {
      // Get file tree for context
      let fileTreeStr: string | undefined;
      try {
        const files = await this.getVFS().listDirectory(this.projectId, '/');
        if (files.length > 0) {
          fileTreeStr = buildFileTree(files);
        }
      } catch {
        // Ignore errors getting file tree
      }

      // Get server context metadata from VFS (already computed when context was mounted)
      const serverContext = this.getVFS().getServerContextMetadata();

      // Build system prompt (behavioral instructions only — skills/tree go in user message)
      const modelSupportsTools = this.checkModelSupportsTools();
      const systemPrompt = await buildShellSystemPrompt(this.chatMode, serverContext, this.projectId, this.rootAgent.type, modelSupportsTools);

      // Get current conversation
      const conversation = this.conversations.get(this.currentConversationId);
      const hasExistingSystemMessage = conversation?.messages.some(m => m.role === 'system');

      // Only add system prompt if this is a fresh conversation (no existing system message)
      // For follow-up messages, the system prompt is already in the conversation history
      if (!hasExistingSystemMessage) {
        this.addMessage(this.currentConversationId, {
          role: 'system',
          content: systemPrompt
        });
      }

      // Build project context (skills list + file tree) for the first user message.
      // Placed in user message so the model treats it as project state, not instructions.
      let projectContext = '';
      if (!hasExistingSystemMessage) {
        projectContext = await buildProjectContext(fileTreeStr, serverContext);
      }

      // Skill evaluation pass - check if any enabled skills are relevant (orchestrator only)
      let skillHint = '';
      try {
        const evalEnabled = await skillsService.isEvaluationEnabled();
        if (evalEnabled && this.rootAgent.type === 'orchestrator') {
          const skillsMeta = await skillsService.getEnabledSkillsMetadata();
          if (skillsMeta.length > 0) {
            const { provider, apiKey, model } = this.getProviderConfig();
            const evalResult = await evaluateRelevantSkills(
              userPrompt, skillsMeta, fileTreeStr || '', provider, apiKey, model
            );

            // Track eval usage
            if (evalResult.usage) {
              const evalUsage = evalResult.usage;
              const cost = CostCalculator.calculateCost(
                evalUsage, evalUsage.provider, evalUsage.model, true
              );
              this.totalCost += cost;
              this.totalUsage.promptTokens += evalUsage.promptTokens;
              this.totalUsage.completionTokens += evalUsage.completionTokens;
              this.totalUsage.totalTokens += evalUsage.totalTokens;
              this.getConfig().updateSessionCost({ ...evalUsage, cost }, cost);
            }

            // Emit debug event
            this.onProgress?.('skill_evaluation', {
              skills: skillsMeta.map(s => s.id),
              matched: evalResult.skillIds,
              usage: evalResult.usage,
            });

            if (evalResult.skillIds.length > 0) {
              const paths = evalResult.skillIds.map(s => `/.skills/${s}.md`).join(', ');
              skillHint = `Skill evaluation: read ${paths} before proceeding.\n\n`;
            }
          }
        }
      } catch {
        // Silent fallback - don't block normal execution
      }

      // Build user message content - string or ContentBlock[] with images
      // First message gets project context prepended; follow-ups get skill hint only
      const messagePrefix = (projectContext ? projectContext + '\n\n' : '') + skillHint;
      let userContent: string | ContentBlock[];
      let displayContent: string | ContentBlock[];

      // Use clean display prompt (without prepended context) when available
      const cleanPrompt = options?.displayPrompt ?? userPrompt;

      if (options?.images && options.images.length > 0) {
        // Build multimodal content with text and images
        const imageBlocks: ContentBlock[] = [];
        for (const img of options.images) {
          imageBlocks.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mediaType};base64,${img.data}`
            }
          });
        }
        userContent = [{ type: 'text' as const, text: messagePrefix + userPrompt }, ...imageBlocks];
        displayContent = [{ type: 'text' as const, text: cleanPrompt }, ...imageBlocks];
      } else {
        userContent = messagePrefix + userPrompt;
        displayContent = cleanPrompt;
      }

      // Add user prompt — full content for LLM, display content + context metadata for UI
      this.addMessage(this.currentConversationId, {
        role: 'user',
        content: userContent,
        ui_metadata: {
          displayContent,
          ...(projectContext ? { projectContext } : {}),
          ...(options?.focusContext ? { focusContext: options.focusContext } : {}),
          ...(options?.semanticBlocks?.length ? { semanticBlocks: options.semanticBlocks } : {}),
        }
      });

      // Run agent loop
      await this.runAgentLoop(this.currentConversationId, this.rootAgent);

      // Create final checkpoint (skip for setup agent — pre-project, no VFS)
      if (this.rootAgent.type !== 'setup') {
        await this.recordAutoCheckpoint(`After: ${userPrompt.substring(0, 60)}`);
      }

      return {
        success: true,
        summary: 'Task completed',
        conversation: Array.from(this.conversations.values()),
        totalCost: this.totalCost,
        totalUsage: this.totalUsage,
        toolCount: this.toolCallCount,
        turnCount: this.turnCount,
        apiErrorCount: this.apiErrorCount,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[MultiAgentOrchestrator] Execution error:', errorMessage);

      // Emit error event for debug panel
      this.onProgress?.('error', {
        message: errorMessage,
        type: 'execution_error',
        stack: error instanceof Error ? error.stack : undefined
      });

      if (this.rootAgent.type !== 'setup') {
        await this.recordAutoCheckpoint(`After failure: ${userPrompt.substring(0, 60)}`);
      }

      return {
        success: false,
        summary: `Error: ${errorMessage}`,
        conversation: Array.from(this.conversations.values()),
        totalCost: this.totalCost,
        totalUsage: this.totalUsage,
        toolCount: this.toolCallCount,
        turnCount: this.turnCount,
        apiErrorCount: this.apiErrorCount,
      };
    }
  }

  /**
   * Run agent execution loop
   */
  private async runAgentLoop(conversationId: string, agent: Agent): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const maxIterations = agent.maxIterations;
    let lastIteration = 0;

    // Clear runtime error state so previous generation errors don't leak in
    this.resetErrors();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      lastIteration = iteration;
      if (this.stopped) {
        logger.info('[MultiAgentOrchestrator] Loop stopped by user');
        this.onProgress?.('stopped', { reason: 'user' });
        break;
      }

      // Notify progress
      this.onProgress?.('iteration', {
        current: iteration + 1,
        max: maxIterations,
        agent: agent.type
      });

      // Emit 'waiting' before LLM call (reasoning tokens arrive via streaming-parser)
      this.onProgress?.('waiting', {});

      let response;
      try {
        response = await this.streamLLMResponse(
          conversation.messages,
          agent
        );
      } catch (err) {
        if (this.stopped) {
          this.onProgress?.('stopped', { reason: 'user' });
          break;
        }
        throw err;
      }

      // Filter harmony format artifacts from tool calls
      // GPT-OSS models emit internal channel tokens (<|channel|>, <|start|>, etc.)
      // that appear as spurious tool calls (e.g., shell<|channel|>commentary).
      // Real tool calls never contain these tokens — any tool call with <|...|> in
      // the name is a harmony artifact, regardless of args content.
      if (response.toolCalls && response.toolCalls.length > 0) {
        const preFilterCount = response.toolCalls.length;
        response.toolCalls = response.toolCalls.filter(tc => {
          const rawName = tc.function?.name || '';
          return !HARMONY_TOKEN_RE.test(rawName);
        });
        if (response.toolCalls.length < preFilterCount) {
          logger.info(`[MultiAgentOrchestrator] Filtered ${preFilterCount - response.toolCalls.length} harmony artifact(s)`);
        }
        if (response.toolCalls.length === 0) {
          response.toolCalls = undefined;
        }
      }

      // For models without native tool support: extract tool calls from text
      if (!response.toolsSent && response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
        const extracted = extractToolCallsFromText(response.content);
        if (extracted && extracted.length > 0) {
          logger.info(`[MultiAgentOrchestrator] Extracted ${extracted.length} tool call(s) from text (model has no native tool support)`);
          response.toolCalls = extracted;
        }
      }

      // Check for malformed tool calls (model wrote tool syntax as text instead of invoking)
      // Only applies when tools WERE sent — if tools weren't sent, text extraction above handles it
      if (response.toolsSent && response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
        if (detectMalformedToolCalls(response.content)) {
          this.malformedToolCallRetries++;
          this.totalMalformedToolCalls++;
          logger.warn(`[MultiAgentOrchestrator] Detected malformed tool call in text (consecutive: ${this.malformedToolCallRetries}/${this.maxMalformedRetries}, total: ${this.totalMalformedToolCalls})`);

          // Only retry if under the consecutive limit
          if (this.malformedToolCallRetries <= this.maxMalformedRetries) {
            // Add the malformed response to conversation
            this.addMessage(conversationId, {
              role: 'assistant',
              content: response.content
            });

            // Build error message - add persistent reminder if many total failures
            let errorMessage = MALFORMED_TOOL_CALL_ERROR;
            if (this.totalMalformedToolCalls >= this.malformedThresholdForReminder) {
              errorMessage += MALFORMED_TOOL_CALL_PERSISTENT_REMINDER;
            }

            // Add synthetic error to help model self-correct
            this.addMessage(conversationId, {
              role: 'user',
              content: errorMessage,
              ui_metadata: {
                isSyntheticError: true
              }
            });

            // Emit progress event so UI knows what happened
            this.onProgress?.('malformed_tool_call', {
              retry: this.malformedToolCallRetries,
              maxRetries: this.maxMalformedRetries,
              totalFailures: this.totalMalformedToolCalls
            });

            continue; // Retry the loop
          }
          // If over consecutive limit, fall through and let it proceed (model may still produce useful text)
        }
      } else if (response.toolCalls && response.toolCalls.length > 0) {
        // Reset CONSECUTIVE counter on successful tool calls (but not total)
        this.malformedToolCallRetries = 0;
      }

      // No tool calls - LLM wants to finish
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const hasContent = response.content && response.content.trim();

        // Explore/plan/setup agents finish when they stop calling tools — no status needed
        if (agent.type === 'explore' || agent.type === 'plan' || agent.type === 'setup') {
          if (hasContent) {
            this.addMessage(conversationId, {
              role: 'assistant',
              content: response.content!
            });
          }
          break;
        }

        // Log when we get reasoning-only responses (no content, no tool calls)
        if (!hasContent) {
          logger.warn('[MultiAgentOrchestrator] Response has no content and no tool calls (reasoning-only response)', {
            hasReasoningDetails: !!response.reasoningDetails,
            nudgeCount: this.nudgeCount,
            iteration
          });
        }

        if (hasContent) {
          this.addMessage(conversationId, {
            role: 'assistant',
            content: response.content!
          });
        }

        // Check structured status result
        if (this.lastStatusResult) {
          if (this.lastStatusResult.complete) {
            // Gate: check for runtime errors before allowing completion
            await new Promise(resolve => setTimeout(resolve, 400));
            const runtimeErrors = this.drainErrors();
            if (runtimeErrors.length > 0) {
              logger.info(`[MultiAgentOrchestrator] Completion blocked: ${runtimeErrors.length} runtime error(s)`);
              this.addMessage(conversationId, {
                role: 'user',
                content: formatRuntimeErrors(runtimeErrors),
                ui_metadata: { isSyntheticError: true }
              });
              this.lastStatusResult = null;
              continue;
            }
            logger.info('[MultiAgentOrchestrator] Exit: status --complete flag');
            this.onProgress?.('exit_reason', { reason: 'status_complete', iteration });
            break;
          } else if (this.lastStatusResult.hasExplicitFlag) {
            logger.info('[MultiAgentOrchestrator] Status --incomplete flag, continuing');
            this.lastStatusResult = null;
            this.nudgeCount = 0;
            continue;
          } else {
            // No flag — fall back to remaining field
            const rem = this.lastStatusResult.remaining.trim().toLowerCase();
            if (!rem || rem === 'none' || rem === 'n/a' || rem === 'nothing') {
              // Gate: check for runtime errors before allowing completion
              await new Promise(resolve => setTimeout(resolve, 400));
              const runtimeErrors = this.drainErrors();
              if (runtimeErrors.length > 0) {
                logger.info(`[MultiAgentOrchestrator] Completion blocked: ${runtimeErrors.length} runtime error(s)`);
                this.addMessage(conversationId, {
                  role: 'user',
                  content: formatRuntimeErrors(runtimeErrors),
                  ui_metadata: { isSyntheticError: true }
                });
                this.lastStatusResult = null;
                continue;
              }
              logger.info('[MultiAgentOrchestrator] Exit: status remaining empty/none (fallback)');
              this.onProgress?.('exit_reason', { reason: 'status_remaining_empty', iteration });
              break;
            } else {
              logger.info('[MultiAgentOrchestrator] Status remaining has content, continuing');
              this.lastStatusResult = null;
              this.nudgeCount = 0;
              continue;
            }
          }
        }

        // After a tool error + reasoning-only response, the model is likely confused.
        // Prompt it to retry instead of asking for status.
        if (this.lastIterationHadToolError && !hasContent) {
          this.lastIterationHadToolError = false; // Only inject once
          logger.info('[MultiAgentOrchestrator] Reasoning-only response after tool error, prompting retry');
          this.onProgress?.('tool_error_retry', { iteration });
          this.addMessage(conversationId, {
            role: 'user',
            content: 'Your previous command failed (likely a streaming issue). Continue your work — retry writing the file. If the file is large, split it into multiple smaller cat commands.',
            ui_metadata: { isSyntheticError: true }
          });
          continue;
        }

        // No status yet - nudge (up to maxNudges times)
        if (this.nudgeCount < this.maxNudges) {
          this.nudgeCount++;
          logger.info(`[MultiAgentOrchestrator] Nudge ${this.nudgeCount}/${this.maxNudges}`);
          this.onProgress?.('nudge', { attempt: this.nudgeCount, max: this.maxNudges });
          const nudgeMessage = 'Before finishing, run the status command:\n  status --task "..." --done "..." --remaining "..." --complete';
          this.addMessage(conversationId, {
            role: 'user',
            content: nudgeMessage
          });
          continue;
        }

        // Exhausted all nudge attempts - finish without status
        logger.warn(`[MultiAgentOrchestrator] Exit: nudge exhaustion (${this.maxNudges} nudges)`);
        this.onProgress?.('exit_reason', { reason: 'nudge_exhaustion', nudges: this.maxNudges, iteration });
        break;
      }

      // Execute tool calls
      const toolResults = await this.executeToolCalls(
        response.toolCalls,
        agent
      );

      // Add assistant message with tool calls and reasoning_details.
      // The field is always set (defaulting to []) because some providers
      // (notably DeepSeek V4 Pro via OpenRouter) validate that prior assistant
      // turns carry the field on multi-turn replay, even when no reasoning
      // content was produced. Empty arrays are accepted by every provider that
      // sees this field; providers that transform messages (Anthropic, Gemini)
      // ignore it during their own message-format conversions.
      this.addMessage(conversationId, {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls,
        reasoning_details: response.reasoningDetails ?? []
      });

      // Add tool results and track errors
      this.lastIterationHadToolError = false;
      for (const result of toolResults) {
        this.addMessage(conversationId, result);
        if (typeof result.content === 'string' && result.content.startsWith('Error:')) {
          this.lastIterationHadToolError = true;
        }
      }

      // Check compaction threshold (parent orchestrator only).
      // Uses cumulative prompt tokens (reliable across all providers) rather than
      // per-response usage (depends on stream_options support).
      if (this.rootAgent.type === 'orchestrator' && this.totalUsage.promptTokens > 0) {
        const { provider } = this.getProviderConfig();
        if (this.getConfig().isCompactionEnabled(provider)) {
          const compactionLimit = this.resolveCompactionLimit();
          if (this.totalUsage.promptTokens >= compactionLimit) {
            logger.info(`[Compaction] Triggering compaction (promptTokens=${this.totalUsage.promptTokens}, limit=${compactionLimit})`);
            await this.compactConversation(conversationId);
          }
        }
      }

      // Check status result immediately after tool execution
      if (this.lastStatusResult) {
        const isDone = this.lastStatusResult.complete || (
          !this.lastStatusResult.hasExplicitFlag &&
          (!this.lastStatusResult.remaining.trim() ||
            ['none', 'n/a', 'nothing'].includes(this.lastStatusResult.remaining.trim().toLowerCase()))
        );
        if (isDone) {
          // Gate: check for runtime errors before allowing completion.
          // Wait for the latest compilation to settle, then drain.
          await new Promise(resolve => setTimeout(resolve, 400));
          const runtimeErrors = this.drainErrors();
          if (runtimeErrors.length > 0) {
            logger.info(`[MultiAgentOrchestrator] Completion blocked: ${runtimeErrors.length} runtime error(s)`);
            this.addMessage(conversationId, {
              role: 'user',
              content: formatRuntimeErrors(runtimeErrors),
              ui_metadata: { isSyntheticError: true }
            });
            this.lastStatusResult = null;
            continue;
          }

          const reason = this.lastStatusResult.complete ? 'status_complete_post_tool' : 'status_remaining_empty_post_tool';
          logger.info(`[MultiAgentOrchestrator] Exit: ${reason}`);
          this.onProgress?.('exit_reason', { reason, iteration });
          break;
        }
      }

      // Setup agent: exit after propose-create (signals "ready, user confirms")
      if (this.setupComplete) {
        logger.info('[MultiAgentOrchestrator] Exit: setup propose-create called');
        this.onProgress?.('exit_reason', { reason: 'setup_complete', iteration });
        break;
      }

      // ask command: pause loop until next user message (their selection becomes
      // the next user input and resumes the loop on a fresh execute() call).
      if (this.awaitingUserSelection) {
        logger.info('[MultiAgentOrchestrator] Exit: ask command — awaiting user selection');
        this.onProgress?.('exit_reason', { reason: 'awaiting_user', iteration });
        break;
      }
    }

    // Check if loop exhausted max iterations
    if (lastIteration >= maxIterations - 1 && !this.stopped) {
      logger.warn(`[MultiAgentOrchestrator] Exit: max iterations reached (${maxIterations})`);
      this.onProgress?.('exit_reason', { reason: 'max_iterations', maxIterations, iteration: lastIteration });
    }

    // Mark conversation as completed
    conversation.metadata.completed_at = Date.now();
    conversation.metadata.status = 'completed';
  }

  /**
   * Parse a delegate command. Returns array of {type, prompt} — multiple quoted
   * prompts in a single command spawn parallel agents.
   *
   * Supported forms:
   *   delegate explore "Q1" "Q2" "Q3"     → 3 parallel explore agents
   *   delegate task "do X" "do Y"          → 2 parallel task agents
   *   delegate explore "single question"   → 1 agent (backward compat)
   *   delegate explore unquoted text       → 1 agent (backward compat)
   *   delegate type << 'EOF'\nprompt\nEOF  → 1 agent (heredoc)
   */
  private parseDelegateCommand(rawCmd: string): { type: string; prompt: string }[] | null {
    if (!rawCmd || !rawCmd.trimStart().startsWith('delegate ')) return null;
    const trimmed = rawCmd.trim();

    // Heredoc: delegate type << 'EOF'\nprompt\nEOF — always single agent
    const heredocRe = /^delegate\s+(explore|task|plan)\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\2\s*$/;
    const hm = trimmed.match(heredocRe);
    if (hm) return [{ type: hm[1], prompt: hm[3].trim() }];

    // Inline: delegate type followed by prompt(s)
    const inlineRe = /^delegate\s+(explore|task|plan)\s+([\s\S]+)$/;
    const im = trimmed.match(inlineRe);

    if (!im) return null;

    const type = im[1];
    const rest = im[2].trim();

    // Extract top-level quoted strings using a state machine.
    // Naive regex fails because HTML/code content contains inner quotes.
    const topLevelPrompts = this.extractTopLevelQuotedStrings(rest);

    if (topLevelPrompts.length >= 2) {
      return topLevelPrompts.map(prompt => ({ type, prompt }));
    }

    if (topLevelPrompts.length === 1) {
      return [{ type, prompt: topLevelPrompts[0] }];
    }

    // Unquoted text → single agent
    return [{ type, prompt: rest }];
  }

  /**
   * Extract top-level quoted strings from a delegate command's argument portion.
   * Uses a state machine to handle nested quotes in HTML/code content.
   * Only splits on quotes that start after whitespace (top-level boundary).
   */
  private extractTopLevelQuotedStrings(input: string): string[] {
    const prompts: string[] = [];
    let i = 0;

    while (i < input.length) {
      // Skip whitespace between prompts
      while (i < input.length && /\s/.test(input[i])) i++;
      if (i >= input.length) break;

      const quoteChar = input[i];
      if (quoteChar !== '"' && quoteChar !== "'") {
        // Not a quoted string — this is unquoted trailing text, consume rest
        prompts.push(input.slice(i).trim());
        break;
      }

      // Found opening quote — scan for the matching UNESCAPED closing quote
      // at the same level (the next quote char preceded by whitespace or at end).
      // Strategy: find the closing quote that is followed by either:
      //   - end of string
      //   - whitespace then another quote char (next prompt)
      //   - whitespace then end of string
      i++; // skip opening quote
      const start = i;

      while (i < input.length) {
        const ch = input[i];
        if (ch === '\\') { i += 2; continue; } // skip escaped chars

        // Track heredoc-style content (<<) — skip until delimiter
        if (ch === '<' && i + 1 < input.length && input[i + 1] === '<') {
          // Inside heredoc — skip to matching EOF/delimiter
          const heredocMatch = input.slice(i).match(/^<<-?\s*['"]?(\w+)['"]?\s*\n/);
          if (heredocMatch) {
            const delimiter = heredocMatch[1];
            const endIdx = input.indexOf('\n' + delimiter, i + heredocMatch[0].length);
            if (endIdx !== -1) {
              i = endIdx + delimiter.length + 1;
              continue;
            }
          }
        }

        if (ch === quoteChar) {
          // Check if this is the closing top-level quote:
          // It should be followed by whitespace+quote, whitespace+end, or end
          const after = input.slice(i + 1).trimStart();
          if (after.length === 0 || after[0] === '"' || after[0] === "'") {
            // This is the closing quote
            prompts.push(input.slice(start, i).trim());
            i++; // skip closing quote
            break;
          }
          // Otherwise it's an inner quote — keep scanning
        }

        i++;
      }

      // If we ran off the end without finding a closing quote, take what we have
      if (i >= input.length) {
        const content = input.slice(start).trim();
        if (content) prompts.push(content);
      }
    }

    return prompts;
  }

  /**
   * Run one delegate sub-agent. Returns { type, prompt, body }.
   */
  private async runSingleDelegate(type: string, prompt: string, agentIndex: number = 1, parentToolIndex?: number): Promise<{
    type: string; prompt: string; body: string;
  }> {
    // Early exit if parent was already stopped
    if (this.stopped) {
      return { type, prompt, body: '(Cancelled — parent stopped)' };
    }

    let delegateToolIndex = 0;
    const startTime = Date.now();
    const promptLabel = prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt;

    // Emit start event
    this.onProgress?.('delegate_progress', {
      type, event: 'agent_start', data: {}, agentIndex, parentToolIndex,
      delegatePrompt: promptLabel,
    });

    // Forward only events the parent consumes (skip high-volume streaming deltas)
    const FORWARDED_INNER_EVENTS = new Set([
      'tool_status', 'tool_result', 'error', 'stopped', 'nudge',
      'malformed_tool_call', 'tool_healed', 'exit_reason',
    ]);

    const subOrchestrator = new MultiAgentOrchestrator(
      this.projectId,
      type as AgentType,
      (event, data) => {
        if (!FORWARDED_INNER_EVENTS.has(event)) return;
        this.onProgress?.('delegate_progress', {
          type, event, data, agentIndex, parentToolIndex,
          delegatePrompt: promptLabel,
          delegateToolIndex: event === 'tool_status' || event === 'tool_result' ? delegateToolIndex++ : undefined
        });
      },
      { chatMode: this.chatMode || type === 'explore' || type === 'plan', model: this.model }
    );

    // Register for stop propagation
    this.activeSubOrchestrators.add(subOrchestrator);

    let result: MultiAgentResult;
    try {
      result = await subOrchestrator.execute(prompt);
    } finally {
      this.activeSubOrchestrators.delete(subOrchestrator);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Accumulate cost into parent (always, even if stopped mid-run)
    this.totalCost += result.totalCost;
    this.totalUsage.promptTokens += result.totalUsage.promptTokens;
    this.totalUsage.completionTokens += result.totalUsage.completionTokens;
    this.totalUsage.totalTokens += result.totalUsage.totalTokens;
    this.onProgress?.('usage', { usage: this.totalUsage, totalCost: this.totalCost, totalUsage: { ...this.totalUsage } });

    const conv = result.conversation[0];

    let rawResult = '';
    let toolCallCount = 0;
    if (conv) {
      const lastAssistant = [...conv.messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        rawResult = typeof lastAssistant.content === 'string'
          ? lastAssistant.content
          : lastAssistant.content.map(b => b.type === 'text' ? b.text : '').join('');
      }
      toolCallCount = conv.messages.reduce((n, m) => n + (m.role === 'assistant' && m.tool_calls ? m.tool_calls.length : 0), 0);
    }

    const maxLen = 2500;
    const body = rawResult.length > maxLen
      ? rawResult.slice(0, maxLen) + '\n... (truncated)'
      : rawResult;

    // Emit done event with summary
    const bodyPreview = body.length > 120 ? body.slice(0, 120) + '...' : body;
    this.onProgress?.('delegate_progress', {
      type, event: 'agent_done', agentIndex, parentToolIndex,
      data: { elapsed, toolCalls: toolCallCount, bodyPreview },
      delegatePrompt: promptLabel,
    });

    return { type, prompt, body };
  }

  /**
   * Format the footer for a delegate result based on type.
   */
  private getDelegateFooter(type: string): string {
    if (type === 'explore') return 'Use these findings to inform your next steps. The explore agent was read-only — no files were modified.';
    if (type === 'plan') return 'This is an analysis only — no files were modified. Implement the changes yourself based on this plan.';
    if (type === 'task') return 'This specific sub-task is done and its files were modified. Do not repeat this same delegate.';
    return '';
  }

  /**
   * Run one or more delegate sub-agents in parallel. Multiple prompts from a
   * single command (e.g. delegate explore "Q1" "Q2") are all executed concurrently
   * via Promise.allSettled and returned as a combined result.
   */
  private static readonly MAX_PARALLEL_DELEGATES = 8;

  private async runDelegateAgents(delegates: { type: string; prompt: string }[], parentToolIndex?: number): Promise<string> {
    // Cap parallel delegates to prevent runaway spawning
    if (delegates.length > MultiAgentOrchestrator.MAX_PARALLEL_DELEGATES) {
      const cap = MultiAgentOrchestrator.MAX_PARALLEL_DELEGATES;
      return `Error: Too many parallel delegates (${delegates.length}). Maximum is ${cap}. Break the work into smaller batches.`;
    }

    // Single delegate — compact result for parent context
    if (delegates.length === 1) {
      const { type, prompt } = delegates[0];
      const r = await this.runSingleDelegate(type, prompt, 1, parentToolIndex);
      const promptLabel = prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;
      // Keep result concise — parent doesn't need the sub-agent's full tool call log.
      // The tool call summary is emitted via delegate_progress for observability,
      // but only the body (capped at 2500 chars) goes into the parent conversation.
      return `[delegate ${type} — done] "${promptLabel}"\n\n${r.body || '(no result)'}\n\n${this.getDelegateFooter(type)}`;
    }

    // Multiple delegates — run in parallel, combine results
    const settled = await Promise.allSettled(
      delegates.map(({ type, prompt }, i) => this.runSingleDelegate(type, prompt, i + 1, parentToolIndex))
    );

    const type = delegates[0].type;
    const sections: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const promptLabel = delegates[i].prompt.length > 100
        ? delegates[i].prompt.slice(0, 100) + '...'
        : delegates[i].prompt;

      if (s.status === 'fulfilled') {
        const r = s.value;
        sections.push(`[${i + 1}/${delegates.length}] "${promptLabel}"\n${r.body || '(no result)'}`);
      } else {
        sections.push(`[${i + 1}/${delegates.length}] "${promptLabel}"\nError: ${s.reason}`);
      }
    }

    return `[delegate ${type} — done] ${delegates.length} agents completed\n\n${sections.join('\n\n')}\n\n${this.getDelegateFooter(type)}`;
  }

  /**
   * Execute tool calls
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    agent: Agent
  ): Promise<AgentMessage[]> {
    // Phase 1: Identify delegate calls (only for orchestrator — sub-agents cannot delegate)
    // Also heals bare "delegate" tool calls into shell calls so the conversation
    // history shows the correct form and the model learns the right pattern.
    const delegateMap = new Map<number, { type: string; prompt: string }[]>();
    const isOrchestrator = agent.type === 'orchestrator';

    if (isOrchestrator) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        const toolName = tc.function?.name?.replace(HARMONY_TOKEN_STRIP_RE, '').trim();
        try {
          const args = JSON.parse(tc.function.arguments);

          // Normal path: shell tool call containing a delegate command
          if (toolName === 'shell') {
            const info = this.parseDelegateCommand(args?.cmd);
            if (info) delegateMap.set(i, info);
            continue;
          }

          // Heal bare "delegate" tool calls → rewrite as shell in-place
          if (toolName === 'delegate') {
            // Reconstruct the delegate command from various arg shapes
            let cmd = '';
            if (typeof args.cmd === 'string' && args.cmd.trim().startsWith('delegate')) {
              cmd = args.cmd.trim();
            } else if (typeof args.cmd === 'string') {
              cmd = `delegate ${args.cmd.trim()}`;
            } else if (typeof args.type === 'string' && typeof args.prompt === 'string') {
              cmd = `delegate ${args.type} '${args.prompt.replace(/'/g, "'\\''")}'`;
            } else {
              // Last resort: stringify all values as the command
              const vals = Object.values(args).filter(v => typeof v === 'string').join(' ');
              if (vals) cmd = vals.startsWith('delegate') ? vals : `delegate ${vals}`;
            }

            if (cmd) {
              const info = this.parseDelegateCommand(cmd);
              if (info) {
                // Rewrite the tool call so conversation history shows shell, not delegate
                tc.function.name = 'shell';
                tc.function.arguments = JSON.stringify({ cmd });
                delegateMap.set(i, info);
                // Notify UI so the badge updates from "delegate" to "shell"
                this.onProgress?.('tool_healed', { toolIndex: i, name: 'shell', parameters: { cmd } });
                continue;
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // Phase 2: Execute all delegate tool calls in parallel
    // Each call may itself contain multiple prompts (handled by runDelegateAgents)
    const delegateResults = new Map<number, string>();
    if (delegateMap.size > 0) {
      for (const [idx] of delegateMap) {
        this.onProgress?.('tool_status', {
          toolIndex: idx, status: 'executing',
          toolName: 'shell', args: toolCalls[idx].function?.arguments
        });
      }

      const entries = Array.from(delegateMap.entries());
      const settled = await Promise.allSettled(
        entries.map(async ([idx, delegates]) => {
          const result = await this.runDelegateAgents(delegates, idx);
          return { idx, result };
        })
      );

      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        const idx = entries[i][0];
        if (s.status === 'fulfilled') {
          delegateResults.set(s.value.idx, s.value.result);
        } else {
          delegateResults.set(idx, `Error: Delegate failed — ${s.reason}`);
        }
      }

      // Merge multiple separate delegate tool calls into ONE.
      // The LLM should see a single delegate call → single result.
      // We rewrite the first delegate's args to show the combined command,
      // splice the extras from toolCalls (same array ref as response.toolCalls,
      // so the conversation message will also reflect the merge).
      if (delegateResults.size > 1) {
        const delegateIndices = Array.from(delegateResults.keys()).sort((a, b) => a - b);
        const firstIdx = delegateIndices[0];

        // Collect all prompts and results
        const allPrompts: { type: string; prompt: string }[] = [];
        const allResults: string[] = [];
        for (const idx of delegateIndices) {
          allPrompts.push(...(delegateMap.get(idx) || []));
          allResults.push(delegateResults.get(idx)!);
        }

        // Rewrite first delegate's arguments to show the merged multi-prompt command
        const type = allPrompts[0]?.type || 'task';
        const promptLabels = allPrompts.map(d => {
          const p = d.prompt.length > 100 ? d.prompt.slice(0, 100) + '...' : d.prompt;
          return `'${p.replace(/'/g, "\\'")}'`;
        });
        toolCalls[firstIdx].function.arguments = JSON.stringify({
          cmd: `delegate ${type} ${promptLabels.join(' ')}`
        });

        // Build single combined result
        const combinedResult = `[delegate ${type} — ${allPrompts.length} agents completed]\n\n${allResults.join('\n\n---\n\n')}\n\n${this.getDelegateFooter(type)}`;
        delegateResults.clear();
        delegateResults.set(firstIdx, combinedResult);

        // Remove extra delegate tool calls from array (descending order preserves indices)
        const toRemove = delegateIndices.slice(1).sort((a, b) => b - a);
        for (const idx of toRemove) {
          this.onProgress?.('tool_status', {
            toolIndex: idx, status: 'completed',
            toolName: 'shell', args: '(merged)'
          });
          toolCalls.splice(idx, 1);
        }

        // Notify UI about the merge so badges update
        this.onProgress?.('tool_healed', {
          toolIndex: firstIdx,
          name: 'shell',
          parameters: JSON.parse(toolCalls[firstIdx].function.arguments)
        });
      }
    }

    // Phase 3: Process all calls in order
    const results: AgentMessage[] = [];

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
      const toolCall = toolCalls[toolIndex];

      if (this.stopped) break;

      // Return pre-computed delegate result
      if (delegateResults.has(toolIndex)) {
        // Loop detection for delegates — prevent same delegate call repeating
        const delegateSig = this.getToolCallSignature(toolCall);
        if (this.lastToolCallSignature === delegateSig) {
          this.duplicateToolCallCount++;
          if (this.duplicateToolCallCount >= 2) {
            results.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: Duplicate delegate call detected. This delegate already ran and returned a result. Do not call the same delegate again — proceed with your remaining work.`
            });
            this.onProgress?.('tool_status', { toolIndex, status: 'failed', toolName: 'shell', args: toolCall.function?.arguments });
            continue;
          }
        } else {
          this.duplicateToolCallCount = 0;
        }
        this.lastToolCallSignature = delegateSig;

        const content = delegateResults.get(toolIndex)!;
        results.push({ role: 'tool', tool_call_id: toolCall.id, content });
        this.onProgress?.('tool_status', { toolIndex, status: 'completed', toolName: 'shell', args: toolCall.function?.arguments });
        this.onProgress?.('tool_result', { toolIndex, result: content });
        track('tool_call', extractToolAnalytics(toolCall.function.name, toolCall.function.arguments, !content.startsWith('Error:')));
        continue;
      }

      // Sanitize tool name: strip <|...|> tokens that some models emit (e.g. shell<|channel|>)
      const rawToolId = toolCall.function?.name;
      const toolId = rawToolId?.replace(HARMONY_TOKEN_STRIP_RE, '').trim();

      if (!toolId) {
        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'Error: Tool call has no function name. Available tools: shell.'
        });
        this.onProgress?.('tool_status', { toolIndex, status: 'failed', toolName: '(empty)', args: toolCall.function?.arguments });
        continue;
      }

      // Check if agent has access to this tool
      if (!agent.hasTool(toolId)) {
        const knownShellCommands = new Set([
          'ls', 'tree', 'cat', 'head', 'tail', 'rg', 'grep', 'find',
          'mkdir', 'touch', 'rm', 'mv', 'cp', 'echo', 'sed', 'ss', 'wc',
          'sort', 'uniq', 'tr', 'curl', 'sqlite3', 'python', 'python3',
          'lua', 'preview', 'build', 'status', 'delegate', 'runtime'
        ]);
        let errorMsg: string;
        if (toolId === 'ss') {
          // ss is a very common misfire — give a concrete example
          errorMsg = `Error: "ss" is not a tool — it is a shell command. Call it via the shell tool:\n\n  shell({ cmd: "ss /file << 'EOF'\\nsearch text\\n===\\nreplacement text\\nEOF" })`;
        } else if (knownShellCommands.has(toolId)) {
          // Model hallucinated a shell command as a tool name
          errorMsg = `Error: "${toolId}" is not a tool — it is a shell command. Use the shell tool to run it:\n\n  shell({ cmd: "${toolId} ..." })`;
        } else {
          // Completely unknown tool — list available tools and commands
          errorMsg = `Error: Unknown tool "${toolId}". Available tools: shell.\n\nThe shell tool supports these commands: ls, tree, cat, head, tail, rg, grep, find, mkdir, touch, rm, mv, cp, echo, sed, ss, wc, sort, uniq, tr, curl, sqlite3, python, python3, lua, preview, build, status`;
        }
        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: errorMsg
        });
        this.onProgress?.('tool_status', {
          toolIndex,
          status: 'failed',
          toolName: toolId,
          args: toolCall.function?.arguments
        });
        continue;
      }

      // Loop detection - check for consecutive duplicate tool calls
      const currentSignature = this.getToolCallSignature(toolCall);
      if (this.lastToolCallSignature === currentSignature) {
        // Loop detected - increment counter
        this.duplicateToolCallCount++;
        logger.warn(`[MultiAgentOrchestrator] Loop detected: consecutive duplicate tool call #${this.duplicateToolCallCount} - ${currentSignature}`);

        // Get brief parameter summary for error message
        let paramSummary = '';
        try {
          const args = JSON.parse(toolCall.function.arguments);
          const keys = Object.keys(args).slice(0, 3); // Show first 3 params
          paramSummary = keys.map(k => `${k}: ${JSON.stringify(args[k]).substring(0, 50)}`).join(', ');
          if (Object.keys(args).length > 3) paramSummary += '...';
        } catch {
          paramSummary = toolCall.function.arguments.substring(0, 100);
        }

        const interventionMessage = `❌ Loop detected: Duplicate tool call detected.

Tool: ${toolId}
Parameters: ${paramSummary}

The previous call returned a result, but you're calling it again with identical parameters.

💡 Next steps:
• Review the previous tool result - did it contain what you needed?
• If the result was incomplete or unexpected, try a different approach
• If you need additional data, modify your parameters or use a different tool
• Do NOT retry the exact same call

Please revise your approach.`;

        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: interventionMessage
        });

        // Update tool status to failed
        this.onProgress?.('tool_status', {
          toolIndex,
          status: 'failed',
          error: `Loop detected - duplicate tool call #${this.duplicateToolCallCount}`
        });

        // Terminate if we've seen 3 consecutive duplicates
        if (this.duplicateToolCallCount >= 3) {
          throw new Error(`Execution terminated: Too many consecutive duplicate tool calls (${this.duplicateToolCallCount}). The model appears stuck in a loop.`);
        }

        // Skip executing this duplicate call
        continue;
      }

      // Reset duplicate counter on any non-duplicate call
      this.duplicateToolCallCount = 0;

      // Update last tool call signature
      this.lastToolCallSignature = currentSignature;

      // Pattern loop detection — track recent signatures in a sliding window
      this.recentToolSignatures.push(currentSignature);
      if (this.recentToolSignatures.length > this.patternWindowSize) {
        this.recentToolSignatures.shift();
      }
      if (this.recentToolSignatures.length === this.patternWindowSize) {
        const repeatingPattern = this.detectRepeatingPattern(this.recentToolSignatures);
        if (repeatingPattern) {
          logger.error(`[MultiAgentOrchestrator] Repeating pattern detected (cycle length ${repeatingPattern}), terminating`);
          throw new Error(`Execution terminated: Repeating tool call pattern detected. The model appears stuck in a loop.`);
        }
      }

      // Emit tool execution start
      this.onProgress?.('tool_status', {
        toolIndex,
        toolName: toolId,
        status: 'executing',
        args: toolCall.function.arguments
      });

      // Build execution context. Wrap onProgress so we can pick off control-flow
      // events (`ask`, `project_ready`) that need to flip orchestrator flags
      // before forwarding them to the UI's progress channel.
      const context: ToolExecutionContext = {
        agentType: agent.type,
        isReadOnly: this.chatMode || agent.isReadOnly, // Chat mode forces read-only for all agents
        onProgress: (event, data) => {
          if (event === 'ask') this.awaitingUserSelection = true;
          if (event === 'project_ready') this.setupComplete = true;
          this.onProgress?.(event, data);
        }
      };

      try {
        // Execute tool — race against abort signal so stop() can interrupt stuck tools
        const result = await Promise.race([
          toolRegistry.execute(toolCall, this.projectId, context),
          new Promise<string>((_, reject) => {
            if (this.abortController.signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
            this.abortController.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          }),
        ]);

        // Detect `status --task ... --done ... --remaining ...` in shell commands
        if (toolId === 'shell' && !this.lastStatusResult) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            const cmd = typeof args.cmd === 'string' ? args.cmd : '';
            const statusResult = this.extractStatusResult(cmd, result);
            if (statusResult) {
              this.lastStatusResult = statusResult;
              logger.info(`[MultiAgentOrchestrator] Captured status result: remaining="${statusResult.remaining}"`);
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Check if result indicates an error
        const isError = result.startsWith('Error:');

        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });

        // Emit tool status based on result
        this.onProgress?.('tool_status', {
          toolIndex,
          toolName: toolId,
          status: isError ? 'failed' : 'completed',
          result,
          ...(isError && { error: result })
        });

        this.toolCallCount++;
        track('tool_call', extractToolAnalytics(toolCall.function.name, toolCall.function.arguments, !isError));

        this.onProgress?.('tool_result', {
          toolIndex,
          result
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        results.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Error: ${errorMessage}`
        });

        // Emit tool failure with error
        this.onProgress?.('tool_status', {
          toolIndex,
          status: 'failed',
          error: errorMessage
        });

        this.toolCallCount++;
        track('tool_call', extractToolAnalytics(toolCall.function.name, toolCall.function.arguments, false));
      }
    }

    return results;
  }

  /**
   * Repair orphan tool_calls in the wire payload. Two failure modes:
   *  1. Empty-args tool_call (model emitted `arguments: ""`, often from a stop
   *     during streaming or a provider hiccup). Providers reject this with
   *     "invalid function arguments json string".
   *  2. Tool_call with no matching `role:'tool'` reply before the next assistant
   *     turn (e.g., user clicked stop after the assistant message landed but
   *     before tool execution). Providers reject this with "tool_calls must be
   *     followed by tool messages".
   *
   * For (1): drop the offending tool_call entry. If the assistant message ends
   * up with no tool_calls and no content, drop the whole message.
   * For (2): synthesize a `role:'tool'` placeholder so the sequence is well-formed.
   *
   * Operates on a copy; never mutates the persistent conversation history.
   */
  private repairOrphanToolCalls(messages: Omit<AgentMessage, 'ui_metadata'>[]): Omit<AgentMessage, 'ui_metadata'>[] {
    const out: Omit<AgentMessage, 'ui_metadata'>[] = [];
    let repaired = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) {
        out.push(msg);
        continue;
      }

      const validCalls = msg.tool_calls.filter(tc => {
        const args = tc.function?.arguments;
        if (typeof args !== 'string' || args.trim() === '') {
          repaired++;
          return false;
        }
        return true;
      });

      const contentEmpty = typeof msg.content === 'string'
        ? msg.content.trim() === ''
        : !msg.content || (Array.isArray(msg.content) && msg.content.length === 0);

      if (validCalls.length === 0) {
        if (contentEmpty) {
          continue;
        }
        const { tool_calls: _, ...rest } = msg;
        out.push(rest);
        continue;
      }

      out.push({ ...msg, tool_calls: validCalls });

      const matchedIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === 'assistant') break;
        if (next.role === 'tool' && next.tool_call_id) {
          matchedIds.add(next.tool_call_id);
        }
      }

      for (const tc of validCalls) {
        if (!matchedIds.has(tc.id)) {
          out.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'No result — call was cancelled or aborted before completion.'
          });
          repaired++;
        }
      }
    }

    if (repaired > 0) {
      logger.info(`[MultiAgentOrchestrator] Repaired ${repaired} orphan tool_call entr(ies) in wire payload`);
    }
    return out;
  }

  private async streamLLMResponse(
    messages: AgentMessage[],
    agent: Agent
  ): Promise<{ content?: string; toolCalls?: ToolCall[]; usage?: UsageInfo; reasoningDetails?: ReasoningDetail[]; toolsSent?: boolean }> {
    let { provider, apiKey, model } = this.getProviderConfig();

    // Refresh Codex OAuth token if needed before making the API call
    if (provider === 'openai-codex') {
      const { ensureValidCodexToken } = await import('@/lib/auth/codex-auth');
      apiKey = await ensureValidCodexToken();
    }

    await this.ensurePricing(provider, model);

    const tools = toolRegistry.getDefinitions(agent.tools, agent.type);

    const apiUrl = this.getApiUrl();

    const modelSupportsTools = this.checkModelSupportsTools();

    // Strip ui_metadata from messages
    let sanitizedMessages = messages.map(msg => {
      const { ui_metadata, ...rest } = msg;
      return rest;
    });

    // Repair orphan tool_calls (assistant messages with empty-args calls or no
    // matching tool result). Providers like Minimax via OpenRouter reject these
    // mid-stream with "invalid function arguments json string" and the
    // conversation deadlocks into a nudge loop on every retry.
    sanitizedMessages = this.repairOrphanToolCalls(sanitizedMessages);

    // If model has been failing to use function calling, inject a reminder into the system message
    if (this.totalMalformedToolCalls >= this.malformedThresholdForReminder && sanitizedMessages.length > 0) {
      sanitizedMessages = sanitizedMessages.map((msg, idx) => {
        if (idx === 0 && msg.role === 'system') {
          return {
            ...msg,
            content: msg.content + MALFORMED_TOOL_CALL_PERSISTENT_REMINDER
          };
        }
        return msg;
      });
    }

    // Check if reasoning is enabled for this model
    const reasoningEnabled = this.getConfig().getReasoningEnabled(model);

    const requestBody = {
      messages: sanitizedMessages,
      apiKey,
      model,
      provider,
      ...(modelSupportsTools ? { tools } : {}),
      max_tokens: 16384,
      ...(modelSupportsTools && tools && tools.length > 0 && { tool_choice: 'auto' }),
      ...(reasoningEnabled && { reasoning: { enabled: true } })
    };

    if (this.getConfig().getDebugStreamEnabled()) {
      const toolNames = modelSupportsTools && tools ? tools.map(t => t.name) : [];
      logger.info(`[DebugStream] llm_request → ${provider}/${model} (agent=${agent.type}, msgs=${sanitizedMessages.length}, tools=${toolNames.length})`);
      const { apiKey: _redacted, ...redactedBody } = requestBody as typeof requestBody & { apiKey?: string };
      this.onProgress?.('llm_request', {
        provider,
        model,
        agent: agent.type,
        messageCount: sanitizedMessages.length,
        toolNames,
        body: redactedBody
      });
    }

    const response = await this.fetchWithRetry(
      apiUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      },
      3,
      this.handleRetry.bind(this)
    );

    if (!response.ok) {
      const status = response.status;
      let errorType = 'unknown';
      if (status === 429) errorType = 'rate_limit';
      else if (status === 401 || status === 403) errorType = 'auth';
      else if (status >= 500 || status === 529) errorType = 'server';
      else if (status === 400) errorType = 'invalid_request';

      this.apiErrorCount++;

      let errorMessage = `API call failed: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = typeof errorData.error === 'string'
            ? errorData.error
            : (errorData.error.message || JSON.stringify(errorData.error));
        }
      } catch {}

      // Classify error for telemetry (privacy-safe enum, no response text)
      const lowerMsg = errorMessage.toLowerCase();
      let errorCategory = 'unknown';
      if (status === 402 || (status === 429 && (lowerMsg.includes('credit') || lowerMsg.includes('usage') || lowerMsg.includes('limit') || lowerMsg.includes('exceeded') || lowerMsg.includes('quota')))) {
        errorCategory = 'credit_exhausted';
      } else if (status === 429) {
        errorCategory = 'rate_limited';
      } else if ((status === 400 || status === 404) && (lowerMsg.includes('not found') || lowerMsg.includes('does not exist') || lowerMsg.includes('invalid model'))) {
        errorCategory = 'model_not_found';
      } else if (status === 400 && (lowerMsg.includes('too long') || lowerMsg.includes('too many tokens') || lowerMsg.includes('too large') || lowerMsg.includes('context length'))) {
        errorCategory = 'context_too_long';
      } else if (status === 400 && (lowerMsg.includes('tool') || lowerMsg.includes('function call'))) {
        errorCategory = 'tool_not_supported';
      } else if (status === 401 || status === 403) {
        errorCategory = 'auth_expired';
      } else if (status >= 500 || status === 529) {
        errorCategory = 'server_error';
      } else if (status === 400) {
        errorCategory = 'invalid_request';
      }

      track('api_error', { provider, model, error_type: errorType, error_category: errorCategory, status_code: status });

      // Emit error_paused event and wait for user to continue or stop
      logger.warn(`[MultiAgentOrchestrator] API error (${status}): ${errorMessage}`);
      this.onProgress?.('error_paused', {
        message: errorMessage,
        status,
        errorType,
        provider,
        model,
      });

      // Wait for user to click Continue or Stop
      await new Promise<void>(resolve => {
        this.pauseResolve = resolve;
      });

      // After resume: if user clicked Stop, let the loop's stop check handle it.
      // If user clicked Continue, retry the LLM call by returning a sentinel.
      if (this.stopped) {
        throw new Error('Stopped by user');
      }

      // Inject error context so the model sees different input on retry
      const isJsonParseError = lowerMsg.includes('parse') && lowerMsg.includes('json');
      const errorFeedback = isJsonParseError
        ? `⚠️ TOOL CALL FAILED — your tool call arguments could not be parsed as valid JSON.

Error: ${errorMessage}

The heredoc syntax (ss ... << 'EOF') contains single quotes and newlines that break JSON serialization.
You MUST use a different approach:
- Use sed -i for simple replacements: sed -i 's/old text/new text/g' /file
- Use ss with short inline content (no heredocs with single quotes)
- Break large edits into multiple small sed commands
DO NOT use ss with << 'EOF' blocks. Try again with sed or simpler commands.`
        : `⚠️ Your previous response caused an API error: ${errorMessage}\n\nPlease try a different approach.`;

      messages.push({
        role: 'user',
        content: errorFeedback,
        ui_metadata: { isSyntheticError: true }
      });

      // Retry with the error context now in the conversation
      return this.streamLLMResponse(messages, agent);
    }

    this.turnCount++;
    const result = await this.parseStreamingResponseWithTracking(response, provider, model);

    // Midstream error: provider sent { choices: [], error: {...} } as an SSE chunk
    // (HTTP 200 but upstream rejected the request — common with OpenRouter when
    // the upstream model returns a 4xx). Route through the same error_paused
    // flow as HTTP errors so the user sees the actual reason instead of an
    // empty response that gets nudged into oblivion.
    if (result.midstreamError && (!result.toolCalls || result.toolCalls.length === 0) && !result.content) {
      const errorMessage = result.midstreamError.message;
      const status = typeof result.midstreamError.code === 'number' ? result.midstreamError.code : 0;
      logger.warn(`[MultiAgentOrchestrator] Midstream error: ${errorMessage}`);
      this.apiErrorCount++;
      this.onProgress?.('error_paused', {
        message: errorMessage,
        status,
        errorType: 'midstream',
        provider,
        model,
      });

      await new Promise<void>(resolve => { this.pauseResolve = resolve; });

      if (this.stopped) {
        throw new Error('Stopped by user');
      }

      messages.push({
        role: 'user',
        content: `⚠️ Provider rejected the request mid-stream: ${errorMessage}\n\nThe conversation may contain a malformed prior turn. Try a different approach.`,
        ui_metadata: { isSyntheticError: true }
      });
      return this.streamLLMResponse(messages, agent);
    }

    return { ...result, toolsSent: modelSupportsTools };
  }

  /**
   * Create a new conversation node
   */
  private createConversation(agentType: AgentType): string {
    const id = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const conversation: ConversationNode = {
      id,
      agent_type: agentType,
      messages: [],
      metadata: {
        started_at: Date.now(),
        cost: 0,
        status: 'running'
      }
    };

    this.conversations.set(id, conversation);
    return id;
  }

  /**
   * Record auto checkpoint
   */
  private async recordAutoCheckpoint(description: string): Promise<Checkpoint | null> {
    if (this.serverContext) return null;
    const checkpoint = await checkpointManager.createCheckpoint(this.projectId, description, {
      kind: 'auto',
      baseRevisionId: saveManager.getSavedCheckpointId(this.projectId)
    });
    this.onProgress?.('checkpoint_created', {
      checkpointId: checkpoint.id,
      description,
      timestamp: checkpoint.timestamp
    });

    return checkpoint;
  }

  /**
   * Resolve the effective compaction limit for the current model.
   * Priority: user override > registry contextLength > 128K fallback.
   */
  private resolveCompactionLimit(): number {
    const { provider, model } = this.getProviderConfig();

    // 1. User override
    const userLimit = this.getConfig().getCompactionLimit(provider);
    if (userLimit) return userLimit;

    // 2. Registry lookup (hardcoded models)
    const registryLimit = getModelContextLength(provider, model);
    if (registryLimit) return registryLimit;

    // 3. Cached model metadata (dynamically discovered models)
    const cachedLimit = this.getConfig().getModelContextLengthFromCache(provider, model);
    if (cachedLimit) return cachedLimit;

    // 4. Fallback
    return MultiAgentOrchestrator.DEFAULT_COMPACTION_LIMIT;
  }

  /**
   * Estimate token count of a message (content + tool call arguments).
   */
  private static estimateMessageTokens(msg: AgentMessage): number {
    const contentLen = typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
    const argsLen = msg.tool_calls?.reduce((s, tc) => s + (tc.function?.arguments?.length ?? 0), 0) ?? 0;
    return Math.round((contentLen + argsLen) / 3.5);
  }

  /**
   * Compact the conversation by summarizing older messages and keeping recent ones.
   *
   * Strategy:
   *  - System prompt: kept as-is (re-gathered fresh from VFS)
   *  - Older ~80% of non-system messages: sent for summarization
   *  - Recent ~20% of non-system messages: kept verbatim
   *  - Summary output capped at ~10% of compaction limit
   */
  private async compactConversation(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;

    const preCompactTokens = this.totalUsage.promptTokens;
    const compactionLimit = this.resolveCompactionLimit();

    logger.info(`[Compaction] Starting compaction #${this.compactionCount + 1} (promptTokens=${preCompactTokens}, limit=${compactionLimit})`);

    // 1. Separate system messages from conversation messages
    const systemMessages = conversation.messages.filter(m => m.role === 'system');
    const nonSystemMessages = conversation.messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length < 3) {
      logger.info('[Compaction] Too few non-system messages to compact, skipping');
      return;
    }

    // 2. Group non-system messages into "turns" (assistant + its tool results).
    // A turn is: one assistant message (possibly with tool_calls) + all following
    // tool-role messages that belong to it. User messages are standalone turns.
    // This ensures we never orphan a tool result from its assistant message.
    interface Turn { messages: AgentMessage[]; tokens: number; }
    const turns: Turn[] = [];
    let currentTurn: Turn | null = null;

    for (const msg of nonSystemMessages) {
      if (msg.role === 'tool') {
        // Tool results attach to the current turn (started by assistant)
        if (currentTurn) {
          const t = MultiAgentOrchestrator.estimateMessageTokens(msg);
          currentTurn.messages.push(msg);
          currentTurn.tokens += t;
        }
      } else {
        // assistant or user — starts a new turn
        if (currentTurn) turns.push(currentTurn);
        const t = MultiAgentOrchestrator.estimateMessageTokens(msg);
        currentTurn = { messages: [msg], tokens: t };
      }
    }
    if (currentTurn) turns.push(currentTurn);

    if (turns.length < 2) {
      logger.info('[Compaction] Too few turns to compact, skipping');
      return;
    }

    // Walk backwards from the end, keeping whole turns within the recent budget.
    // Always keep at least 1 turn.
    const recentTokenBudget = Math.round(compactionLimit * MultiAgentOrchestrator.RECENT_KEEP_RATIO);
    let recentTokens = 0;
    let recentTurnCount = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      if (recentTurnCount >= 1 && recentTokens + turns[i].tokens > recentTokenBudget) {
        break;
      }
      recentTokens += turns[i].tokens;
      recentTurnCount++;
    }

    const splitTurnIndex = turns.length - recentTurnCount;

    if (splitTurnIndex <= 0) {
      logger.info('[Compaction] All turns fit in recent budget, skipping compaction');
      return;
    }

    const olderMessages = turns.slice(0, splitTurnIndex).flatMap(t => t.messages);
    const recentMessages = turns.slice(splitTurnIndex).flatMap(t => t.messages);

    logger.info(`[Compaction] Splitting: ${olderMessages.length} older msgs to summarize, ${recentMessages.length} recent msgs to keep (~${recentTokens} tokens)`);

    // 3. Convert older messages to plain text for summarization.
    // Models hallucinate tool calls when they see tool_calls/tool messages in history,
    // even without tool definitions. Flatten everything to user/assistant text.
    const flattenedMessages: AgentMessage[] = [];
    for (const msg of olderMessages) {
      if (msg.role === 'assistant') {
        // Merge tool call info into text content
        let text = typeof msg.content === 'string' ? msg.content : '';
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const args = tc.function?.arguments || '';
            // Truncate very large tool args (file contents) to save tokens
            const truncatedArgs = args.length > 500 ? args.slice(0, 500) + '...[truncated]' : args;
            text += `\n[Called ${tc.function?.name}(${truncatedArgs})]`;
          }
        }
        if (text.trim()) {
          flattenedMessages.push({ role: 'assistant', content: text.trim() });
        }
      } else if (msg.role === 'tool') {
        // Convert tool result to user message (tools role confuses models without tool defs)
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const truncated = content.length > 500 ? content.slice(0, 500) + '...[truncated]' : content;
        if (truncated.trim()) {
          flattenedMessages.push({ role: 'user', content: `[Tool result: ${truncated.trim()}]` });
        }
      } else {
        flattenedMessages.push(msg);
      }
    }

    // Merge consecutive same-role messages (some APIs reject adjacent same-role)
    const mergedMessages: AgentMessage[] = [];
    for (const msg of flattenedMessages) {
      const last = mergedMessages[mergedMessages.length - 1];
      if (last && last.role === msg.role && typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n' + msg.content;
      } else {
        mergedMessages.push({ ...msg });
      }
    }

    const compactionMessages: AgentMessage[] = [
      ...systemMessages,
      ...mergedMessages,
      { role: 'user', content: COMPACTION_PROMPT }
    ];

    const { provider, apiKey, model } = this.getProviderConfig();
    const summaryMaxTokens = Math.min(16384, Math.max(256, Math.round(compactionLimit * MultiAgentOrchestrator.SUMMARY_TOKEN_RATIO)));

    const requestBody = {
      messages: compactionMessages.map(({ ui_metadata, reasoning_details, ...rest }) => rest),
      apiKey,
      model,
      provider,
      stream: true,
      max_tokens: summaryMaxTokens,
    };

    const response = await apiFetch(this.getApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      logger.error(`[Compaction] Compaction request failed: ${response.status}`);
      return; // Fail silently — continue with uncompacted context
    }

    const result = await parseStreamingResponse(response, {
      provider,
      model,
    });

    const summary = result.content || '';
    if (!summary) {
      logger.error('[Compaction] Compaction returned empty summary');
      return;
    }

    // Track compaction cost
    if (result.usage) {
      const cost = CostCalculator.calculateCost(result.usage, provider, model, true);
      this.totalUsage.promptTokens += result.usage.promptTokens;
      this.totalUsage.completionTokens += result.usage.completionTokens;
      this.totalUsage.totalTokens += result.usage.totalTokens;
      this.totalCost += cost;
    }

    // 4. Re-gather fresh system prompt from current VFS state
    const serverContext = this.getVFS().getServerContextMetadata();
    const systemPrompt = await buildShellSystemPrompt(this.chatMode, serverContext, this.projectId, this.rootAgent.type);

    let fileTreeStr = '';
    try {
      const files = await this.getVFS().listDirectory(this.projectId, '/');
      if (files.length > 0) {
        fileTreeStr = buildFileTree(files);
      }
    } catch {
      // Ignore
    }
    const projectContext = await buildProjectContext(fileTreeStr, serverContext);

    // 5. Replace conversation messages:
    //    [fresh system prompt] + [project context as user msg] + [summary as assistant] + [recent messages]
    const summaryContent = `Here is a summary of the conversation so far:\n\n${summary}`;

    conversation.messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: projectContext
        ? `${projectContext}\n\nThe earlier conversation was compacted into the summary below.`
        : 'The earlier conversation was compacted into the summary below.' },
      { role: 'assistant', content: summaryContent, ui_metadata: { isCompactSummary: true } },
      ...recentMessages,
    ];

    // 6. Update state
    this.compactionCount++;
    this.totalUsage.promptTokens = 0; // Reset so cumulative count restarts post-compaction

    // Reset loop detection (stale after context change)
    this.lastToolCallSignature = null;
    this.duplicateToolCallCount = 0;
    this.recentToolSignatures = [];
    this.nudgeCount = 0;

    // 7. Estimate post-compact tokens
    const postCompactEstimate = Math.round(
      conversation.messages.reduce((sum, m) => sum + MultiAgentOrchestrator.estimateMessageTokens(m), 0)
    );

    logger.info(`[Compaction] Complete: ~${preCompactTokens} → ~${postCompactEstimate} tokens (compaction #${this.compactionCount}, ${conversation.messages.length} msgs)`);

    // 8. Emit compaction event for UI
    this.onProgress?.('compaction', {
      preCompactTokens,
      postCompactEstimate,
      compactionNumber: this.compactionCount,
    });

    try {
      const { provider, model } = this.getProviderConfig();
      track('compaction_fired', {
        tokens_before: preCompactTokens,
        tokens_after: postCompactEstimate,
        provider,
        model,
      });
    } catch {
      // telemetry best-effort
    }
  }

  /**
   * Get provider configuration
   */
  private getProviderConfig() {
    if (this.serverContext) {
      const cfg = this.getConfig();
      const provider = cfg.getSelectedProvider();
      return {
        provider,
        apiKey: cfg.getProviderApiKey(provider) || '',
        model: cfg.getProviderModel(provider) || this.model || 'default-model'
      };
    }

    const provider = configManager.getSelectedProvider();
    const providerConfig = getProvider(provider);
    const apiKey = configManager.getProviderApiKey(provider);
    // Prefer live config over this.model (which can go stale on provider switch)
    const model = configManager.getProviderModel(provider) || this.model || undefined;

    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }

    return {
      provider,
      apiKey: apiKey || '',
      model: model || 'default-model'
    };
  }

  /**
   * Handle retry notifications
   */
  private handleRetry(attempt: number, delay: number, status?: number) {
    const reason = status === 429 ? 'Rate limited' : `Server error (${status || 'unknown'})`;
    const message = `${reason}. Retry attempt ${attempt} in ${delay/1000}s...`;
    logger.warn(message);

    this.onProgress?.('retry', {
      attempt,
      delay,
      reason,
      message
    });

    this.notify('info', message, {
      duration: delay > 2000 ? delay - 500 : 2000,
    });
  }

  /**
   * Ensure pricing data is available
   */
  private async ensurePricing(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;
    if (this.pricingEnsured.has(key)) {
      return;
    }

    if (provider !== 'openrouter') {
      this.pricingEnsured.add(key);
      return;
    }

    if (this.getConfig().getModelPricing('openrouter', model)) {
      this.pricingEnsured.add(key);
      return;
    }

    const cachedModels = this.getConfig().getCachedModels('openrouter');
    if (cachedModels?.models?.length) {
      registerPricingFromProviderModels('openrouter', cachedModels.models);
      if (this.getConfig().getModelPricing('openrouter', model)) {
        this.pricingEnsured.add(key);
        return;
      }
    }

    try {
      const models = await fetchAvailableModels();
      registerOpenRouterPricingFromApi(models);
      if (this.getConfig().getModelPricing('openrouter', model)) {
        this.pricingEnsured.add(key);
      }
    } catch (error) {
      logger.warn('[MultiAgentOrchestrator] Failed to fetch pricing metadata', error);
    }
  }

  /**
   * Retry logic for HTTP requests
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = 3,
    onRetry?: (attempt: number, delay: number, status: number) => void
  ): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await apiFetch(url, { ...options, signal: this.abortController.signal });

      // Retry on rate limits (429), transient server errors (502, 504), and Anthropic overloaded (529)
      // Note: 503 is NOT retried — OpenRouter uses it for "no provider available" which is not transient
      const retryableStatus = response.status === 429 || response.status === 502 || response.status === 504 || response.status === 529;
      if (!retryableStatus) {
        return response;
      }

      if (attempt === maxRetries) {
        return response;
      }

      const retryAfter = response.headers.get('Retry-After');
      const parsed = retryAfter ? parseInt(retryAfter) : NaN;
      const delay = !isNaN(parsed) ? parsed * 1000 : Math.pow(2, attempt) * 1000;

      onRetry?.(attempt + 1, delay, response.status);
      await sleep(delay);
    }

    throw new Error('Unexpected end of retry loop');
  }

  /**
   * Parse streaming response using helper
   */
  private async parseStreamingResponseWithTracking(
    response: Response,
    provider: string,
    model: string
  ): Promise<{ content?: string; toolCalls?: ToolCall[]; usage?: UsageInfo; reasoningDetails?: ReasoningDetail[]; midstreamError?: { code?: number | string; message: string } }> {
    const result = await parseStreamingResponse(response, {
      provider,
      model,
      debugStream: this.getConfig().getDebugStreamEnabled(),
      onProgress: this.onProgress
    });

    // Update cost tracking
    if (result.usage) {
      const usage = result.usage;
      if (!usage.provider) usage.provider = provider;
      if (!usage.model) usage.model = model;

      const cost = CostCalculator.calculateCost(usage, provider, model, true);
      usage.cost = cost;

      this.totalUsage.promptTokens += usage.promptTokens;
      this.totalUsage.completionTokens += usage.completionTokens;
      this.totalUsage.totalTokens += usage.totalTokens;
      this.totalCost += cost;

      this.getConfig().updateSessionCost(usage, cost);

      const sessionId = this.getConfig().getCurrentSession?.()?.sessionId;
      if (!this.projectId.startsWith('test-') && this.rootAgent.type !== 'setup') {
        this.getVFS().updateProjectCost(this.projectId, {
          cost,
          provider: usage.provider || provider || 'unknown',
          tokenUsage: {
            input: usage.promptTokens,
            output: usage.completionTokens
          },
          sessionId,
          mode: 'absolute'
        }).catch(err => logger.error('Failed to update project cost:', err));
      }

      this.onProgress?.('usage', { usage, totalCost: this.totalCost, totalUsage: { ...this.totalUsage } });
    }

    return result;
  }

  /**
   * Extract status result from a shell command or its output.
   * Detects: `status --task "..." --done "..." --remaining "..." --complete`
   */
  private extractStatusResult(cmd: string, output: string): { task: string; done: string; remaining: string; complete: boolean; hasExplicitFlag: boolean } | null {
    // If the output contains an error, the status command failed — don't trust command-level parsing
    const hasError = output && /^Error:\s/im.test(output);

    // 1. Check shell output for Task:/Done:/Remaining:/Complete: lines (from cli-shell status handler)
    // Prefer output over command parsing since it reflects actual execution result
    if (output) {
      const taskLine = output.match(/^Task:\s*(.+)/im);
      const doneLine = output.match(/^Done:\s*(.+)/im);
      const remainingLine = output.match(/^Remaining:\s*(.*)/im);
      const completeLine = output.match(/^Complete:\s*(yes|no)/im);
      if (taskLine && doneLine) {
        return {
          task: taskLine[1].trim(),
          done: doneLine[1].trim(),
          remaining: remainingLine ? remainingLine[1].trim() : 'none',
          complete: completeLine ? completeLine[1].toLowerCase() === 'yes' : false,
          hasExplicitFlag: !!completeLine
        };
      }
    }

    // 2. Fallback: check the command itself for `status --task ... --done ... --remaining ...`
    // Skip if the output had errors — the command may have been malformed
    if (!hasError && /^\s*status\b/i.test(cmd)) {
      const taskMatch = cmd.match(/--task\s+"([^"]*)"/) || cmd.match(/--task\s+'([^']*)'/) || cmd.match(/--task\s+(\S+)/);
      const doneMatch = cmd.match(/--done\s+"([^"]*)"/) || cmd.match(/--done\s+'([^']*)'/) || cmd.match(/--done\s+(\S+)/);
      const remainingMatch = cmd.match(/--remaining\s+"([^"]*)"/) || cmd.match(/--remaining\s+'([^']*)'/) || cmd.match(/--remaining\s+(\S+)/);
      const hasComplete = /--complete\b/.test(cmd);
      const hasIncomplete = /--incomplete\b/.test(cmd);
      if (taskMatch && doneMatch) {
        return {
          task: taskMatch[1],
          done: doneMatch[1],
          remaining: remainingMatch ? remainingMatch[1] : 'none',
          complete: hasComplete && !hasIncomplete,
          hasExplicitFlag: hasComplete || hasIncomplete
        };
      }
    }

    return null;
  }

  /**
   * Detect repeating patterns in a window of tool call signatures.
   * Checks for cycles of length 1-4 that repeat at least patternRepeatThreshold times.
   * e.g. [A,B,A,B,A,B,A,B,A,B,A,B] → cycle length 2, repeated 6 times.
   * Returns the cycle length if found, null otherwise.
   */
  private detectRepeatingPattern(signatures: string[]): number | null {
    const len = signatures.length;
    // Check cycle lengths 2 through 4 (length 1 handled by consecutive duplicate check)
    for (let cycleLen = 2; cycleLen <= 4; cycleLen++) {
      if (len < cycleLen * this.patternRepeatThreshold) continue;
      // Check if the last N entries are all repetitions of the same cycle
      const checkLen = cycleLen * this.patternRepeatThreshold;
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

  /**
   * Generate a normalized signature for a tool call to detect duplicates
   */
  private getToolCallSignature(toolCall: ToolCall): string {
    const toolName = toolCall.function?.name || 'unknown';

    try {
      const args = JSON.parse(toolCall.function.arguments);
      if (toolName === 'shell') {
        // Shell: signature from command string
        const cmd = Array.isArray(args.cmd)
          ? args.cmd.join(' ')
          : String(args.cmd || '');
        return `${toolName}:${cmd}`;
      }
      // Non-shell tools: signature from full serialized arguments
      return `${toolName}:${toolCall.function.arguments}`;
    } catch {
      return `${toolName}:${toolCall.function.arguments}`;
    }
  }

}
