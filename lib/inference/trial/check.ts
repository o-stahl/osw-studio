/**
 * Cloudflare Turnstile's answer for a solve, held to what a trial session needs: a success, for the
 * `trial` action, on this site's hostname, at most five minutes old. `remoteIp` lets Cloudflare weigh
 * the address that asks against the one that solved it. Cloudflare answers for each solve once, so one
 * solve cannot start two sessions.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_AGE_MS = 300_000;
/** Cloudflare's codes for a secret key it does not know: every check fails until the setting is fixed. */
const SECRET_ERRORS = new Set(['missing-input-secret', 'invalid-input-secret']);

export const TRIAL_ACTION = 'trial';

export type CheckVerdict =
  | { ok: true }
  | { ok: false; reason: 'failed' | 'action' | 'hostname' | 'stale' | 'unreachable' };

export async function verifyTrialCheck(
  secretKey: string,
  token: string,
  expected: { remoteIp: string | null; hostname: string },
  now = Date.now(),
): Promise<CheckVerdict> {
  let data: { success?: boolean; action?: string; hostname?: string; challenge_ts?: string; 'error-codes'?: unknown };
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secretKey, response: token, ...(expected.remoteIp ? { remoteip: expected.remoteIp } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    data = await res.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  // A refusal that comes from this server's settings rather than the visitor is logged: it fails every
  // visitor, and nothing else would show it.
  if (data.success !== true) {
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'].filter((code) => typeof code === 'string') : [];
    if (codes.some((code) => SECRET_ERRORS.has(code))) console.warn(`[trial] Turnstile refused the secret key: ${codes.join(', ')}`);
    return { ok: false, reason: 'failed' };
  }
  if (data.action !== TRIAL_ACTION) {
    console.warn(`[trial] Turnstile solve for action "${String(data.action)}", not "${TRIAL_ACTION}"`);
    return { ok: false, reason: 'action' };
  }
  if (!data.hostname || data.hostname.toLowerCase() !== expected.hostname.toLowerCase()) {
    console.warn(`[trial] Turnstile solve for hostname "${String(data.hostname)}", this request's is "${expected.hostname}"`);
    return { ok: false, reason: 'hostname' };
  }
  const solvedAt = data.challenge_ts ? Date.parse(data.challenge_ts) : NaN;
  if (Number.isNaN(solvedAt) || now - solvedAt > MAX_AGE_MS) return { ok: false, reason: 'stale' };
  return { ok: true };
}
