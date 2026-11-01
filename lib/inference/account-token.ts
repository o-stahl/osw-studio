import { createHmac } from 'crypto';

/**
 * A hosted user's token for the free allowance (`./allowance.ts`), asked of the gateway
 * (`/api/inference/account-token`) and signed like the instance's webhooks: `WEBHOOK_URL`,
 * `WEBHOOK_SECRET` and `INSTANCE_ID`, as in lib/webhooks/delivery.ts. Kept per user until ten
 * minutes before it expires, or until the inference server refuses it; concurrent callers share one
 * request, and after the gateway gives none it is not asked again for half a minute. Server only.
 */

export interface AccountToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

const REFRESH_BEFORE_MS = 10 * 60_000;
const USABLE_MARGIN_MS = 60_000;
const RETRY_AFTER_MS = 30_000;

const cache = new Map<string, AccountToken>();
const pending = new Map<string, Promise<AccountToken | null>>();
/** By user: when the gateway may be asked again after it gave no token. */
const retryAt = new Map<string, number>();
let toldUnconfigured = false;

async function fetchAccountToken(userId: string): Promise<AccountToken | null> {
  const base = process.env.WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  const instanceId = process.env.INSTANCE_ID;
  if (!base || !secret || !instanceId) {
    if (!toldUnconfigured) console.warn('[allowance] no account tokens: WEBHOOK_URL, WEBHOOK_SECRET or INSTANCE_ID is not set');
    toldUnconfigured = true;
    return null;
  }

  const body = JSON.stringify({ userId, ts: Date.now() });
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/inference/account-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-instance-id': instanceId,
        'x-webhook-signature': createHmac('sha256', secret).update(body).digest('hex'),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The gateway's `code` says which setting is off (bad_signature, unknown_instance, ...).
      const code = await res.json().then((body: { code?: unknown }) => body?.code, () => undefined);
      console.warn(`[allowance] the gateway refused an account token: ${res.status}${typeof code === 'string' ? ` ${code}` : ''}`);
      return null;
    }
    const data = await res.json() as { token?: unknown; expiresAt?: unknown };
    if (typeof data.token !== 'string' || typeof data.expiresAt !== 'number') return null;
    const issued = { token: data.token, expiresAt: data.expiresAt };
    cache.set(userId, issued);
    return issued;
  } catch (err) {
    console.warn('[allowance] the gateway did not answer for an account token:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** A token for this user, fetched when there is none or it is close to expiring; null when none can be had. */
export async function getAccountToken(userId: string, now = Date.now()): Promise<AccountToken | null> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > now) return cached;
  // When the gateway gives none, a token that still works beats none.
  const usable = cached && cached.expiresAt - USABLE_MARGIN_MS > now ? cached : null;
  if ((retryAt.get(userId) ?? 0) > now) return usable;

  let request = pending.get(userId);
  if (!request) {
    request = fetchAccountToken(userId).finally(() => pending.delete(userId));
    pending.set(userId, request);
  }
  const fresh = await request;
  if (fresh) {
    retryAt.delete(userId);
    return fresh;
  }
  retryAt.set(userId, now + RETRY_AFTER_MS);
  return usable;
}

/** Drop the user's token after the inference server refused it, so the next request asks for a new one. */
export function forgetAccountToken(userId: string, token: string): void {
  if (cache.get(userId)?.token === token) cache.delete(userId);
}

/** Forget every cached token. For tests. */
export function resetAccountTokens(): void {
  cache.clear();
  pending.clear();
  retryAt.clear();
  toldUnconfigured = false;
}
