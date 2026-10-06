// lib/llm/core/types.ts
import type { ToolCall, UsageInfo, ContentBlock, ReasoningDetail } from '../types';

export type { ToolCall, UsageInfo, ContentBlock, ReasoningDetail };

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_details?: ReasoningDetail[];
  metadata?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  success: boolean;
  signals?: Record<string, unknown>;
}

export interface ParsedResponse {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: UsageInfo;
  reasoningDetails?: ReasoningDetail[];
  /** Set when the stream was aborted early on an unexpected tool name. */
  invalidToolName?: string;
}

export interface ProviderCallParams {
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** When true, provider should suppress progress events (used for compaction calls). */
  silent?: boolean;
}

export interface ProviderAdapter {
  call(params: ProviderCallParams): Promise<ParsedResponse>;
  getModel(): string;
  getProvider(): string;
  supportsTools(): boolean;
}

export interface ToolExecContext {
  agentType: string;
  isReadOnly: boolean;
  workingDirectory?: string;
  /** Monotonic turn counter from the owning loop — lets executors scope per-turn behavior (e.g. dedup). */
  turnId?: number;
}

export interface ToolExecutor {
  execute(toolCall: ToolCall, context: ToolExecContext): Promise<ToolResult>;
  getDefinitions(agentType: string): ToolDef[];
}

export interface CompactionConfig {
  contextLength: number;
  threshold: number;
  recentKeepRatio: number;
  summaryTokenRatio: number;
  buildCompactionPrompt: (previousSummary?: string) => string;
  /** Resolves a fresh system prompt / project context for the post-compaction rebuild. */
  getFreshContext?: () => Promise<{ systemPrompt?: string; projectContext?: string }>;
}

export interface ContextManager {
  getMessages(): Message[];
  /** Messages with orphan tool calls repaired — what should actually be sent to providers. */
  getSanitizedMessages(): Message[];
  setSystemPrompt(prompt: string): void;
  addUserMessage(content: string | ContentBlock[]): void;
  addAssistantTurn(response: ParsedResponse): void;
  addToolResults(results: ToolResult[]): void;
  importMessages(messages: Message[]): void;
  needsCompaction(tokenCount: number): boolean;
  compact(provider: ProviderAdapter, opts?: { freshSystemPrompt?: string; projectContext?: string; signal?: AbortSignal }): Promise<UsageInfo | undefined>;
  getTokenEstimate(): number;
  getCompactionCount(): number;
  onMessageAdded?: (message: Message) => void;
  /** Called after compact() replaces the message array — allows the caller to sync external state. */
  onMessagesReplaced?: (newMessages: Message[]) => void;
}

export interface ProgressReporter {
  onEvent(event: string, data?: Record<string, unknown>): void;
}

export interface CostTracker {
  record(usage: UsageInfo, provider: string, model: string): void;
  getTurnCost(): number;
  getTotalCost(): number;
  getTotalUsage(): UsageInfo;
  resetTurn(): void;
}

export interface AgentLoopConfig {
  maxIterations: number;
  maxNudges: number;
  maxDuplicateToolCalls: number;
  agentType: string;
  isReadOnly: boolean;
  completionGate?: () => Promise<string | null>;
  /**
   * `retry` resends the same request: the provider failed, not the model's approach, so there is
   * nothing to tell the model.
   */
  onProviderError?: (error: Error) => Promise<'retry' | 'stop'>;
}

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  exitReason: string;
  totalCost: number;
  totalUsage: UsageInfo;
  toolCount: number;
  turnCount: number;
}
