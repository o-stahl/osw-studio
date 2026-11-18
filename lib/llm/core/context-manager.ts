// lib/llm/core/context-manager.ts
// Portable context manager — no browser imports, no VFS, no Next.js, no configManager.

import type {
  Message,
  ParsedResponse,
  ToolResult,
  ProviderAdapter,
  CompactionConfig,
  ContextManager,
  ContentBlock,
  UsageInfo,
} from './types';

/** What one attached image counts for in the estimate: about what a page screenshot costs a model. */
const IMAGE_TOKENS = 1_500;
/** What one audio clip counts for: about 30 seconds of speech, at the 32 tokens a second Gemini counts. */
const AUDIO_TOKENS = 1_000;

export class ContextManagerImpl implements ContextManager {
  private messages: Message[] = [];
  private compactionCount = 0;
  onMessageAdded?: (message: Message) => void;
  onMessagesReplaced?: (newMessages: Message[]) => void;

  constructor(private config: CompactionConfig) {}

  getMessages(): Message[] {
    return this.messages;
  }

  getCompactionCount(): number {
    return this.compactionCount;
  }

  setSystemPrompt(prompt: string): void {
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0] = { role: 'system', content: prompt };
    } else {
      this.messages.unshift({ role: 'system', content: prompt });
    }
  }

  addUserMessage(content: string | ContentBlock[]): void {
    const msg: Message = { role: 'user', content };
    this.messages.push(msg);
    this.onMessageAdded?.(msg);
  }

  addAssistantTurn(response: ParsedResponse): void {
    // Sanitize tool call arguments: providers reject invalid JSON in history
    if (response.toolCalls?.length) {
      for (const tc of response.toolCalls) {
        if (tc.function?.arguments) {
          try { JSON.parse(tc.function.arguments); } catch {
            tc.function.arguments = '{}';
          }
        }
      }
    }
    const msg: Message = {
      role: 'assistant',
      content: response.content || '',
      ...(response.toolCalls?.length ? { tool_calls: response.toolCalls } : {}),
      ...(response.reasoningDetails?.length ? { reasoning_details: response.reasoningDetails } : {}),
    };
    this.messages.push(msg);
    this.onMessageAdded?.(msg);
  }

  addToolResults(results: ToolResult[]): void {
    for (const r of results) {
      const msg: Message = { role: 'tool', content: r.content, tool_call_id: r.tool_call_id };
      this.messages.push(msg);
      this.onMessageAdded?.(msg);
    }
  }

  /**
   * A user message carrying a command's images, after the tool results: most providers carry only
   * text in a tool result. Not passed to `onMessageAdded`, so it stays out of the stored
   * conversation, and an earlier one is reduced to its caption, so a run of screenshots does not
   * send every image again with every later request.
   */
  addImages(images: { mediaType: string; data: string }[], caption: string): void {
    if (images.length === 0) return;
    for (const msg of this.messages) {
      if (!msg.metadata?.screenshot || typeof msg.content === 'string') continue;
      const text = msg.content.find((block): block is { type: 'text'; text: string } => block.type === 'text')?.text ?? '';
      msg.content = `${text} (no longer attached)`;
    }
    this.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: caption },
        ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
      ],
      metadata: { screenshot: true },
    });
  }

  importMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  getTokenEstimate(): number {
    return this.messages.reduce((sum, m) => sum + ContextManagerImpl.estimateMessageTokens(m), 0);
  }

  needsCompaction(tokenCount: number): boolean {
    return tokenCount >= this.config.threshold;
  }

  /**
   * Returns messages with orphan tool calls repaired.
   * Operates on a copy; never mutates the persistent conversation history.
   */
  getSanitizedMessages(): Message[] {
    return this.repairOrphanToolCalls(this.messages);
  }

  /**
   * Compact the conversation by summarizing older messages and keeping recent ones.
   *
   * Strategy:
   *  - System prompt: replaced with opts.freshSystemPrompt
   *  - Older ~80% of non-system messages: sent for summarization via provider
   *  - Recent ~20% of non-system messages: kept verbatim
   *  - Summary output capped at ~10% of contextLength
   */
  async compact(
    provider: ProviderAdapter,
    opts?: { freshSystemPrompt?: string; projectContext?: string; signal?: AbortSignal }
  ): Promise<UsageInfo | undefined> {
    // 1. Separate system messages from conversation messages. A screenshot is for the moment it was
    //    taken, so none is summarised; the newest is kept, after the recent messages, because the
    //    model may not have seen it yet (`addImages` runs just before the compaction check).
    const systemMessages = this.messages.filter(m => m.role === 'system');
    const nonSystemMessages = this.messages.filter(m => m.role !== 'system' && !m.metadata?.screenshot);
    const screenshots = this.messages.filter(m => m.metadata?.screenshot);
    const newestScreenshot = screenshots[screenshots.length - 1];

    if (nonSystemMessages.length < 3) {
      return undefined;
    }

    // 2. Group non-system messages into "turns" (assistant + its tool results).
    // A turn is: one assistant message (possibly with tool_calls) + all following
    // tool-role messages that belong to it. User messages are standalone turns.
    // This ensures we never orphan a tool result from its assistant message.
    interface Turn { messages: Message[]; tokens: number }
    const turns: Turn[] = [];
    let currentTurn: Turn | null = null;

    for (const msg of nonSystemMessages) {
      if (msg.role === 'tool') {
        // Tool results attach to the current turn (started by assistant)
        if (currentTurn) {
          const t = ContextManagerImpl.estimateMessageTokens(msg);
          currentTurn.messages.push(msg);
          currentTurn.tokens += t;
        }
      } else {
        // assistant or user — starts a new turn
        if (currentTurn) turns.push(currentTurn);
        const t = ContextManagerImpl.estimateMessageTokens(msg);
        currentTurn = { messages: [msg], tokens: t };
      }
    }
    if (currentTurn) turns.push(currentTurn);

    if (turns.length < 2) {
      return undefined;
    }

    // Walk backwards from the end, keeping whole turns within the recent budget.
    // Always keep at least 1 turn.
    const recentTokenBudget = Math.round(this.config.contextLength * this.config.recentKeepRatio);
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
      return undefined;
    }

    const olderMessages = turns.slice(0, splitTurnIndex).flatMap(t => t.messages);
    const recentMessages = turns.slice(splitTurnIndex).flatMap(t => t.messages);

    // 3. Convert older messages to plain text for summarization.
    // Models hallucinate tool calls when they see tool_calls/tool messages in history,
    // even without tool definitions. Flatten everything to user/assistant text.
    const flattenedMessages: Message[] = [];
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
    const mergedMessages: Message[] = [];
    for (const msg of flattenedMessages) {
      const last = mergedMessages[mergedMessages.length - 1];
      if (last && last.role === msg.role && typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n' + msg.content;
      } else {
        mergedMessages.push({ ...msg });
      }
    }

    // Extract previous compaction summary for iterative awareness
    let previousSummary: string | undefined;
    for (const msg of olderMessages) {
      if (msg.role === 'assistant' && msg.metadata?.isCompactSummary) {
        previousSummary = typeof msg.content === 'string'
          ? msg.content.replace(/^Here is a summary of the conversation so far:\n\n/, '')
          : undefined;
      }
    }

    // Build the compaction request messages
    const compactionMessages: Message[] = [
      ...systemMessages,
      ...mergedMessages,
      { role: 'user', content: this.config.buildCompactionPrompt(previousSummary) },
    ];

    const summaryMaxTokens = Math.min(
      16384,
      Math.max(256, Math.round(this.config.contextLength * this.config.summaryTokenRatio))
    );

    // Call provider for summarization (silent — no progress events in main chat)
    const result = await provider.call({
      messages: compactionMessages,
      maxTokens: summaryMaxTokens,
      signal: opts?.signal,
      silent: true,
    });

    const summary = result.content || '';
    if (!summary) {
      return undefined;
    }

    // 4. Rebuild conversation:
    //    [fresh system prompt] + [project context as user msg] + [summary as assistant] + [recent messages]
    let freshFromConfig: { systemPrompt?: string; projectContext?: string } = {};
    if ((!opts?.freshSystemPrompt || !opts?.projectContext) && this.config.getFreshContext) {
      try {
        freshFromConfig = await this.config.getFreshContext();
      } catch { /* fall back to stale system prompt */ }
    }
    const freshSystemPrompt = opts?.freshSystemPrompt
      || freshFromConfig.systemPrompt
      || (systemMessages[0] && typeof systemMessages[0].content === 'string' ? systemMessages[0].content : '');
    const summaryContent = `Here is a summary of the conversation so far:\n\n${summary}`;

    const projectContext = opts?.projectContext ?? freshFromConfig.projectContext;
    const contextUserContent = projectContext
      ? `${projectContext}\n\nThe earlier conversation was compacted into the summary below.`
      : 'The earlier conversation was compacted into the summary below.';

    const conversation: Message[] = [
      { role: 'system', content: freshSystemPrompt },
      { role: 'user', content: contextUserContent },
      { role: 'assistant', content: summaryContent, metadata: { isCompactSummary: true } },
      ...recentMessages,
    ];
    // The screenshot stays out of the stored conversation, as `addImages` keeps it out.
    this.messages = newestScreenshot ? [...conversation, newestScreenshot] : conversation;

    this.compactionCount++;
    this.onMessagesReplaced?.(conversation);

    return result.usage;
  }

  /**
   * Repair orphan tool calls in a message array.
   *
   * Two common issues fixed:
   *  (1) tool_calls with empty arguments — provider sent a malformed call.
   *      Drop the offending entry. If the message ends up empty, drop it.
   *  (2) tool_calls with no matching tool result — call was cancelled mid-flight.
   *      Synthesize a role:'tool' placeholder so the sequence is well-formed.
   *
   * Operates on a copy; never mutates the persistent conversation history.
   */
  private repairOrphanToolCalls(messages: Message[]): Message[] {
    const out: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role !== 'assistant' || !msg.tool_calls || msg.tool_calls.length === 0) {
        out.push(msg);
        continue;
      }

      // Filter out tool calls with empty arguments and repair invalid JSON args
      const validCalls = msg.tool_calls.filter(tc => {
        const args = tc.function?.arguments;
        if (typeof args !== 'string' || args.trim() === '') return false;
        try {
          JSON.parse(args);
        } catch {
          // Truncated/malformed args — replace with empty object so the
          // conversation history stays valid JSON for every provider.
          tc.function.arguments = '{}';
        }
        return true;
      });

      const contentEmpty = typeof msg.content === 'string'
        ? msg.content.trim() === ''
        : !msg.content || (Array.isArray(msg.content) && msg.content.length === 0);

      if (validCalls.length === 0) {
        // No valid tool calls remain
        if (contentEmpty) {
          // Drop the entire message
          continue;
        }
        // Keep message without tool_calls
        const { tool_calls: _, ...rest } = msg;
        out.push(rest);
        continue;
      }

      // Push assistant with only valid calls
      out.push({ ...msg, tool_calls: validCalls });

      // Check which tool calls have matching results in subsequent messages
      const matchedIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === 'assistant') break;
        if (next.role === 'tool' && next.tool_call_id) {
          matchedIds.add(next.tool_call_id);
        }
      }

      // Inject synthetic results for unmatched calls
      for (const tc of validCalls) {
        if (!matchedIds.has(tc.id)) {
          out.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'No result — call was cancelled or aborted before completion.',
          });
        }
      }
    }

    return out;
  }

  /**
   * Estimate token count of a message (content + tool call arguments).
   * Uses char/3.5 heuristic: fast and reasonable for context budgeting. An image is counted as
   * IMAGE_TOKENS and an audio clip as AUDIO_TOKENS rather than by their base64 data, which a
   * provider does not read as text.
   */
  static estimateMessageTokens(msg: Message): number {
    const blocks = Array.isArray(msg.content) ? msg.content : null;
    const images = blocks ? blocks.filter(block => block.type === 'image_url').length : 0;
    const clips = blocks ? blocks.filter(block => block.type === 'input_audio').length : 0;
    const contentLen = typeof msg.content === 'string'
      ? msg.content.length
      : JSON.stringify(blocks ? blocks.filter(block => block.type !== 'image_url' && block.type !== 'input_audio') : msg.content).length;
    const argsLen = msg.tool_calls?.reduce((s, tc) => s + (tc.function?.arguments?.length ?? 0), 0) ?? 0;
    return Math.round((contentLen + argsLen) / 3.5) + images * IMAGE_TOKENS + clips * AUDIO_TOKENS;
  }
}
