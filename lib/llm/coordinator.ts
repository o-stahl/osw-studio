// lib/llm/coordinator.ts
// Multi-agent coordinator — intercepts `agent` commands from the orchestrator loop
// and spawns child AgentLoops. Passes all other tool calls through to the inner executor.

import { AgentLoop } from './core/agent-loop';
import { ContextManagerImpl } from './core/context-manager';
import { track } from '@/lib/telemetry';
import { OSWS_PROVIDER } from '@/lib/inference/allowance';
import type {
  ToolExecutor,
  ToolCall,
  ToolResult,
  ToolExecContext,
  ProviderAdapter,
  ProgressReporter,
  CostTracker,
  AgentLoopConfig,
  CompactionConfig,
  AgentLoopResult,
} from './core/types';

export interface CoordinatorConfig {
  innerExecutor: ToolExecutor;
  provider: ProviderAdapter;
  progress: ProgressReporter;
  cost: CostTracker;
  projectId: string;
  chatMode: boolean;
  compactionConfig: CompactionConfig;
  buildSystemPrompt: (agentType: string) => Promise<string>;
  /**
   * Build a provider/executor scoped to a child agent's progress reporter.
   * Without these, children share the parent's instances — whose progress
   * events (streaming deltas, tool statuses) leak unwrapped into the main
   * UI channel instead of being nested under agent_progress.
   */
  createChildProvider?: (progress: ProgressReporter) => ProviderAdapter;
  createChildExecutor?: (progress: ProgressReporter) => ToolExecutor;
}

export class MultiAgentCoordinator {
  private innerExecutor: ToolExecutor;
  private runningChildren = new Set<AgentLoop>();
  private stopped = false;
  private lastAgentKey = '';
  private lastAgentTurnId: number | null = null;

  /** Child-loop events forwarded to the parent UI, wrapped in agent_progress. */
  private static readonly FORWARDED_CHILD_EVENTS = new Set([
    'tool_status', 'tool_result', 'error', 'stopped', 'nudge', 'exit_reason',
  ]);

  private static readonly MAX_PARALLEL_AGENTS = 8;
  private static readonly MAX_PARALLEL_AGENTS_ALLOWANCE = 4;

  constructor(private config: CoordinatorConfig) {
    this.innerExecutor = config.innerExecutor;
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.runningChildren) {
      child.stop();
    }
    this.runningChildren.clear();
  }

  /**
   * Returns a ToolExecutor that intercepts `agent` commands and spawns child loops,
   * passing everything else through to the inner executor.
   */
  createWrappedExecutor(): ToolExecutor {
    return {
      getDefinitions: (agentType: string) => this.innerExecutor.getDefinitions(agentType),
      execute: async (toolCall: ToolCall, context: ToolExecContext): Promise<ToolResult> => {
        const cmd = this.extractCmd(toolCall);
        const agents = this.parseAgentCommand(cmd);
        if (agents && context.agentType === 'orchestrator') {
          // Dedup: some models emit the same agent command as multiple tool calls
          // in one turn. Only dedup within the same turn — an identical
          // re-delegation in a later turn is legitimate.
          const key = agents.map(a => `${a.type}:${a.prompt.trim()}`).sort().join('|');
          const turnId = context.turnId ?? null;
          if (key === this.lastAgentKey && turnId !== null && turnId === this.lastAgentTurnId) {
            return {
              tool_call_id: toolCall.id,
              content: '(Duplicate agent call — already executed this turn. Results are above.)',
              success: true,
            };
          }
          const result = await this.runAgents(agents);
          // Don't record errored batches as executed — a retry must run, not
          // get a false "already executed" response.
          if (result.startsWith('Error:')) {
            this.lastAgentKey = '';
            this.lastAgentTurnId = null;
          } else {
            this.lastAgentKey = key;
            this.lastAgentTurnId = turnId;
          }
          return { tool_call_id: toolCall.id, content: result, success: true };
        }
        this.lastAgentKey = '';
        this.lastAgentTurnId = null;
        return this.innerExecutor.execute(toolCall, context);
      },
    };
  }

  // --- Private helpers ---

  private extractCmd(toolCall: ToolCall): string {
    try {
      const args = JSON.parse(toolCall.function.arguments);
      const cmd = args.command ?? args.cmd;
      return typeof cmd === 'string' ? cmd : '';
    } catch {
      return '';
    }
  }

  /**
   * Parse an agent command string into typed prompts.
   * Accepts both `agent` (primary) and `delegate` (backward compat alias).
   *
   * Forms:
   *   agent task "do X" "do Y"          → 2 parallel task agents
   *   agent explore "single question"   → 1 agent
   *   agent explore unquoted text       → 1 agent (backward compat)
   *   agent type << 'EOF'\nprompt\nEOF  → 1 agent (heredoc)
   */
  private parseAgentCommand(rawCmd: string): { type: string; prompt: string }[] | null {
    if (!rawCmd) return null;
    const start = rawCmd.trimStart();
    if (!start.startsWith('agent ') && !start.startsWith('delegate ')) return null;
    const trimmed = rawCmd.trim();

    // Heredoc: agent type << 'EOF'\nprompt\nEOF — always single agent
    const heredocRe = /^(?:agent|delegate)\s+(explore|task|plan)\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\2\s*$/;
    const hm = trimmed.match(heredocRe);
    if (hm) return [{ type: hm[1], prompt: hm[3].trim() }];

    // Inline: agent type followed by prompt(s)
    const inlineRe = /^(?:agent|delegate)\s+(explore|task|plan)\s+([\s\S]+)$/;
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
   * Extract top-level quoted strings from an agent command's argument portion.
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
      let foundClosing = false;

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
            foundClosing = true;
            break;
          }
          // Otherwise it's an inner quote — keep scanning
        }

        i++;
      }

      // If we ran off the end without finding a closing quote, take what we have
      if (!foundClosing && i >= input.length) {
        const content = input.slice(start).trim();
        if (content) prompts.push(content);
      }
    }

    return prompts;
  }

  /**
   * Run one child agent. Creates a fresh AgentLoop with restricted config.
   */
  private async runAgentChild(
    type: string,
    prompt: string,
    agentIndex: number
  ): Promise<{ type: string; prompt: string; body: string }> {
    if (this.stopped) {
      return { type, prompt, body: '(Cancelled — parent stopped)' };
    }

    track('agent_spawned', { type });

    const promptLabel = prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt;
    const startedAt = Date.now();
    this.config.progress.onEvent('agent_progress', {
      type,
      event: 'agent_start',
      agentIndex,
      agentPrompt: promptLabel,
    });

    // One scoped reporter for the child's loop, provider, and executor —
    // everything the child emits is filtered and wrapped in agent_progress.
    const childProgress: ProgressReporter = {
      onEvent: (event: string, data?: Record<string, unknown>) => {
        if (!MultiAgentCoordinator.FORWARDED_CHILD_EVENTS.has(event)) return;
        this.config.progress.onEvent('agent_progress', {
          type,
          event,
          data,
          agentIndex,
          agentPrompt: promptLabel,
        });
      },
    };

    // Create fresh context for child. The child's system prompt differs from the
    // orchestrator's, so the parent's getFreshContext must not leak into it.
    const childContext = new ContextManagerImpl({
      ...this.config.compactionConfig,
      getFreshContext: undefined,
    });
    const systemPrompt = await this.config.buildSystemPrompt(type);
    childContext.setSystemPrompt(systemPrompt);

    const childConfig: AgentLoopConfig = {
      maxIterations: type === 'explore' ? 5 : type === 'plan' ? 10 : 30,
      maxNudges: type === 'explore' ? 1 : 2,
      maxDuplicateToolCalls: 3,
      agentType: type,
      isReadOnly: this.config.chatMode || type === 'explore' || type === 'plan',
    };

    const childLoop = new AgentLoop({
      config: childConfig,
      provider: this.config.createChildProvider?.(childProgress) ?? this.config.provider,
      // Inner-level executor — children cannot spawn sub-agents
      executor: this.config.createChildExecutor?.(childProgress) ?? this.innerExecutor,
      context: childContext,
      progress: childProgress,
      cost: this.config.cost, // Shared — accumulates into parent
    });

    this.runningChildren.add(childLoop);
    let result: AgentLoopResult;
    try {
      result = await childLoop.run(prompt);
    } finally {
      this.runningChildren.delete(childLoop);
    }

    // Extract last assistant message as the body
    const messages = childContext.getMessages();
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    let rawResult = '';
    if (lastAssistant) {
      rawResult = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : JSON.stringify(lastAssistant.content);
    }
    const maxLen = 2500;
    const body = rawResult.length > maxLen
      ? rawResult.slice(0, maxLen) + '\n... (truncated)'
      : rawResult;

    this.config.progress.onEvent('agent_progress', {
      type,
      event: 'agent_done',
      agentIndex,
      agentPrompt: promptLabel,
      data: {
        body: body.slice(0, 120),
        success: result.success,
        elapsed: Math.round((Date.now() - startedAt) / 1000),
      },
    });

    return { type, prompt, body };
  }

  /**
   * Run sub-agents and combine their results into a single string for the parent context.
   */
  private async runAgents(agents: { type: string; prompt: string }[]): Promise<string> {
    // The free allowance takes fewer requests in flight per visitor than the agent can start.
    const cap = this.config.provider.getProvider() === OSWS_PROVIDER
      ? MultiAgentCoordinator.MAX_PARALLEL_AGENTS_ALLOWANCE
      : MultiAgentCoordinator.MAX_PARALLEL_AGENTS;
    if (agents.length > cap) {
      return `Error: Too many parallel agents (${agents.length}). Maximum is ${cap}. Break the work into smaller batches.`;
    }

    if (agents.length === 1) {
      const { type, prompt } = agents[0];
      const r = await this.runAgentChild(type, prompt, 1);
      const label = prompt.length > 120 ? prompt.slice(0, 120) + '...' : prompt;
      return `[agent ${type} — done] "${label}"\n\n${r.body || '(no result)'}\n\n${this.getAgentFooter(type)}`;
    }

    const settled = await Promise.allSettled(
      agents.map(({ type, prompt }, i) => this.runAgentChild(type, prompt, i + 1))
    );

    const type = agents[0].type;
    const sections: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const label = agents[i].prompt.length > 100
        ? agents[i].prompt.slice(0, 100) + '...'
        : agents[i].prompt;

      if (s.status === 'fulfilled') {
        sections.push(`[${i + 1}/${agents.length}] "${label}"\n${s.value.body || '(no result)'}`);
      } else {
        sections.push(`[${i + 1}/${agents.length}] "${label}"\nError: ${s.reason}`);
      }
    }

    return `[agent ${type} — done] ${agents.length} agents completed\n\n${sections.join('\n\n')}\n\n${this.getAgentFooter(type)}`;
  }

  private getAgentFooter(type: string): string {
    if (type === 'explore') return 'Use these findings to inform your next steps. The explore agent was read-only — no files were modified.';
    if (type === 'plan') return 'This is an analysis only — no files were modified. Implement the changes yourself based on this plan.';
    if (type === 'task') return 'This sub-task is done and its files were modified. Do not repeat this same agent call.';
    return '';
  }
}
