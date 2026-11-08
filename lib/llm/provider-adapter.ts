// lib/llm/provider-adapter.ts
// Implements the ProviderAdapter interface: call(), getModel(), getProvider(), supportsTools().
// Throws ProviderApiError for the caller to handle; it keeps no state between calls.

import type { ProviderAdapter, ProviderCallParams, ParsedResponse, ProgressReporter } from './core/types';
import type { ProviderModel } from './providers/types';
import { parseStreamingResponse, type StreamResponse } from './streaming-parser';
import { CostCalculator } from './cost-calculator';
import { registerOpenRouterPricingFromApi, registerPricingFromProviderModels } from './pricing-cache';
import { fetchAvailableModels } from './models-api';
import { ensureModelsDevPricing } from './models-dev';
import { apiFetch } from '@/lib/api/backend-status';
import { requestSnapshotStore } from './request-snapshot';
import { logger } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { classifyProviderError, type ApiErrorBody, type ApiErrorCode } from './provider-errors';
import { isDemo } from '@/lib/demo';
import { OSWS_PROVIDER } from '@/lib/inference/allowance';
import { track } from '@/lib/telemetry';

/** Waits `ms`, or ends with the abort, as a fetch would, when `signal` aborts first. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) {
      aborted();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      aborted();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The `code` of an error answer, read without using up the response. */
async function answerCode(response: Response): Promise<unknown> {
  try {
    return ((await response.clone().json()) as { code?: unknown } | null)?.code;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// ProviderApiError — typed error thrown on non-transient API failures.
// The caller (AgentLoop) catches this and invokes onProviderError, which decides whether to stop.
// ---------------------------------------------------------------------------

export class ProviderApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errorType: string,
    public readonly errorCategory: string,
    public readonly provider: string,
    public readonly model: string,
    /** Timing the provider gave with the error: how long to wait, or when an allowance renews. */
    public readonly timing: { retryAfterMs?: number; resetAt?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderApiError';
  }

  /** For an error sent inside the stream: its own type code (`upstream_idle`, `timeout`…), when it gives one. */
  streamErrorType?: string;
}

/**
 * Stream errors worth asking again for, when nothing usable arrived: the statuses `fetchWithRetry`
 * retries on the status line, less 429 (classified on its own). 503 is not transient on OpenRouter.
 */
const RETRYABLE_STREAM_STATUSES = new Set([502, 504, 529]);
const STREAM_RETRIES = 2;

/** A stream error's `metadata.error_type`, when it is a type code rather than free text. */
function streamErrorType(metadata: Record<string, unknown> | undefined): string | undefined {
  const type = metadata?.error_type;
  return typeof type === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(type) ? type : undefined;
}

/** A streamed tool call whose arguments did not finish arriving: what is there does not parse. */
function isUnfinished(args: string | undefined): boolean {
  if (!args) return true;
  try { JSON.parse(args); return false; } catch { return true; }
}

/**
 * Codes `/api/generate` attaches that are categories in their own right. The keyword fallback in
 * `classifyError` only runs for an error without one (a custom endpoint relayed verbatim).
 */
const CODE_CATEGORIES: Record<ApiErrorCode, string> = {
  rate_limited: 'rate_limited',
  model_busy: 'model_busy',
  daily_limit: 'daily_limit',
  credit_exhausted: 'credit_exhausted',
  auth: 'auth_expired',
  blocked: 'blocked',
  model_refused: 'model_refused',
  model_unavailable: 'model_not_found',
  overloaded: 'server_error',
  tool_unsupported: 'tool_not_supported',
  context_too_long: 'context_too_long',
};

/** A wait does not help these: the allowance is spent until it renews or is topped up. */
const NO_RETRY_CODES = new Set<ApiErrorCode>(['daily_limit', 'credit_exhausted', 'model_busy']);

// ---------------------------------------------------------------------------
// Config interface — narrow dependency injection for testability
// ---------------------------------------------------------------------------

export interface ProviderAdapterConfig {
  getProviderConfig: () => { provider: string; apiKey: string; model: string; baseUrl?: string; customHeaders?: Record<string, string> };
  getApiUrl: () => string;
  /** Headers sent with each request to `getApiUrl()`: a server-side run's own (lib/server-generate/run-auth.ts). */
  getRequestHeaders?: () => Record<string, string> | undefined;
  getReasoningEnabled: (model: string) => boolean;
  getDebugStreamEnabled: () => boolean;
  getModelPricing: (provider: string, model: string) => unknown;
  getCachedModels: (provider: string) => { models: { id: string; supportsFunctions?: boolean }[] } | null;
  /** Context length a local provider is loaded with; undefined for cloud providers. */
  getLocalContextLength?: () => number | undefined;
  /**
   * What ties a project's requests together for the free allowance (the orchestrator passes the
   * project id), which uses it to keep them on one upstream and its prompt cache warm.
   * `/api/generate` hashes it before it leaves.
   */
  getSessionId?: () => string | undefined;
  progress: ProgressReporter;
}

// ---------------------------------------------------------------------------
// OswsProviderAdapter
// ---------------------------------------------------------------------------

export class OswsProviderAdapter implements ProviderAdapter {
  private pricingEnsured = new Set<string>();

  constructor(private config: ProviderAdapterConfig) {}

  getModel(): string {
    return this.config.getProviderConfig().model;
  }

  getProvider(): string {
    return this.config.getProviderConfig().provider;
  }

  supportsTools(): boolean {
    const { provider, model } = this.config.getProviderConfig();
    const cached = this.config.getCachedModels(provider);
    if (cached?.models?.length) {
      const entry = (cached.models as ProviderModel[]).find(m => m.id === model);
      if (entry && entry.supportsFunctions === false) return false;
    }
    return true;
  }

  async call(params: ProviderCallParams): Promise<ParsedResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(params);
      } catch (error) {
        // A transient stream error before anything usable arrived: the request is asked again, as a
        // 502 or 504 on the status line is. Nothing ran, so nothing repeats.
        const transient = error instanceof ProviderApiError && error.errorType === 'midstream'
          && error.errorCategory === 'midstream_error' && RETRYABLE_STREAM_STATUSES.has(error.status);
        if (!transient || attempt >= STREAM_RETRIES || params.signal?.aborted) throw error;
        const delay = Math.pow(2, attempt) * 1000;
        const reason = `Stream error (${(error as ProviderApiError).status})`;
        const message = `${reason}. Retry attempt ${attempt + 1} in ${delay / 1000}s...`;
        logger.warn(message);
        if (params.silent !== true) {
          this.config.progress.onEvent('retry', {
            provider: this.getProvider(), attempt: attempt + 1, delay, status: (error as ProviderApiError).status, reason, message,
          });
        }
        await wait(delay, params.signal);
      }
    }
  }

  private async callOnce(params: ProviderCallParams): Promise<ParsedResponse> {
    const providerConfig = this.config.getProviderConfig();
    const { provider, model } = providerConfig;
    let apiKey = providerConfig.apiKey;
    const silent = params.silent === true;

    // Refresh Codex OAuth token if needed before making the API call
    if (provider === 'openai-codex') {
      const { ensureValidCodexToken } = await import('@/lib/auth/codex-auth');
      apiKey = await ensureValidCodexToken();
    }

    // The free allowance sends no key from the browser: the server adds the token (on the demo, for the
    // trial session in this browser's cookie, lib/inference/trial).
    const demoTrial = provider === OSWS_PROVIDER && typeof window !== 'undefined' && isDemo();

    await this.ensurePricing(provider, model);

    const modelSupportsTools = this.supportsTools();
    // Skip reasoning for silent calls (compaction) — saves tokens and avoids streaming noise
    const reasoningEnabled = !silent && this.config.getReasoningEnabled(model);

    const localContextLength = this.config.getLocalContextLength?.();
    const requestBody = {
      messages: params.messages,
      apiKey,
      model,
      provider,
      ...(modelSupportsTools && params.tools ? { tools: params.tools } : {}),
      max_tokens: params.maxTokens ?? 16384,
      ...(modelSupportsTools && params.tools?.length && { tool_choice: 'auto' }),
      ...(reasoningEnabled && { reasoning: { enabled: true } }),
      ...(providerConfig.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(providerConfig.customHeaders ? { customHeaders: providerConfig.customHeaders } : {}),
      ...(localContextLength ? { context_length: localContextLength } : {}),
      ...(provider === OSWS_PROVIDER && this.config.getSessionId?.() ? { sessionId: this.config.getSessionId() } : {}),
    };

    // Debug capture of the exact outgoing history (no-op unless enabled in the
    // debug panel's Messages tab; skip compaction calls — not conversation requests)
    if (!silent) {
      requestSnapshotStore.capture({ messages: params.messages, provider, model });
    }

    // Debug logging (skip for silent calls)
    if (!silent && this.config.getDebugStreamEnabled()) {
      const toolNames = modelSupportsTools && params.tools ? params.tools.map(t => t.name) : [];
      this.config.progress.onEvent('llm_request', {
        provider,
        model,
        messageCount: params.messages.length,
        toolNames,
      });
    }

    const send = (body: typeof requestBody) => this.fetchWithRetry(
      this.config.getApiUrl(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.config.getRequestHeaders?.() },
        body: JSON.stringify(body),
      },
      3,
      params.signal,
    );
    // Sessions the page had started when this request left: one started since, by a parallel
    // request's check, is the session this request was missing.
    const sessionsBefore = demoTrial ? (await import('@/lib/inference/trial-check')).trialSessionsStarted() : 0;
    let response = await send(requestBody);

    // No trial session in this browser, or it has ended (over, its allowance spent, or a request from
    // another network): the bot check for a new one, then one retry.
    if (demoTrial && response.status === 401 && (await answerCode(response)) === 'trial_session') {
      const { trialSessionsStarted } = await import('@/lib/inference/trial-check');
      if (trialSessionsStarted() === sessionsBefore) await this.startTrialSession(model, params.signal);
      response = await send(requestBody);
    }

    if (!response.ok) {
      const status = response.status;

      let errorMessage = `API call failed: ${response.statusText}`;
      let body: Partial<ApiErrorBody> = {};
      try {
        const errorData = await response.json();
        body = errorData ?? {};
        if (errorData.error) {
          errorMessage = typeof errorData.error === 'string'
            ? errorData.error
            : (errorData.error.message || JSON.stringify(errorData.error));
        }
      } catch { /* ignore parse failures */ }

      const { errorType, errorCategory } = this.classifyError(status, errorMessage, body.code);
      const timing = {
        ...(typeof body.retryAfterMs === 'number' ? { retryAfterMs: body.retryAfterMs } : {}),
        ...(typeof body.resetAt === 'number' ? { resetAt: body.resetAt } : {}),
      };

      // HF refused the sign-in. Drop it now so Settings stops showing "Connected", the chat
      // footer offers sign-in again, and no retry can re-send the same dead token.
      if (errorCategory === 'auth_expired' && provider === 'huggingface' && typeof window !== 'undefined'
          && configManager.getHFAuth()) {
        configManager.clearHFAuth();
        window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider: 'huggingface', hasKey: false } }));
        errorMessage = 'Your HuggingFace sign-in has expired. Sign in again to keep going.';
      }

      throw new ProviderApiError(errorMessage, status, errorType, errorCategory, provider, model, timing);
    }

    // Only 'bash' is ever advertised, but derive from the tools we actually sent
    // so the parser can abort early if the model calls an unexpected tool name.
    const allowedToolNames = modelSupportsTools && params.tools?.length
      ? new Set(params.tools.map(t => t.name))
      : undefined;
    const result = await this.parseAndTrack(response, provider, model, silent, allowedToolNames);

    // Midstream error: provider sent error in SSE stream (HTTP 200 but upstream rejected)
    if (result.midstreamError && (!result.toolCalls || result.toolCalls.length === 0) && !result.content) {
      const midstreamStatus = typeof result.midstreamError.code === 'number' ? result.midstreamError.code : 0;
      // A provider error relayed inside the stream still says what happened: a busy free model
      // arrives this way as often as on the status line.
      const midstreamCode = midstreamStatus === 429 || midstreamStatus === 403
        ? classifyProviderError({ status: midstreamStatus, provider, message: result.midstreamError.message, metadata: result.midstreamError.metadata }).code
        : undefined;
      const midstreamCategory = midstreamCode ? CODE_CATEGORIES[midstreamCode] : 'midstream_error';
      const error = new ProviderApiError(
        result.midstreamError.message,
        midstreamStatus,
        'midstream',
        midstreamCategory,
        provider,
        model,
      );
      error.streamErrorType = streamErrorType(result.midstreamError.metadata);
      throw error;
    }

    // A stream error after part of the answer arrived: the answer is used, but a tool call whose
    // arguments were still arriving is cut off, and is marked so it is never run.
    let streamError: ParsedResponse['streamError'];
    let unfinishedToolCallIds: string[] | undefined;
    if (result.midstreamError) {
      const status = typeof result.midstreamError.code === 'number' ? result.midstreamError.code : 0;
      const type = streamErrorType(result.midstreamError.metadata);
      streamError = { status, ...(type ? { type } : {}) };
      const unfinished = (result.toolCalls ?? []).filter((tc) => isUnfinished(tc.function?.arguments)).map((tc) => tc.id);
      if (unfinished.length) unfinishedToolCallIds = unfinished;
      if (!silent) {
        track('api_error', {
          provider, model, error_type: 'midstream', error_category: 'midstream_error', status_code: status,
          after_output: true, unfinished_tool_calls: unfinished.length,
          ...(type ? { stream_error_type: type } : {}),
        });
      }
    }

    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      reasoningDetails: result.reasoningDetails,
      invalidToolName: result.invalidToolName,
      ...(streamError ? { streamError } : {}),
      ...(unfinishedToolCallIds ? { unfinishedToolCallIds } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: fetchWithRetry
  // Retries on 429, 502, 504, 529 with exponential backoff / Retry-After header.
  // ---------------------------------------------------------------------------

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = 3,
    signal?: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await apiFetch(url, { ...options, signal }, { relaysUpstream: true });

      // Retry on rate limits (429), transient server errors (502, 504), and Anthropic overloaded (529)
      // Note: 503 is NOT retried — OpenRouter uses it for "no provider available" which is not transient
      const retryableStatus = response.status === 429 || response.status === 502 || response.status === 504 || response.status === 529;
      if (!retryableStatus) {
        return response;
      }

      if (attempt === maxRetries) {
        return response;
      }

      // Waiting cannot help a spent allowance, and a busy model is better replaced than waited on.
      if (response.status === 429) {
        const code = await answerCode(response);
        if (typeof code === 'string' && NO_RETRY_CODES.has(code as ApiErrorCode)) return response;
      }

      const retryAfter = response.headers.get('Retry-After');
      const parsed = retryAfter ? parseInt(retryAfter) : NaN;
      const delay = !isNaN(parsed) ? parsed * 1000 : Math.pow(2, attempt) * 1000;

      const reason = response.status === 429 ? 'Rate limited' : `Server error (${response.status})`;
      const message = `${reason}. Retry attempt ${attempt + 1} in ${delay / 1000}s...`;
      logger.warn(message);

      this.config.progress.onEvent('retry', {
        provider: this.getProvider(),
        attempt: attempt + 1,
        delay,
        status: response.status,
        reason,
        message,
      });

      await wait(delay, signal);
    }

    throw new Error('Unexpected end of retry loop');
  }

  // ---------------------------------------------------------------------------
  // Private: ensurePricing
  // Ensures dynamic pricing data is loaded for the active provider/model.
  // OpenRouter uses its own API; all other cloud providers fall back to
  // models.dev for pricing data.
  // ---------------------------------------------------------------------------

  private async ensurePricing(provider: string, model: string): Promise<void> {
    const key = `${provider}:${model}`;
    if (this.pricingEnsured.has(key)) {
      return;
    }

    // The free allowance costs the user nothing (`calculateCost`): no price list to fetch.
    if (provider === OSWS_PROVIDER || this.config.getModelPricing(provider, model)) {
      this.pricingEnsured.add(key);
      return;
    }

    if (provider === 'openrouter') {
      const cachedModels = this.config.getCachedModels('openrouter');
      if (cachedModels?.models?.length) {
        registerPricingFromProviderModels('openrouter', cachedModels.models as ProviderModel[]);
        if (this.config.getModelPricing('openrouter', model)) {
          this.pricingEnsured.add(key);
          return;
        }
      }

      try {
        const models = await fetchAvailableModels();
        registerOpenRouterPricingFromApi(models);
      } catch (error) {
        logger.warn('[ProviderAdapter] Failed to fetch OpenRouter pricing', error);
      }
    }

    if (!this.config.getModelPricing(provider, model)) {
      try {
        await ensureModelsDevPricing();
      } catch (error) {
        logger.warn('[ProviderAdapter] Failed to fetch models.dev pricing', error);
      }
    }

    this.pricingEnsured.add(key);
  }

  // ---------------------------------------------------------------------------
  // Private: parseAndTrack
  // Parses streaming response, records cost, emits usage event.
  // ---------------------------------------------------------------------------

  private async parseAndTrack(
    response: Response,
    provider: string,
    model: string,
    silent = false,
    allowedToolNames?: ReadonlySet<string>,
  ): Promise<StreamResponse> {
    const result = await parseStreamingResponse(response, {
      provider,
      model,
      debugStream: !silent && this.config.getDebugStreamEnabled(),
      allowedToolNames,
      onProgress: silent ? undefined : (event: string, data?: Record<string, unknown>) => {
        this.config.progress.onEvent(event, data);
      },
    });

    if (result.usage) {
      const usage = result.usage;
      if (!usage.provider) usage.provider = provider;
      if (!usage.model) usage.model = model;

      // Use actual cost from OpenRouter response header when available
      const reportedCost = response.headers.get('x-openrouter-cost');
      if (reportedCost) {
        const parsed = parseFloat(reportedCost);
        if (Number.isFinite(parsed) && parsed > 0) {
          usage.cost = parsed;
          usage.isEstimated = false;
        }
      }

      const cost = CostCalculator.calculateCost(usage, provider, model, true);
      usage.cost = cost;

      // Silent calls (compaction) skip progress events but still compute cost on the response
      if (!silent) {
        this.config.progress.onEvent('usage', { usage, cost });
      }
    }

    return result;
  }

  /**
   * Starts a new trial session for this browser. When it cannot, it throws the stop the chat shows
   * instead: no session left today for this network as spent allowance (with when it resets), a failed
   * check as an expired key, and no answer at all as a model that is not available.
   */
  private async startTrialSession(model: string, signal?: AbortSignal): Promise<void> {
    const { startTrialSession, TrialCheckError } = await import('@/lib/inference/trial-check');
    try {
      await startTrialSession(signal);
    } catch (err) {
      // Stopped while the check ran: rethrown, as any other request's abort.
      if (signal?.aborted) throw err;
      const failure = err instanceof TrialCheckError ? err.failure : 'unavailable';
      if (failure === 'trial_limit') {
        const resetAt = err instanceof TrialCheckError ? err.resetAt : undefined;
        throw new ProviderApiError('OSW Studio inference has no more free sessions for this network today.', 429, 'rate_limit', 'daily_limit', OSWS_PROVIDER, model, resetAt ? { resetAt } : {});
      }
      if (failure === 'check_failed') {
        throw new ProviderApiError('The bot check for OSW Studio inference did not pass.', 401, 'auth', 'auth_expired', OSWS_PROVIDER, model);
      }
      throw new ProviderApiError('OSW Studio inference is not available right now.', 503, 'server', 'model_not_found', OSWS_PROVIDER, model);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: classifyError
  // Classifies HTTP error status + message into errorType + errorCategory.
  // ---------------------------------------------------------------------------

  private classifyError(status: number, errorMessage: string, code?: ApiErrorCode): { errorType: string; errorCategory: string } {
    let errorType = 'unknown';
    if (status === 429) errorType = 'rate_limit';
    // A refused request or a model refusing the app is not a key problem, whatever the status.
    else if (code === 'blocked' || code === 'model_refused') errorType = 'refused';
    else if (status === 401 || status === 403) errorType = 'auth';
    else if (status >= 500 || status === 529) errorType = 'server';
    else if (status === 400) errorType = 'invalid_request';

    if (code && CODE_CATEGORIES[code]) return { errorType, errorCategory: CODE_CATEGORIES[code] };

    const lowerMsg = errorMessage.toLowerCase();
    let errorCategory = 'unknown';
    // "limit" alone is not evidence of spent credit: it is inside every "rate-limited" too.
    const ratePhrased = lowerMsg.includes('rate-limit') || lowerMsg.includes('rate limit') || lowerMsg.includes('temporarily');

    if (status === 402 || (status === 429 && !ratePhrased && (lowerMsg.includes('credit') || lowerMsg.includes('usage') || lowerMsg.includes('exceeded') || lowerMsg.includes('quota')))) {
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

    return { errorType, errorCategory };
  }
}
