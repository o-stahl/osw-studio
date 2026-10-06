/**
 * What a provider will say right now about how much of an account's allowance is left.
 *
 * Every number the chat shows about a limit comes from here at the moment it is shown, never from a
 * figure written into the app: free tiers change without notice, and each account sits on its own
 * tier. A provider that publishes nothing gets `{ kind: 'none' }`, and the chat says what happened
 * without a number.
 */

export type ProviderQuota =
  /** A daily count of free requests, shared by every free model on the account. */
  | { kind: 'daily'; used: number; limit: number; remaining: number; resetAt: number }
  /** A spendable balance (Pollen on Pollinations). */
  | { kind: 'balance'; remaining: number; unit: 'pollen' }
  | { kind: 'none' };

export interface ProviderStatus {
  quota: ProviderQuota;
  /**
   * The account has never bought credit, so only free models will answer. OpenRouter only; absent
   * when the provider does not say.
   */
  freeOnly?: boolean;
}

/** The start of the next UTC day: when OpenRouter's free-model count starts over. */
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** `GET https://openrouter.ai/api/v1/key`, as `{ data: {...} }`. */
export function parseOpenRouterKey(body: unknown, now = Date.now()): ProviderStatus {
  const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const daily = data.free_model_daily_requests as { used?: unknown; limit?: unknown; remaining?: unknown } | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const used = num(daily?.used);
  const limit = num(daily?.limit);
  const remaining = num(daily?.remaining) ?? (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined);
  const quota: ProviderQuota = used !== undefined && limit !== undefined && remaining !== undefined
    ? { kind: 'daily', used, limit, remaining, resetAt: nextUtcMidnight(now) }
    : { kind: 'none' };
  return {
    quota,
    ...(typeof data.is_free_tier === 'boolean' ? { freeOnly: data.is_free_tier } : {}),
  };
}

/** `GET https://gen.pollinations.ai/account/balance`, as `{ balance }`. */
export function parsePollinationsBalance(body: unknown): ProviderStatus {
  const balance = (body as { balance?: unknown } | null)?.balance;
  return typeof balance === 'number' && Number.isFinite(balance)
    ? { quota: { kind: 'balance', remaining: balance, unit: 'pollen' } }
    : { quota: { kind: 'none' } };
}

/** The providers this can ask. Everyone else answers `{ kind: 'none' }` without a request. */
const STATUS_PROVIDERS = new Set(['openrouter', 'pollinations']);

/** Ask from the browser, through `/api/provider-status`. Never throws. */
export async function fetchProviderStatus(provider: string, apiKey: string): Promise<ProviderStatus> {
  if (!STATUS_PROVIDERS.has(provider) || !apiKey) return { quota: { kind: 'none' } };
  try {
    const { apiFetch } = await import('@/lib/api/backend-status');
    const response = await apiFetch('/api/provider-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey }),
    });
    if (!response.ok) return { quota: { kind: 'none' } };
    return (await response.json()) as ProviderStatus;
  } catch {
    return { quota: { kind: 'none' } };
  }
}
