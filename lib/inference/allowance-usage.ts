/**
 * How much of the day's OSW Studio inference (`./allowance.ts`) is used, as the inference server says
 * with each answer. It reports what was spent before the request it answers (a request's own cost is
 * known only when it ends), in micro-USD against the day's cap. This app's server passes it on to the
 * page as a share, with how many more trial sessions the visitor's network can start today on the
 * demo, where a spent session is followed by a new one.
 */

/** From the inference server: micro-USD spent today, the day's cap, and when the day ends (epoch ms). */
const UPSTREAM_SPENT_HEADER = 'x-osws-allowance-spent';
const UPSTREAM_LIMIT_HEADER = 'x-osws-allowance-limit';
const UPSTREAM_RESET_HEADER = 'x-osws-allowance-reset';

/** To the page: the share used (0 to 1), when it renews (epoch ms), and the trial sessions still to come. */
const ALLOWANCE_USED_HEADER = 'x-osws-allowance-used';
const ALLOWANCE_RESET_HEADER = 'x-osws-allowance-reset';
const ALLOWANCE_SESSIONS_HEADER = 'x-osws-allowance-sessions-left';

export interface AllowanceUsage {
  /** The share of the day's allowance used, 0 to 1. */
  used: number;
  /** When the allowance renews, epoch ms. */
  resetAt?: number;
  /** Trial sessions the network can still start today; absent where there are no sessions (hosted). */
  sessionsLeft?: number;
}

/** From this share on, a task may be cut off by the limit. */
export const ALLOWANCE_LOW_AT = 0.8;

const count = (value: string | null): number | undefined => {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The headers this app's server sends the page, from the inference server's. None when it said nothing. */
export function allowanceUsageHeaders(upstream: Headers, sessionsLeft?: number): Record<string, string> {
  const spent = count(upstream.get(UPSTREAM_SPENT_HEADER));
  const limit = count(upstream.get(UPSTREAM_LIMIT_HEADER));
  if (spent === undefined || !limit) return {};
  const headers: Record<string, string> = { [ALLOWANCE_USED_HEADER]: Math.min(1, spent / limit).toFixed(3) };
  const reset = count(upstream.get(UPSTREAM_RESET_HEADER));
  if (reset) headers[ALLOWANCE_RESET_HEADER] = String(reset);
  if (sessionsLeft !== undefined) headers[ALLOWANCE_SESSIONS_HEADER] = String(sessionsLeft);
  return headers;
}

/** What an answer from this app's server says about the allowance, or null when it says nothing. */
export function readAllowanceUsage(headers: Headers): AllowanceUsage | null {
  const used = count(headers.get(ALLOWANCE_USED_HEADER));
  if (used === undefined) return null;
  const resetAt = count(headers.get(ALLOWANCE_RESET_HEADER));
  const sessionsLeft = count(headers.get(ALLOWANCE_SESSIONS_HEADER));
  return {
    used: Math.min(1, used),
    ...(resetAt ? { resetAt } : {}),
    ...(sessionsLeft !== undefined ? { sessionsLeft } : {}),
  };
}

/** Nearly used up, with no further session to fall back on. */
export function allowanceLow(usage: AllowanceUsage): boolean {
  return usage.used >= ALLOWANCE_LOW_AT && (usage.sessionsLeft ?? 0) === 0;
}
