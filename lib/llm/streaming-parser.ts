/**
 * Streaming Parser - Handles LLM streaming response parsing
 */

import { ToolCall, UsageInfo, ReasoningDetail } from './types';
import { ProviderId } from './providers/types';
import { logger } from '../utils';
import { VirtualFile } from '@/lib/vfs';
import { resolveWireFormat } from './providers/wire-format';
import { FREE_MODELS_FALLBACK } from './suggestions/free-models';

// Re-export for consumers that import from streaming-parser
export type { ReasoningDetail };

export interface StreamResponse {
  content?: string;
  reasoning?: string;       // Accumulated reasoning/thinking content
  toolCalls?: ToolCall[];
  usage?: UsageInfo;
  wasTruncated?: boolean;   // True if response was cut off due to max_tokens
  finishReason?: string;    // The actual finish reason from the API
  /** Set when the stream was aborted early because the model called a tool
   *  whose name isn't one of the advertised tools (only 'bash' exists). */
  invalidToolName?: string;
  reasoningDetails?: ReasoningDetail[];  // Structured reasoning blocks (Gemini signatures, etc.) for multi-turn replay
  /** Midstream error surfaced via SSE chunk { choices: [], error: {...} }. */
  midstreamError?: { code?: number | string; message: string; metadata?: Record<string, unknown> };
}

export interface StreamParserOptions {
  provider: string;
  model: string;
  suppressAssistantDelta?: boolean;
  /** When true, emit stream_raw_chunk events for each SSE line (debug). */
  debugStream?: boolean;
  /** Names the model is allowed to call. If a streamed tool name can't be a
   *  prefix of any of these, the stream is cancelled early to save tokens. */
  allowedToolNames?: ReadonlySet<string>;
  onProgress?: (event: string, data?: any) => void;
}

/**
 * Parse streaming response from LLM
 * Handles Anthropic, OpenAI, and OpenRouter formats
 *
 * Progress events emit only deltas (new text), never cumulative snapshots,
 * to avoid O(N²) memory/render cost on the consumer side.
 */
export async function parseStreamingResponse(
  response: Response,
  options: StreamParserOptions
): Promise<StreamResponse> {
  const { provider, suppressAssistantDelta = false, onProgress } = options;
  const isAnthropic = resolveWireFormat(provider as ProviderId, options.model) === 'anthropic';
  let routerModelAnnounced = false;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';  // Separate buffer for reasoning/thinking tokens
  const toolCallsById: Record<string, ToolCall> = {};
  let currentToolCall: Partial<ToolCall> | null = null;
  let toolCallBuffer = '';
  let usageInfo: UsageInfo | undefined;

  // Early-abort: if the model starts calling a tool whose name can't be one of
  // the advertised tools, cancel the stream now rather than pay for the (often
  // huge) arguments it would stream next. Prefix-safe so a char-streamed name
  // like "ba…" isn't rejected before "bash" finishes.
  const allowedToolNames = options.allowedToolNames;
  let invalidToolName: string | undefined;
  function shouldAbortOnToolName(name: string | undefined | null): boolean {
    if (invalidToolName) return true;
    if (!name || !allowedToolNames || allowedToolNames.size === 0) return false;
    if (allowedToolNames.has(name)) return false;
    for (const allowed of allowedToolNames) {
      if (allowed.startsWith(name)) return false; // still streaming a valid prefix
    }
    invalidToolName = name;
    reader?.cancel().catch(() => {});
    return true;
  }
  let wasTruncated = false;
  let lastFinishReason: string | undefined;
  const reasoningDetails: ReasoningDetail[] = [];  // Structured reasoning blocks captured for multi-turn replay

  // State for extracting inline <think>...</think> blocks (MiniMax, Ollama thinking models, etc.)
  let inThinkBlock = false;
  let thinkTagBuffer = '';
  // Whether reasoning_complete was already emitted — the end-of-stream fallback
  // must close reasoning exactly once (field-based reasoning has no close marker)
  let reasoningCompleteEmitted = false;

  /**
   * Split a content piece into regular content and reasoning, handling
   * <think>...</think> tags that may span across streaming chunks.
   */
  function splitThinkTags(piece: string): { content: string; reasoning: string } {
    const text = thinkTagBuffer + piece;
    thinkTagBuffer = '';
    let contentOut = '';
    let reasoningOut = '';
    let pos = 0;

    while (pos < text.length) {
      if (!inThinkBlock) {
        const idx = text.indexOf('<think>', pos);
        if (idx === -1) {
          // Check if text ends with a partial "<think>" prefix
          for (let k = Math.min(6, text.length - pos); k >= 1; k--) {
            if ('<think>'.startsWith(text.slice(text.length - k))) {
              contentOut += text.slice(pos, text.length - k);
              thinkTagBuffer = text.slice(text.length - k);
              return { content: contentOut, reasoning: reasoningOut };
            }
          }
          contentOut += text.slice(pos);
          return { content: contentOut, reasoning: reasoningOut };
        }
        contentOut += text.slice(pos, idx);
        inThinkBlock = true;
        pos = idx + 7; // '<think>'.length
        if (pos < text.length && text[pos] === '\n') pos++;
      } else {
        const idx = text.indexOf('</think>', pos);
        if (idx === -1) {
          // Check if text ends with a partial "</think>" prefix
          for (let k = Math.min(8, text.length - pos); k >= 1; k--) {
            if ('</think>'.startsWith(text.slice(text.length - k))) {
              reasoningOut += text.slice(pos, text.length - k);
              thinkTagBuffer = text.slice(text.length - k);
              return { content: contentOut, reasoning: reasoningOut };
            }
          }
          reasoningOut += text.slice(pos);
          return { content: contentOut, reasoning: reasoningOut };
        }
        reasoningOut += text.slice(pos, idx);
        inThinkBlock = false;
        pos = idx + 8; // '</think>'.length
        while (pos < text.length && text[pos] === '\n') pos++;
      }
    }

    return { content: contentOut, reasoning: reasoningOut };
  }

  // For Anthropic: track partial JSON building and thinking blocks
  const anthropicToolBuffers: Record<string, string> = {};
  const contentBlockIndexToToolId: Record<number, string> = {};
  let anthropicThinkingBlockIndex: number | null = null;  // Track active thinking block

  // Last indexed tool call key — fallback for chunks that drop tc.index
  let lastIndexedToolKey: string | null = null;

  // Stream read timeout — if the provider hangs (no data for STREAM_READ_TIMEOUT_MS),
  // treat whatever we have as the complete response. Some providers (e.g., Qwen via
  // OpenRouter/Alibaba) hang mid-stream without sending [DONE] or finish_reason.
  const STREAM_READ_TIMEOUT_MS = 45_000;
  let streamTimedOut = false;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let midstreamError: { code?: number | string; message: string; metadata?: Record<string, unknown> } | undefined;

  try {
    while (true) {
      if (invalidToolName) break; // early-aborted on an unexpected tool name
      const readResult = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve => {
          readTimer = setTimeout(() => resolve({ done: true, value: undefined }), STREAM_READ_TIMEOUT_MS);
        })
      ]);
      if (readTimer) { clearTimeout(readTimer); readTimer = null; }
      const { done, value } = readResult;
      if (done) {
        if (!value && !lastFinishReason) {
          streamTimedOut = true;
          logger.warn('[StreamParser] Stream read timeout or premature close (no finish_reason received)');
          reader.cancel().catch(() => {});
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.length > 0 && options.debugStream) {
          onProgress?.('stream_raw_chunk', { line });
        }
        // Skip SSE comments
        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            if (currentToolCall && toolCallBuffer && currentToolCall.function && currentToolCall.id) {
              currentToolCall.function.arguments = toolCallBuffer;
              toolCallsById[currentToolCall.id] = currentToolCall as ToolCall;
            }
            break;
          }

          try {
            const json = JSON.parse(data);
            // OpenRouter's free router answers with a model of its own choosing, named on every
            // chunk; nothing else says which one is answering.
            if (!routerModelAnnounced && options.model === FREE_MODELS_FALLBACK && typeof json.model === 'string'
                && json.model && json.model !== FREE_MODELS_FALLBACK) {
              routerModelAnnounced = true;
              onProgress?.('model_resolved', { provider, model: json.model });
            }

            // Midstream error: some providers (OpenRouter → Minimax, etc.) deliver
            // upstream errors as a normal chunk with an error field instead of an HTTP
            // error, with empty choices or one finished with `finish_reason: "error"`.
            // Capture it so the orchestrator can surface it instead of bottoming out in
            // stream_timeout; OpenRouter's metadata says what kind of refusal it was.
            const finishedWithError = Array.isArray(json.choices)
              && json.choices.some((c: { finish_reason?: string } | null) => c?.finish_reason === 'error');
            if (json.error && (!json.choices || json.choices.length === 0 || finishedWithError)) {
              const err = json.error;
              const message = typeof err === 'string'
                ? err
                : (err.message || JSON.stringify(err));
              const metadata = err && typeof err === 'object' && err.metadata && typeof err.metadata === 'object' ? err.metadata : undefined;
              midstreamError = { code: err.code, message, ...(metadata ? { metadata } : {}) };
              logger.warn(`[StreamParser] Midstream error: ${message}`);
              onProgress?.('stream_error', { code: err.code, message });
              continue;
            }

            if (isAnthropic) {
              // Handle Anthropic streaming format
              // Anthropic usage: input_tokens in message_start, output_tokens in message_delta
              if (json.type === 'message_start' && json.message?.usage) {
                const u = json.message.usage;
                usageInfo = {
                  promptTokens: u.input_tokens || 0,
                  completionTokens: u.output_tokens || 0,
                  totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0),
                  cachedTokens: u.cache_read_input_tokens,
                  reasoningTokens: 0,
                  model: options.model,
                  provider
                };
              } else if (json.type === 'message_delta' && json.usage) {
                const outputTokens = json.usage.output_tokens || 0;
                if (usageInfo) {
                  usageInfo.completionTokens = outputTokens;
                  usageInfo.totalTokens = usageInfo.promptTokens + outputTokens;
                } else {
                  usageInfo = {
                    promptTokens: 0,
                    completionTokens: outputTokens,
                    totalTokens: outputTokens,
                    reasoningTokens: 0,
                    model: options.model,
                    provider
                  };
                }
              }

              // Check for Anthropic stop reasons
              if (json.type === 'message_delta' && json.delta?.stop_reason) {
                lastFinishReason = json.delta.stop_reason;
                // 'max_tokens' is Anthropic's equivalent of 'length'
                if (json.delta.stop_reason === 'max_tokens') {
                  wasTruncated = true;
                  logger.warn('[StreamParser] Response truncated due to max_tokens limit (Anthropic)');
                }
              }

              // Handle Anthropic extended thinking (thinking content blocks)
              if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
                anthropicThinkingBlockIndex = json.index;
                if (!suppressAssistantDelta) {
                  onProgress?.('reasoning_start', {});
                }
              } else if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
                const piece = json.delta.thinking as string;
                reasoning += piece;
                if (!suppressAssistantDelta) {

                  onProgress?.('reasoning_delta', { text: piece });
                }
              } else if (json.type === 'content_block_stop' && json.index === anthropicThinkingBlockIndex) {
                anthropicThinkingBlockIndex = null;
                if (!suppressAssistantDelta) {
                  onProgress?.('reasoning_complete', { reasoning });
                  reasoningCompleteEmitted = true;
                }
              } else if (json.type === 'content_block_delta' && json.delta?.text_delta?.text) {
                const piece = json.delta.text_delta.text as string;
                content += piece;

                if (!suppressAssistantDelta) onProgress?.('assistant_delta', { text: piece });
              } else if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
                const toolCall = {
                  id: json.content_block.id,
                  type: 'function' as const,
                  function: {
                    name: json.content_block.name,
                    arguments: ''
                  }
                };
                toolCallsById[json.content_block.id] = toolCall;
                anthropicToolBuffers[json.content_block.id] = '';
                contentBlockIndexToToolId[json.index] = json.content_block.id;

                // Anthropic sends the full tool name here, before any arguments.
                if (shouldAbortOnToolName(json.content_block.name)) break;

                if (!suppressAssistantDelta) {
                  onProgress?.('toolCalls', { toolCalls: [toolCall] });
                }
              } else if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
                const contentBlockIndex = json.index;
                const toolId = contentBlockIndexToToolId[contentBlockIndex];

                if (toolId && json.delta.partial_json) {
                  anthropicToolBuffers[toolId] += json.delta.partial_json;

                  if (!suppressAssistantDelta && toolCallsById[toolId]) {
                    toolCallsById[toolId].function.arguments = anthropicToolBuffers[toolId];
                    onProgress?.('tool_param_delta', {
                      toolId,
                      fragment: json.delta.partial_json
                    });
                  }
                }
              } else if (json.type === 'content_block_stop') {
                const contentBlockIndex = json.index;
                const toolId = contentBlockIndexToToolId[contentBlockIndex];

                if (toolId && anthropicToolBuffers[toolId]) {
                  try {
                    const completeJson = anthropicToolBuffers[toolId];
                    JSON.parse(completeJson); // Validate
                    toolCallsById[toolId].function.arguments = completeJson;
                  } catch (error) {
                    logger.error('Invalid JSON for tool parameters:', anthropicToolBuffers[toolId], error);
                    toolCallsById[toolId].function.arguments = '{}';
                  }
                }
              }
            } else {
              // Handle OpenAI/OpenRouter streaming format
              const delta = json.choices?.[0]?.delta;
              const finishReason = json.choices?.[0]?.finish_reason;

              // Track finish reason for truncation detection
              if (finishReason) {
                lastFinishReason = finishReason;
                // 'length' means max_tokens was hit - response was truncated
                if (finishReason === 'length') {
                  wasTruncated = true;
                  logger.warn('[StreamParser] Response truncated due to max_tokens limit');
                }
              }

              if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'length') {
                if (currentToolCall && toolCallBuffer && currentToolCall.function && currentToolCall.id) {
                  currentToolCall.function.arguments = toolCallBuffer;
                  toolCallsById[currentToolCall.id] = currentToolCall as ToolCall;
                  currentToolCall = null;
                  toolCallBuffer = '';
                }
              }

              // Handle DeepSeek/Qwen delta.reasoning (separate from content)
              // When DeepSeek is accessed via OpenRouter, both delta.reasoning AND
              // delta.reasoning_details may be present - we only want to emit once
              let handledReasoningDelta = false;
              if (delta?.reasoning && !delta?.content && !delta?.tool_calls) {
                const reasoningPiece = String(delta.reasoning);
                reasoning += reasoningPiece;
                if (!suppressAssistantDelta) {

                  onProgress?.('reasoning_delta', { text: reasoningPiece });
                }
                handledReasoningDelta = true;
              }

              // Handle Zhipu delta.reasoning_content (same pattern, different field name)
              if (delta?.reasoning_content && !delta?.content && !delta?.tool_calls) {
                const reasoningPiece = String(delta.reasoning_content);
                reasoning += reasoningPiece;
                if (!suppressAssistantDelta) {
                  onProgress?.('reasoning_delta', { text: reasoningPiece });
                }
                handledReasoningDelta = true;
              }

              if (delta?.content) {
                const piece = String(delta.content);
                // Extract inline <think>...</think> blocks into reasoning
                const { content: contentPiece, reasoning: reasoningPiece } = splitThinkTags(piece);
                if (contentPiece) {
                  content += contentPiece;
                  if (!suppressAssistantDelta) onProgress?.('assistant_delta', { text: contentPiece });
                }
                if (reasoningPiece) {
                  reasoning += reasoningPiece;
                  if (!suppressAssistantDelta) onProgress?.('reasoning_delta', { text: reasoningPiece });
                  handledReasoningDelta = true;
                }
              }

              // Capture reasoning_details for thinking models (OpenRouter normalized format).
              // These contain signatures/blobs that MUST be preserved on assistant messages
              // for multi-turn replay — DeepSeek V4 Pro returns 400 ("reasoning_content in
              // the thinking mode must be passed back to the API") on the second turn if
              // the prior assistant turn lacks them.
              //
              // IMPORTANT: Gemini sends CUMULATIVE SNAPSHOTS, not incremental deltas.
              // Each rd.text contains the FULL text so far, not just the new portion.
              //
              // Some providers (DeepSeek via OpenRouter) emit BOTH delta.reasoning AND
              // delta.reasoning_details for the same content. We always capture the
              // structured details (storage), but suppress the duplicate UI delta
              // emission when handledReasoningDelta is already true (display).
              if (delta?.reasoning_details && Array.isArray(delta.reasoning_details)) {
                for (const rd of delta.reasoning_details) {
                  // Merge or update reasoning details
                  const existingIdx = reasoningDetails.findIndex(
                    (existing) => existing.id && existing.id === rd.id
                  );
                  if (existingIdx >= 0) {
                    // Update existing - Gemini sends cumulative snapshots, not deltas
                    if (rd.text) {
                      const previousText = reasoningDetails[existingIdx].text || '';
                      // Only emit delta if text actually changed
                      if (rd.text !== previousText) {
                        // Calculate the actual delta (new text minus previous)
                        const deltaText = rd.text.startsWith(previousText)
                          ? rd.text.slice(previousText.length)
                          : rd.text; // Fallback to full text if not a clean extension

                        // Store full snapshot (replace, not append)
                        reasoningDetails[existingIdx].text = rd.text;

                        // Emit delta event with just the new portion — but only if we
                        // didn't already emit via delta.reasoning above.
                        if (deltaText && !suppressAssistantDelta && !handledReasoningDelta) {
                          onProgress?.('reasoning_delta', { text: deltaText });
                        }
                      }
                    }
                    if (rd.signature) {
                      reasoningDetails[existingIdx].signature = rd.signature;
                    }
                  } else if (!rd.id && rd.text && !rd.signature && reasoningDetails.length > 0) {
                    // No id, text-only, and we already have entries — this is an
                    // incremental streaming chunk. Merge into the last entry of the
                    // same type to avoid creating one array element per token.
                    const last = reasoningDetails[reasoningDetails.length - 1];
                    if (last.type === rd.type && !last.signature && !last.id) {
                      last.text = (last.text || '') + rd.text;
                    } else {
                      reasoningDetails.push(rd as ReasoningDetail);
                    }
                    if (rd.text && !suppressAssistantDelta && !handledReasoningDelta) {
                      onProgress?.('reasoning_delta', { text: rd.text });
                    }
                  } else {
                    reasoningDetails.push(rd as ReasoningDetail);
                    if (rd.text && !suppressAssistantDelta && !handledReasoningDelta) {
                      onProgress?.('reasoning_delta', { text: rd.text });
                    }
                  }
                }
                // Update reasoning buffer from the latest cumulative text only when
                // we own the reasoning stream. When delta.reasoning is the source of
                // truth (DeepSeek), it already populated `reasoning` incrementally and
                // we shouldn't overwrite it with the structured details (which may not
                // contain the same text content for all providers).
                if (!handledReasoningDelta) {
                  const latestText = reasoningDetails
                    .filter(rd => rd.text)
                    .map(rd => rd.text)
                    .join('');
                  if (latestText) {
                    reasoning = latestText; // Replace, don't append
                  }
                }
              }

              if (delta?.tool_calls) {
                // Auto-close any open <think> block when tool calls arrive
                // (MiniMax sometimes omits </think> before making tool calls)
                if (inThinkBlock) {
                  if (thinkTagBuffer) {
                    reasoning += thinkTagBuffer;
                    if (!suppressAssistantDelta) onProgress?.('reasoning_delta', { text: thinkTagBuffer });
                    thinkTagBuffer = '';
                  }
                  inThinkBlock = false;
                  if (!suppressAssistantDelta) {
                    onProgress?.('reasoning_complete', { reasoning });
                    reasoningCompleteEmitted = true;
                  }
                }

                for (const tc of delta.tool_calls) {
                  if (tc.index !== undefined) {
                    const key = `idx_${tc.index}`;
                    lastIndexedToolKey = key;
                    const isNewTool = !toolCallsById[key];

                    if (isNewTool) {
                      toolCallsById[key] = {
                        id: tc.id || `tool_${tc.index}`,
                        type: 'function' as const,
                        function: { name: '', arguments: '' }
                      };
                    }

                    if (tc.function?.name) {
                      toolCallsById[key].function.name = tc.function.name;

                      if (shouldAbortOnToolName(toolCallsById[key].function.name)) break;

                      if (isNewTool && !suppressAssistantDelta) {
                        onProgress?.('toolCalls', { toolCalls: [toolCallsById[key]] });
                      }
                    }

                    if (tc.function?.arguments) {
                      const argFragment = tc.function.arguments;
                      toolCallsById[key].function.arguments += argFragment;

                      if (!suppressAssistantDelta) {
                        onProgress?.('tool_param_delta', {
                          toolId: toolCallsById[key].id,
                          fragment: argFragment
                        });
                      }
                    }
                  } else if (tc.id) {
                    if (currentToolCall && toolCallBuffer && currentToolCall.function && currentToolCall.id) {
                      currentToolCall.function.arguments = toolCallBuffer;
                      toolCallsById[currentToolCall.id] = currentToolCall as ToolCall;
                    }
                    currentToolCall = {
                      id: tc.id,
                      type: 'function' as const,
                      function: {
                        name: tc.function?.name || '',
                        arguments: ''
                      }
                    };
                    toolCallBuffer = tc.function?.arguments || '';

                    if (shouldAbortOnToolName(currentToolCall.function?.name)) break;

                    if (!suppressAssistantDelta && currentToolCall.function?.name) {
                      onProgress?.('toolCalls', { toolCalls: [currentToolCall as ToolCall] });
                    }
                  } else if (tc.function?.arguments) {
                    const argFragment = tc.function.arguments;

                    // Fallback: if an indexed tool call was created (PATH A) but
                    // subsequent chunks dropped tc.index, route arguments directly
                    // into the indexed entry instead of the orphaned toolCallBuffer.
                    if (!currentToolCall && lastIndexedToolKey && toolCallsById[lastIndexedToolKey]) {
                      const indexed = toolCallsById[lastIndexedToolKey];
                      indexed.function.arguments += argFragment;

                      if (!suppressAssistantDelta) {
                        onProgress?.('tool_param_delta', {
                          toolId: indexed.id,
                          fragment: argFragment
                        });
                      }
                    } else {
                      toolCallBuffer += argFragment;

                      if (!suppressAssistantDelta && currentToolCall) {
                        onProgress?.('tool_param_delta', {
                          toolId: currentToolCall.id,
                          fragment: argFragment
                        });
                      }
                    }
                  }

                  if (tc.function?.name && currentToolCall && currentToolCall.function) {
                    currentToolCall.function.name = tc.function.name;
                  }
                }
              }
            }

            // Parse usage info (OpenAI-compatible format; Anthropic handled above)
            if (json.usage && !isAnthropic) {
              const reportedCost = typeof json.usage.cost === 'number' && json.usage.cost > 0
                ? json.usage.cost : undefined;
              usageInfo = {
                promptTokens: json.usage.prompt_tokens || 0,
                completionTokens: json.usage.completion_tokens || 0,
                totalTokens: json.usage.total_tokens || 0,
                cachedTokens: json.usage.cached_tokens ?? json.usage.prompt_tokens_details?.cached_tokens,
                reasoningTokens: json.usage.reasoning_tokens || json.usage.completion_tokens_details?.reasoning_tokens || 0,
                cost: reportedCost,
                isEstimated: reportedCost === undefined,
                model: options.model,
                provider
              };
            }

            if (json.x_groq?.usage) {
              usageInfo = {
                promptTokens: json.x_groq.usage.prompt_tokens || 0,
                completionTokens: json.x_groq.usage.completion_tokens || 0,
                totalTokens: json.x_groq.usage.total_tokens || 0,
                reasoningTokens: json.x_groq.usage.reasoning_tokens || 0,
                model: options.model,
                provider
              };
            }
          } catch (error) {
            if (data && data.length > 10 && !data.includes('[DONE]')) {
              logger.warn('[StreamParser] Parse error:', error, 'Data:', data.substring(0, 200));
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error reading stream:', error);
    if (currentToolCall && toolCallBuffer && currentToolCall.function && currentToolCall.id) {
      currentToolCall.function.arguments = toolCallBuffer;
      toolCallsById[currentToolCall.id] = currentToolCall as ToolCall;
    }
  }

  // Flush any remaining thinkTagBuffer (partial tag that never completed)
  if (thinkTagBuffer) {
    if (inThinkBlock) {
      reasoning += thinkTagBuffer;
    } else {
      content += thinkTagBuffer;
    }
    thinkTagBuffer = '';
  }

  // Close reasoning at end of stream. Field-based reasoning (delta.reasoning /
  // reasoning_details — Qwen, DeepSeek via OpenRouter) has no close marker, so
  // without this a reasoning-final stream leaves the UI reasoning block open.
  if (reasoning && !reasoningCompleteEmitted && !suppressAssistantDelta) {
    onProgress?.('reasoning_complete', { reasoning });
  }

  // Mark as truncated if the stream timed out with pending tool calls
  if (streamTimedOut) {
    if (Object.keys(toolCallsById).length > 0) {
      wasTruncated = true;
    }
    onProgress?.('stream_timeout', {});
  }

  // Ensure reasoning text is preserved in reasoningDetails for multi-turn replay.
  // If delta.reasoning populated the reasoning buffer but reasoningDetails has no
  // text entries (e.g., DeepSeek without structured details, or Anthropic thinking),
  // create a synthetic entry so the next turn can pass it back via reasoning_content.
  if (reasoning) {
    const hasTextEntry = reasoningDetails.some(rd => rd.text && rd.text.length > 0);
    if (!hasTextEntry) {
      reasoningDetails.unshift({ type: 'thinking', text: reasoning });
    }
  }

  // Pass tool calls as-is - let tool-registry handle JSON repair with smart strategies
  const toolCallsArray = Object.values(toolCallsById);

  return {
    content,
    reasoning: reasoning || undefined,
    toolCalls: toolCallsArray,
    usage: usageInfo,
    wasTruncated,
    finishReason: lastFinishReason,
    reasoningDetails: reasoningDetails.length > 0 ? reasoningDetails : undefined,
    midstreamError,
    invalidToolName,
  };
}

/**
 * Build a tree structure from files with sizes
 */
export function buildFileTree(files: VirtualFile[]): string {
  if (files.length === 0) return '';

  const tree = new Map<string, {
    isDirectory: boolean;
    size?: number;
    children: Set<string>;
  }>();

  // Add all directories and files to the tree
  for (const file of files) {
    const pathParts = file.path.split('/').filter(Boolean);

    // Add intermediate directories and link each to its parent — VFS listings
    // contain no directory entries, so without this linking, subdirectory
    // contents are unreachable from the root and vanish from the tree.
    for (let i = 0; i < pathParts.length - 1; i++) {
      const dirPath = '/' + pathParts.slice(0, i + 1).join('/');
      if (!tree.has(dirPath)) {
        tree.set(dirPath, { isDirectory: true, children: new Set() });
      }
      const dirParent = i === 0 ? '/' : '/' + pathParts.slice(0, i).join('/');
      if (!tree.has(dirParent)) {
        tree.set(dirParent, { isDirectory: true, children: new Set() });
      }
      tree.get(dirParent)!.children.add(dirPath);
    }

    // Add file
    tree.set(file.path, {
      isDirectory: false,
      size: file.size,
      children: new Set()
    });

    // Link child to parent
    const parentPath = '/' + pathParts.slice(0, -1).join('/');
    if (parentPath !== '/' && tree.has(parentPath)) {
      tree.get(parentPath)!.children.add(file.path);
    } else if (parentPath === '/') {
      if (!tree.has('/')) {
        tree.set('/', { isDirectory: true, children: new Set() });
      }
      tree.get('/')!.children.add(file.path);
    }
  }

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = (bytes / Math.pow(k, i));
    const formatted = i === 0 ? size.toString() : size.toFixed(1);
    return formatted + sizes[i];
  };

  // Build tree string recursively
  const buildTreeString = (path: string, prefix: string = '', isLast: boolean = true): string[] => {
    const entry = tree.get(path);
    if (!entry) return [];

    const lines: string[] = [];
    const name = path === '/' ? '' : path.split('/').pop() || '';

    if (path !== '/') {
      const connector = isLast ? '└── ' : '├── ';
      const displayName = entry.isDirectory ? name + '/' : name;
      const sizeInfo = entry.isDirectory ? '' : ` (${formatSize(entry.size || 0)})`;
      lines.push(prefix + connector + displayName + sizeInfo);
    }

    // Sort children: directories first, then files, alphabetically
    const children = Array.from(entry.children).sort((a, b) => {
      const aEntry = tree.get(a);
      const bEntry = tree.get(b);
      if (aEntry?.isDirectory !== bEntry?.isDirectory) {
        return aEntry?.isDirectory ? -1 : 1;
      }
      return a.localeCompare(b);
    });

    children.forEach((childPath, index) => {
      const isLastChild = index === children.length - 1;
      const childPrefix = path === '/' ? '' : prefix + (isLast ? '    ' : '│   ');
      lines.push(...buildTreeString(childPath, childPrefix, isLastChild));
    });

    return lines;
  };

  const treeLines = buildTreeString('/');
  return treeLines.length > 0 ? 'Project Structure:\n' + treeLines.join('\n') : '';
}
