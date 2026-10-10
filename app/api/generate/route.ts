import { NextRequest, NextResponse } from 'next/server';
import { classifyProviderError, classifyGeminiError, providerMessageForDisplay, type ProviderErrorClass } from '@/lib/llm/provider-errors';
import { isFreeModels, FREE_MODELS_FALLBACK } from '@/lib/llm/suggestions/free-models';
import { supportedCommandList } from '@/lib/vfs/shell-commands';
import { ProviderId } from '@/lib/llm/providers/types';
import { getProvider, getDefaultModel } from '@/lib/llm/providers/registry';
import { getApiEndpoint, buildHeaders, resolveTemperature } from '@/lib/llm/request-builder';
import { assertPublicHttpUrl } from '@/lib/llm/providers/url-safety';
import { resolveWireFormat, WireFormat } from '@/lib/llm/providers/wire-format';
import { LLMMessage, ToolDefinition, ContentBlock, TextContentBlock, ImageContentBlock } from '@/lib/llm/types';
import { applyReasoningReplayPolicy } from '@/lib/llm/reasoning-replay';
import { consolidateSystemMessages } from '@/lib/llm/consolidate-system-messages';
import { logger } from '@/lib/utils';
import { handleCodexGeneration } from '@/lib/llm/codex-adapter';
import { buildGeminiRequestBody, createGeminiToCompletionsTransformer, geminiToCompletionsResponse } from '@/lib/llm/gemini-adapter';
import { buildOllamaChatBody, createOllamaToCompletionsTransformer, messagesToOllama, ollamaToCompletionsResponse, ollamaOrigin, resolveOllamaNumCtx } from '@/lib/llm/ollama-adapter';

// Helper to extract text content from string or ContentBlock[]
function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextContentBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// Parse data URL to extract media type and base64 data
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid data URL format');
  }
  return { mediaType: match[1], data: match[2] };
}

// Transform content blocks for Anthropic (requires specific image format)
function toAnthropicContent(content: string | ContentBlock[]): any {
  if (typeof content === 'string') return content;
  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'input_audio') return block;
    const { mediaType, data } = parseDataUrl(block.image_url.url);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data
      }
    };
  });
}

// Ollama reports a model's trained context length via /api/show; the value picks the
// num_ctx the model is loaded with. Cached per process: the answer never changes for a
// given model tag, and the lookup would otherwise run on every turn.
const ollamaContextCache = new Map<string, number | undefined>();
async function ollamaModelContextLength(origin: string, model: string): Promise<number | undefined> {
  const key = `${origin}|${model}`;
  if (ollamaContextCache.has(key)) return ollamaContextCache.get(key);
  let length: number | undefined;
  try {
    const res = await fetch(`${origin}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (res.ok) {
      const info = (await res.json())?.model_info ?? {};
      const entry = Object.entries(info).find(([k]) => k.endsWith('.context_length'));
      if (entry && typeof entry[1] === 'number') length = entry[1];
    }
  } catch {
    // Unreachable or unknown model: the chat request that follows reports it properly.
  }
  ollamaContextCache.set(key, length);
  return length;
}

// Extract images from messages for Ollama (images field at request level)
function extractOllamaImages(messages: LLMMessage[]): { processedMessages: LLMMessage[]; images: string[] } {
  const images: string[] = [];
  const processedMessages = messages.map(m => {
    if (typeof m.content === 'string') return m;

    const textBlocks = m.content.filter((b): b is TextContentBlock => b.type === 'text');
    const imageBlocks = m.content.filter((b): b is ImageContentBlock => b.type === 'image_url');

    // Extract base64 data (without data URL prefix) for each image
    for (const img of imageBlocks) {
      try {
        const { data } = parseDataUrl(img.image_url.url);
        images.push(data);
      } catch {
        logger.warn('[API] Failed to parse image data URL for Ollama');
      }
    }

    return {
      ...m,
      content: textBlocks.map(b => b.text).join('\n')
    };
  });

  return { processedMessages, images };
}

export async function POST(request: NextRequest) {
  // Set once the provider is known, for the network-error message in the catch below.
  let localTarget: { name: string; url: string; hint: string } | undefined;
  try {
    const { prompt, apiKey: clientApiKey, model: requestedModel, tools, context, messages, tool_choice, provider, max_tokens, reasoning, stream: requestStream, baseUrl: requestBaseUrl, customHeaders: requestCustomHeaders, context_length: requestContextLength } = await request.json();
    // "Free models" is resolved by the client; one that arrives unresolved goes to OpenRouter's
    // own free router rather than to an id no provider knows.
    const model = isFreeModels(requestedModel) ? FREE_MODELS_FALLBACK : requestedModel;

    const selectedProvider: ProviderId = provider || 'openrouter';
    const providerConfig = getProvider(selectedProvider);
    const wireFormat = resolveWireFormat(selectedProvider, model || '');

    const apiKey = clientApiKey;

    const customBaseUrl = requestBaseUrl;

    // Custom endpoints are external-only: reject loopback/private/non-http URLs. Built-in
    // local providers (Ollama/LM Studio/llama.cpp) legitimately point at localhost and are
    // exempt. On hosted instances, network egress filtering blocks DNS-rebinding past this.
    if (customBaseUrl && !providerConfig.isLocal) assertPublicHttpUrl(customBaseUrl);
    if (providerConfig.isLocal) {
      localTarget = {
        name: providerConfig.name,
        url: customBaseUrl || providerConfig.baseUrl || '',
        hint: selectedProvider === 'ollama' ? ' (start it with "ollama serve")' : '',
      };
    }

    if (!prompt && !messages) {
      return NextResponse.json(
        { error: 'Either prompt or messages is required' },
        { status: 400 }
      );
    }

    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      return NextResponse.json(
        { error: `${providerConfig.name} API key is required. Please set it in settings.` },
        { status: 400 }
      );
    }

    let systemPrompt = `You operate in a sandboxed virtual terminal.

Guidelines:
- Create semantic, accessible HTML5; modern CSS3; clean JS (ES6+).
- Use relative paths; keep structure simple; prefer early returns.

Capabilities:
- One tool: bash({ command: string }) for commands and file editing.
- Edit files with bash: cat > /file << 'EOF' for full rewrites, sed -i 's/old/new/g' for substitutions.
- Supported commands: ${supportedCommandList()}.
- Supports pipes (|), redirects (> >>), and && chaining.
- Only /workspace paths exist; reach the network with curl.
  • Note: both '/path' and '/workspace/path' are accepted; '/workspace' is normalized to '/'.

Habits:
- Read with ls/cat/grep/find before editing.
- Persist file content changes with cat > or sed -i; use mv/rm/mkdir/cp for structure.
- Keep changes small and atomic.`;

    if (context?.fileTree) {
      systemPrompt += `\n\nCurrent project structure:\n${context.fileTree}`;
    }

    if (context?.existingFiles && Array.isArray(context.existingFiles)) {
      systemPrompt += `\n\nExisting files (modify via cat > or sed -i; use mv/rm for structure):\n${context.existingFiles.join('\n')}`;
    }

    if (context?.mainFiles && Object.keys(context.mainFiles).length > 0) {
      systemPrompt += `\n\nCurrent file contents (use exact text when crafting write operations):`;
      for (const [path, content] of Object.entries(context.mainFiles)) {
        const contentStr = String(content);
        const truncatedContent = contentStr.length > 1000 ? contentStr.substring(0, 1000) + '\n... (truncated)' : contentStr;
        systemPrompt += `\n\n=== ${path} ===\n${truncatedContent}`;
      }
    }

    if (context?.instructions) {
      systemPrompt += `\n\nAdditional instructions:\n${context.instructions}`;
    }

    const chatMessages = messages || [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];
    
    // Only agent requests get the agent system prompt. Single-shot utility calls (transcription,
    // skill evaluation) send no tools and carry their own instructions in the user message.
    if (messages && tools?.length && !messages.some((m: LLMMessage) => m.role === 'system')) {
      chatMessages.unshift({ role: 'system', content: systemPrompt });
    }

    // --- Codex provider: delegate entirely to codex-adapter ---
    if (selectedProvider === 'openai-codex') {
      // Validate tools before passing to Codex
      const validTools = tools?.filter((tool: { name?: string; description?: string; parameters?: unknown }) => {
        if (!tool.name || tool.name.trim() === '') return false;
        return true;
      });

      return handleCodexGeneration({
        messages: chatMessages,
        model: model || getDefaultModel('openai-codex'),
        tools: validTools?.length > 0 ? validTools : undefined,
        accessToken: apiKey,
        signal: request.signal,
      });
    }

    const headers = buildHeaders(selectedProvider, apiKey, providerConfig, wireFormat, requestCustomHeaders);
    
    let processedMessages = chatMessages;
    let anthropicSystemPrompt = '';
    
    if (wireFormat === 'anthropic') {
      const systemMessage = chatMessages.find((msg: LLMMessage) => msg.role === 'system');
      if (systemMessage) {
        anthropicSystemPrompt = getTextContent(systemMessage.content);
      }
      
      processedMessages = [];
      let currentUserMessage: any = null;
      
      for (const msg of chatMessages) {
        if (msg.role === 'system') {
          continue;
        } else if (msg.role === 'tool') {
          if (currentUserMessage && currentUserMessage.role === 'user') {
            if (!Array.isArray(currentUserMessage.content)) {
              currentUserMessage = {
                ...currentUserMessage,
                content: [{ type: 'text', text: currentUserMessage.content }]
              };
            }
            currentUserMessage.content.push({
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content
            });
          } else {
            currentUserMessage = {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content
              }]
            };
          }
        } else {
          if (currentUserMessage && currentUserMessage.role === 'user') {
            processedMessages.push(currentUserMessage);
          }
          
          if (msg.role === 'assistant' && msg.tool_calls) {
            const content = [];
            if (msg.content) {
              content.push({ type: 'text', text: msg.content });
            }
            for (const toolCall of msg.tool_calls) {
              let input = {};
              try { input = JSON.parse(toolCall.function.arguments || '{}'); } catch { /* malformed args from truncated stream */ }
              content.push({
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.function.name,
                input,
              });
            }

            currentUserMessage = {
              role: 'assistant',
              content: content
            };
          } else {
            // Ensure non-empty content for Anthropic
            const messageContent = msg.content || '';
            if (!messageContent && msg.role === 'assistant') {
              // Skip empty assistant messages (Anthropic rejects them)
              currentUserMessage = null;
            } else if (msg.role === 'user' && typeof msg.content !== 'string') {
              // Handle multimodal user messages - transform to Anthropic format
              currentUserMessage = {
                ...msg,
                content: toAnthropicContent(msg.content)
              };
            } else {
              currentUserMessage = { ...msg };
            }
          }
          
          if (msg.role !== 'user' && currentUserMessage) {
            processedMessages.push(currentUserMessage);
            currentUserMessage = null;
          }
        }
      }
      
      if (currentUserMessage && currentUserMessage.role === 'user') {
        processedMessages.push(currentUserMessage);
      }
    }

    // Handle Ollama images - extract to request level
    let ollamaImages: string[] = [];
    if (selectedProvider === 'ollama') {
      const { processedMessages: ollamaMessages, images } = extractOllamaImages(processedMessages);
      processedMessages = ollamaMessages;
      ollamaImages = images;
    }

    const streamEnabled = requestStream !== false;
    let apiEndpoint = getApiEndpoint(selectedProvider, providerConfig, model, { apiKey, stream: streamEnabled }, customBaseUrl, wireFormat);

    // --- Gemini: build entirely different request body ---
    if (selectedProvider === 'gemini') {
      // Validate tools if present
      let validTools: any[] = [];
      if (tools && tools.length > 0) {
        validTools = tools.filter((tool: { name?: string }) => tool.name && tool.name.trim() !== '');
        if (validTools.length === 0) {
          return NextResponse.json(
            { error: 'All tools are invalid. Tools must have a name field.' },
            { status: 400 }
          );
        }
      }

      const geminiBody = buildGeminiRequestBody(processedMessages, {
        model: model || '',
        maxTokens: max_tokens,
        temperature: 0.7,
        tools: validTools.length > 0 ? validTools : undefined,
      });

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(geminiBody),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let cleanError: string;
        let geminiClass: ProviderErrorClass = {};
        try {
          const parsed = JSON.parse(errorText);
          cleanError = parsed.error?.message || `HTTP ${response.status}`;
          geminiClass = classifyGeminiError(response.status, parsed.error?.details);
        } catch {
          cleanError = `HTTP ${response.status} — ${response.statusText || 'check your API key and try again'}`;
        }
        if (!geminiClass.code) geminiClass = classifyProviderError({ status: response.status, provider: 'gemini', message: cleanError, headers: response.headers });
        return NextResponse.json(
          { ...geminiClass, error: `Google Gemini API error: ${cleanError}` },
          { status: response.status }
        );
      }

      if (!streamEnabled) {
        return NextResponse.json(geminiToCompletionsResponse(await response.json()));
      }

      return new Response(response.body?.pipeThrough(createGeminiToCompletionsTransformer()), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // Apply the per-model reasoning replay policy: DeepSeek/GLM/MiniMax get prior
    // reasoning back as reasoning_content (their APIs require it); other models
    // (e.g. Qwen — whose template forbids replayed thinking) get reasoning-only
    // turns promoted to plain assistant content instead. See lib/llm/reasoning-replay.ts.
    if (wireFormat !== 'anthropic') {
      applyReasoningReplayPolicy(processedMessages, model || '');
    }

    // Sanitize tool_calls: replace invalid JSON arguments with '{}' so providers
    // don't reject the request. Truncated streaming can leave malformed args in history.
    for (const msg of processedMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try { JSON.parse(tc.function.arguments); } catch {
              tc.function.arguments = '{}';
            }
          }
        }
      }
    }

    // Consolidate system messages: some providers (e.g. Ambient on OpenRouter) reject
    // system messages at any position other than [0].
    processedMessages = consolidateSystemMessages(processedMessages);

    // --- All other providers: OpenAI-compatible request body ---
    const requestBody: Record<string, unknown> = {
      model: model || getDefaultModel(selectedProvider),
      messages: processedMessages,
      stream: streamEnabled
    };

    // Request usage stats in streaming responses (needed for compaction threshold).
    // Most OpenAI-compatible providers support this; skip for local servers that may reject it.
    if (streamEnabled && selectedProvider !== 'ollama' && selectedProvider !== 'lmstudio' && wireFormat !== 'anthropic') {
      requestBody.stream_options = { include_usage: true };
    }

    // Add images for Ollama at request level
    if (selectedProvider === 'ollama' && ollamaImages.length > 0) {
      requestBody.images = ollamaImages;
    }

    if (wireFormat === 'anthropic' && anthropicSystemPrompt) {
      requestBody.system = anthropicSystemPrompt;
    }

    if (tools && tools.length > 0) {
      // Validate tools to ensure all required fields are present
      const validTools = tools.filter((tool: { name?: string; description?: string; parameters?: unknown }) => {
        if (!tool.name || tool.name.trim() === '') {
          logger.error('[API] Tool missing required "name" field:', tool);
          return false;
        }
        if (!tool.description) {
          logger.warn('[API] Tool missing "description" field:', tool.name);
        }
        if (!tool.parameters) {
          logger.warn('[API] Tool missing "parameters" field:', tool.name);
        }
        return true;
      });

      if (validTools.length === 0) {
        return NextResponse.json(
          { error: 'All tools are invalid. Tools must have a name field.' },
          { status: 400 }
        );
      }

      if (wireFormat === 'anthropic') {
        requestBody.tools = validTools.map((tool: { name: string; description: string; parameters: unknown }) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        }));
        if (tool_choice && typeof tool_choice === 'object') {
          requestBody.tool_choice = tool_choice;
        } else if (tool_choice === 'auto' || !tool_choice) {
          requestBody.tool_choice = { type: 'auto' };
        } else if (tool_choice === 'any') {
          requestBody.tool_choice = { type: 'any' };
        } else if (typeof tool_choice === 'string') {
          requestBody.tool_choice = { type: 'tool', name: tool_choice };
        } else {
          requestBody.tool_choice = { type: 'auto' };
        }
      } else {
        requestBody.tools = validTools.map((tool: { name: string; description: string; parameters: unknown }) => ({
          type: 'function',
          function: tool
        }));
        requestBody.tool_choice = tool_choice || 'auto';
      }
    }

    if (selectedProvider === 'openai') {
      requestBody.max_completion_tokens = max_tokens || 4096;
    } else {
      requestBody.max_tokens = max_tokens || 4096;
    }
    requestBody.temperature = resolveTemperature(selectedProvider, model || '');

    // Enable reasoning for models that support it
    const modelName = model || '';

    // Handle client-requested reasoning (for models that support toggleable reasoning)
    if (reasoning && selectedProvider === 'openrouter') {
      requestBody.reasoning = reasoning;
    }
    if (reasoning && selectedProvider === 'zhipu') {
      requestBody.thinking = { type: 'enabled' };
    }

    // DeepSeek V3.2+ models - some providers (e.g., AtlasCloud) may have issues with tool calling
    // Route to DeepSeek's native API for better reliability
    const isDeepSeekV3_2 = modelName.includes('deepseek') && modelName.includes('v3.2');
    if (selectedProvider === 'openrouter' && isDeepSeekV3_2) {
      // Use provider routing to prefer DeepSeek's native endpoint
      requestBody.provider = {
        order: ['DeepSeek'],  // Provider name from endpoints API
        allow_fallbacks: true
      };
    }

    let outgoingBody: Record<string, unknown> = requestBody;
    if (selectedProvider === 'ollama') {
      const origin = ollamaOrigin(customBaseUrl || providerConfig.baseUrl || 'http://127.0.0.1:11434');
      apiEndpoint = `${origin}/api/chat`;
      outgoingBody = buildOllamaChatBody(processedMessages, {
        model: String(requestBody.model),
        stream: streamEnabled,
        numCtx: resolveOllamaNumCtx(
          await ollamaModelContextLength(origin, String(requestBody.model)),
          typeof requestContextLength === 'number' ? requestContextLength : undefined,
        ),
        maxTokens: requestBody.max_tokens as number,
        temperature: requestBody.temperature as number,
        tools: Array.isArray(requestBody.tools)
          ? (requestBody.tools as Array<{ function: ToolDefinition }>).map(t => t.function)
          : undefined,
      });
    }

    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(outgoingBody),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Try to parse and extract clean error message from JSON response
      let cleanError = errorText;
      let errorMetadata: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.error?.metadata && typeof parsed.error.metadata === 'object') errorMetadata = parsed.error.metadata;
        // OpenRouter nested error structure: { error: { message: "...", metadata: { raw: "..." } } }
        if (parsed.error?.message) {
          cleanError = parsed.error.message;
          // Check for more detailed error in metadata.raw (OpenRouter provider errors)
          if (parsed.error.metadata?.raw) {
            try {
              const rawError = JSON.parse(parsed.error.metadata.raw);
              if (rawError.error?.message) {
                cleanError = `${parsed.error.message}: ${rawError.error.message}`;
              }
            } catch {
              // raw isn't JSON, append as-is if it adds info
              if (parsed.error.metadata.raw !== parsed.error.message) {
                cleanError = `${parsed.error.message} (${parsed.error.metadata.raw})`;
              }
            }
          }
          // Also check for provider_name in metadata
          if (parsed.error.metadata?.provider_name) {
            cleanError = `[${parsed.error.metadata.provider_name}] ${cleanError}`;
          }
        } else if (typeof parsed.error === 'string') {
          cleanError = parsed.error;
        }
        // Log full error for debugging
        logger.error('[API] Provider error details:', JSON.stringify(parsed, null, 2));
      } catch {
        // Not JSON — check if it's HTML (provider returned a web page instead of API error)
        if (errorText.trimStart().startsWith('<!') || errorText.trimStart().startsWith('<html')) {
          cleanError = `HTTP ${response.status} — ${response.statusText || 'check your API key and try again'}`;
        }
        logger.error('[API] Provider error (raw):', errorText.slice(0, 500));
      }

      const rateLimitHeaders: Record<string, string> = {};
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');

        if (retryAfter) rateLimitHeaders['Retry-After'] = retryAfter;
        if (rateLimitReset) rateLimitHeaders['X-RateLimit-Reset'] = rateLimitReset;
        if (rateLimitRemaining) rateLimitHeaders['X-RateLimit-Remaining'] = rateLimitRemaining;
      }
      // --- Provider-specific error handling ---
      const lowerError = cleanError.toLowerCase();
      const errorClass = classifyProviderError({
        status: response.status,
        provider: selectedProvider,
        message: cleanError,
        metadata: errorMetadata,
        headers: response.headers,
      });

      // The provider's own words for a refusal or an auth failure are shown under Details. Some
      // providers echo the key they were given, so it is masked, and the text is bounded.
      const providerSaid = providerMessageForDisplay(cleanError, apiKey);

      // A request the provider refused for its content (moderation) or a model it refused to serve:
      // its own words say why, so they are passed on rather than an authentication hint.
      if (errorClass.code === 'blocked' || errorClass.code === 'model_refused') {
        const reasons = Array.isArray(errorMetadata?.reasons) ? (errorMetadata.reasons as unknown[]).filter((r) => typeof r === 'string') : [];
        const said = providerMessageForDisplay(`${cleanError}${reasons.length ? ` (${reasons.join(', ')})` : ''}`, apiKey);
        return NextResponse.json(
          { ...errorClass, error: `${providerConfig.name} refused the request: ${said}` },
          { status: response.status }
        );
      }

      // Auth errors — actionable message for all providers, with what the provider said
      if (response.status === 401 || response.status === 403) {
        const providerName = providerConfig.name;
        const authHint = providerConfig.usesOAuth
          ? `Try reconnecting your ${providerName} account in Settings.`
          : `Check your ${providerName} API key in Settings.`;
        return NextResponse.json(
          { ...errorClass, error: `${providerName} authentication failed (${providerSaid}). ${authHint}` },
          { status: response.status }
        );
      }

      // Transient rate-limit (429 with rate-limit phrasing or a Retry-After header).
      // Checked BEFORE credit-exhaustion so messages like "temporarily rate-limited
      // upstream, retry shortly" don't get misclassified as credit exhaustion just
      // because the substring "limit" appears inside "rate-limited".
      if (response.status === 429 && (
        rateLimitHeaders['Retry-After'] ||
        lowerError.includes('rate-limited') ||
        lowerError.includes('rate limit') ||
        lowerError.includes('too many requests') ||
        lowerError.includes('temporarily') ||
        lowerError.includes('retry shortly') ||
        lowerError.includes('retry after')
      )) {
        return NextResponse.json(
          { ...errorClass, error: `${providerConfig.name} is temporarily rate-limited. Try again in a moment.` },
          { status: 429, headers: rateLimitHeaders }
        );
      }

      // Credit/quota exhaustion (402, or 429 with usage-related keywords).
      // Note: "limit" is intentionally excluded because it false-matches "rate-limited".
      if (response.status === 402 || (response.status === 429 && (
        lowerError.includes('credit') || lowerError.includes('quota') ||
        lowerError.includes('billing') || lowerError.includes('exceeded') ||
        lowerError.includes('insufficient') || lowerError.includes('usage')
      ))) {
        if (selectedProvider === 'huggingface') {
          return NextResponse.json(
            { ...errorClass, error: 'HuggingFace free usage limit reached. You get $0.10/month in free inference. Upgrade at huggingface.co/pricing or wait for your credits to reset.' },
            { status: 429 }
          );
        }
        if (selectedProvider === 'openrouter') {
          return NextResponse.json(
            { ...errorClass, error: 'OpenRouter credit limit reached. Add credits at openrouter.ai/credits or switch to a provider with your own API key.' },
            { status: 429 }
          );
        }
        return NextResponse.json(
          { ...errorClass, error: `${providerConfig.name} usage limit reached. Check your billing or plan at your provider's dashboard.` },
          { status: 429 }
        );
      }

      // Model not found / removed (400 or 404)
      if ((response.status === 400 || response.status === 404) && (
        lowerError.includes('not found') || lowerError.includes('does not exist') ||
        lowerError.includes('no such model') || lowerError.includes('invalid model')
      )) {
        return NextResponse.json(
          { ...errorClass, error: `Model not available on ${providerConfig.name}. It may have been removed or renamed. Try selecting a different model in Settings.` },
          { status: 400 }
        );
      }

      // Tool/function calling not supported (400)
      if (response.status === 400 && (
        lowerError.includes('does not support tools') ||
        (lowerError.includes('tool') && lowerError.includes('not supported')) ||
        (lowerError.includes('function call') && lowerError.includes('not supported'))
      )) {
        // Local providers: fall back to JSON-based tool calling
        if (providerConfig.isLocal && tools && tools.length > 0) {
        const fallbackSystemPrompt = systemPrompt + `

IMPORTANT: This model doesn't support native function calling, so you must use JSON format for tool calls.

Available tools:
${tools.map((tool: ToolDefinition) => `
- ${tool.name}: ${tool.description}
  Parameters: ${JSON.stringify(tool.parameters, null, 2)}
`).join('')}

When you need to use a tool, respond with:
\`\`\`json
{
  "tool_calls": [
    {
      "id": "call_1",
      "function": {
        "name": "tool_name",
        "arguments": "{\"param1\": \"value1\"}"
      }
    }
  ]
}
\`\`\`

You can make multiple tool calls in a single response. Always include the tool_calls array even for a single tool call.`;

        const fallbackMessages = [...chatMessages];
        const systemMsgIndex = fallbackMessages.findIndex(m => m.role === 'system');
        if (systemMsgIndex >= 0) {
          fallbackMessages[systemMsgIndex].content = fallbackSystemPrompt;
        }

        const fallbackBody: any = {
          ...outgoingBody,
          messages: selectedProvider === 'ollama' ? messagesToOllama(fallbackMessages) : fallbackMessages
        };
        delete fallbackBody.tools;
        delete fallbackBody.tool_choice;

        const fallbackResponse = await fetch(apiEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(fallbackBody),
          signal: request.signal,
        });

        if (!fallbackResponse.ok) {
          let fallbackError = await fallbackResponse.text();
          if (fallbackError.trimStart().startsWith('<!') || fallbackError.trimStart().startsWith('<html')) {
            fallbackError = `HTTP ${fallbackResponse.status} — ${fallbackResponse.statusText || 'unknown error'}`;
          }
          return NextResponse.json(
            { error: `${providerConfig.name} API error (after fallback): ${fallbackError}` },
            { status: fallbackResponse.status }
          );
        }

        const fallbackHeaders: Record<string, string> = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Tool-Fallback': 'json-parsing'
        };

        return new Response(
          selectedProvider === 'ollama' ? fallbackResponse.body?.pipeThrough(createOllamaToCompletionsTransformer()) : fallbackResponse.body,
          { headers: fallbackHeaders },
        );
        }
        // Non-local providers: actionable error message
        return NextResponse.json(
          { ...errorClass, error: `This model does not support tool/function calling. Try a different model or switch to OpenRouter with MiniMax M2.7.` },
          { status: 400 }
        );
      }

      // Anthropic overloaded (529) — transient, will be retried by orchestrator
      if (response.status === 529) {
        return NextResponse.json(
          { ...errorClass, error: `${providerConfig.name} is temporarily overloaded. The request will be retried automatically.` },
          { status: 529 }
        );
      }

      // OpenRouter 503 — no provider available for this model/routing config
      if (selectedProvider === 'openrouter' && response.status === 503) {
        return NextResponse.json(
          { ...errorClass, error: `No provider currently available for this model on OpenRouter. The model may be temporarily down. Try a different model or wait a few minutes.` },
          { status: 503 }
        );
      }

      return NextResponse.json(
        { ...errorClass, error: `${providerConfig.name} API error: ${cleanError}` },
        { status: response.status, headers: rateLimitHeaders }
      );
    }

    // Non-streaming: return JSON directly
    if (!streamEnabled) {
      const data = await response.json();
      return NextResponse.json(selectedProvider === 'ollama' ? ollamaToCompletionsResponse(data) : data);
    }

    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };

    if (selectedProvider === 'openrouter') {
      const openRouterHeaders = [
        'x-openrouter-generation-id',
        'x-openrouter-usage',
        'x-openrouter-tokens',
        'x-openrouter-cost'
      ];

      for (const headerName of openRouterHeaders) {
        const value = response.headers.get(headerName);
        if (value) {
          responseHeaders[headerName] = value;
        }
      }
    }

    return new Response(
      selectedProvider === 'ollama' ? response.body?.pipeThrough(createOllamaToCompletionsTransformer()) : response.body,
      { headers: responseHeaders },
    );
  } catch (error) {
    // Client disconnected — abort is expected, no error response needed
    if (error instanceof Error && error.name === 'AbortError') {
      return new Response(null, { status: 499 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    const isNetwork = /fetch failed|Failed to fetch|NetworkError/i.test(message);
    const friendly = isNetwork
      ? (localTarget
        ? `Could not reach ${localTarget.name} at ${localTarget.url}. Make sure it is running on the same machine as OSW Studio${localTarget.hint}.`
        : 'Network error: unable to reach the model API. Check your internet connection or proxy settings.')
      : message;
    return NextResponse.json(
      { error: friendly },
      { status: isNetwork ? 503 : 500 }
    );
  }
}
