/**
 * What a provider's error response means for the run, as a code.
 *
 * `/api/generate` attaches the code to its error body and the client acts on it: wait, move "Free
 * models" to another model, or stop and offer ways to continue. The English `error` text stays
 * alongside for logs, but nothing decides on it, because providers word the same condition
 * differently and one word ("limit") turns up in conditions that need opposite handling.
 */

export type ApiErrorCode =
  /** A short-lived rate limit on the account. The same request succeeds after a wait. */
  | 'rate_limited'
  /** This one model is busy or limited for everyone. Another model can carry on now. */
  | 'model_busy'
  /** The account's daily allowance of free requests is used up, across every free model. */
  | 'daily_limit'
  /** No credit or allowance left. Nothing succeeds until it is topped up or renews. */
  | 'credit_exhausted'
  | 'auth'
  /** The provider refused this request's content (moderation, a guardrail). Another model may take it. */
  | 'blocked'
  /** OpenRouter refused the model whatever was sent: `permission_denied` (a model served only to listed apps, or a guardrail on the account or key), or any other 403 it gave no content reason for. */
  | 'model_refused'
  /** The model is gone, renamed, or has no provider serving it right now. */
  | 'model_unavailable'
  | 'overloaded'
  | 'tool_unsupported'
  | 'context_too_long';

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
  /** Milliseconds to wait before the same request can succeed, when the provider says. */
  retryAfterMs?: number;
  /** When the exhausted allowance renews, as epoch milliseconds, when the provider says. */
  resetAt?: number;
}

interface ProviderErrorInput {
  status: number;
  provider: string;
  /** The provider's own message, already pulled out of its body. */
  message: string;
  /** OpenRouter's `error.metadata`, when there was one. */
  metadata?: Record<string, unknown>;
  headers?: { get(name: string): string | null };
}

export interface ProviderErrorClass {
  code?: ApiErrorCode;
  retryAfterMs?: number;
  resetAt?: number;
}

const CREDIT_WORDS = ['credit', 'quota', 'billing', 'insufficient', 'balance', 'payment required'];
const BLOCK_WORDS = ['moderation', 'flagged', 'guardrail', 'content policy', 'safety'];
/** OpenRouter's `metadata.error_type` values for a refusal of what was sent. */
const CONTENT_ERROR_TYPES = new Set(['content_policy_violation', 'refusal']);
const RATE_WORDS = ['rate-limited', 'rate limit', 'ratelimit', 'too many requests', 'retry shortly', 'retry after', 'temporarily'];

/** `Retry-After` is seconds or an HTTP date. Anything else is no answer rather than zero. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * `X-RateLimit-Reset` as epoch milliseconds. OpenRouter sends milliseconds; a value small enough to
 * be seconds is scaled up so a provider using the other convention still lands in the future.
 */
export function parseResetHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

export function classifyProviderError(input: ProviderErrorInput): ProviderErrorClass {
  const { status, provider } = input;
  const lower = input.message.toLowerCase();
  const retryAfterMs = parseRetryAfter(input.headers?.get('retry-after'));
  const resetAt = parseResetHeader(input.headers?.get('x-ratelimit-reset'));
  const withTiming = (code: ApiErrorCode): ProviderErrorClass => ({
    code,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  });

  if (status === 401) return { code: 'auth' };
  if (status === 403) {
    // OpenRouter answers 403 for what was sent (a moderation flag: `reasons`, `flagged_input`) or
    // for the model (`permission_denied`: a model served only to listed apps, or a guardrail on the
    // account or key); a bad key is 401. An OpenRouter 403 with neither is treated as the model, the
    // closest fit. Elsewhere 403 is usually a key without access, unless it says it was the content.
    const type = typeof input.metadata?.error_type === 'string' ? input.metadata.error_type : '';
    if (CONTENT_ERROR_TYPES.has(type) || Array.isArray(input.metadata?.reasons) || typeof input.metadata?.flagged_input === 'string') {
      return { code: 'blocked' };
    }
    if (provider === 'openrouter' && type === 'permission_denied') return { code: 'model_refused' };
    if (BLOCK_WORDS.some((w) => lower.includes(w))) return { code: 'blocked' };
    return { code: provider === 'openrouter' ? 'model_refused' : 'auth' };
  }
  if (status === 402) return withTiming('credit_exhausted');

  if (status === 429) {
    // OpenRouter names the source of the limit. A shared upstream pool is one model being busy for
    // everyone on it; the account itself is fine.
    if (input.metadata?.limit_source === 'upstream_provider_shared_pool') return withTiming('model_busy');
    if (lower.includes('free-models-per-day')) return withTiming('daily_limit');
    const sounds = (words: string[]) => words.some((w) => lower.includes(w));
    if (sounds(CREDIT_WORDS) && !sounds(RATE_WORDS)) return withTiming('credit_exhausted');
    // Vercel's free tier limits each model separately, so another model is available at once.
    if (provider === 'vercel') return withTiming('model_busy');
    // OpenRouter's upstream wording without the metadata (a provider error relayed mid-stream).
    if (lower.includes('rate-limited upstream')) return withTiming('model_busy');
    return withTiming('rate_limited');
  }

  if (status === 529) return withTiming('overloaded');
  if (status === 503 && provider === 'openrouter') return { code: 'model_unavailable' };

  if (status === 400 || status === 404) {
    if (lower.includes('no endpoints found') || lower.includes('not found') || lower.includes('does not exist')
        || lower.includes('no such model') || lower.includes('invalid model')) {
      return { code: 'model_unavailable' };
    }
    if (lower.includes('too long') || lower.includes('too many tokens') || lower.includes('context length')
        || lower.includes('too large')) {
      return { code: 'context_too_long' };
    }
    if (lower.includes('does not support tools') || (lower.includes('tool') && lower.includes('not supported'))
        || (lower.includes('function call') && lower.includes('not supported'))) {
      return { code: 'tool_unsupported' };
    }
  }

  return {};
}

/**
 * Gemini names the window that ran out in `QuotaFailure.violations[].quotaId`. Its free tier counts
 * per model, so a per-day quota on one model leaves the others usable; a per-minute one passes on
 * its own after `RetryInfo.retryDelay`.
 */
export function classifyGeminiError(status: number, details: unknown): ProviderErrorClass {
  if (status !== 429 || !Array.isArray(details)) return {};
  let quotaIds: string[] = [];
  let retryAfterMs: number | undefined;
  for (const detail of details as Array<Record<string, unknown>>) {
    const type = String(detail['@type'] ?? '');
    if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      quotaIds = quotaIds.concat((detail.violations as Array<{ quotaId?: string }>).map((v) => v.quotaId ?? ''));
    }
    if (type.endsWith('RetryInfo') && typeof detail.retryDelay === 'string') {
      const seconds = parseFloat(detail.retryDelay);
      if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    }
  }
  if (quotaIds.some((id) => /PerDay/i.test(id))) return { code: 'model_busy' };
  if (quotaIds.length > 0) return { code: 'rate_limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  return {};
}

const DISPLAY_LIMIT = 300;

/** A provider's error message as the client may show it: the request's key masked, the length bounded. */
export function providerMessageForDisplay(message: string, apiKey?: string): string {
  const masked = apiKey && apiKey.length >= 8 ? message.split(apiKey).join('***') : message;
  return masked.length > DISPLAY_LIMIT ? `${masked.slice(0, DISPLAY_LIMIT)}…` : masked;
}
