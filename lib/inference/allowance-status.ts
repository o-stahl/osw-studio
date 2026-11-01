import { freeAllowanceOffered } from './allowance';

/**
 * Whether the free allowance (`./allowance.ts`) can be used now, from a check this app's server
 * runs (`/api/inference/status`): on the demo, that this server can run the trial and the inference
 * server answers; on a hosted instance, that the signed-in user's token is issued and the inference
 * server accepts it.
 *
 * Until the first check answers, the allowance counts as connected, so a page load does not flash
 * the connect options at a new visitor. Once a check fails it counts as not connected, and the check
 * runs again every minute until one passes.
 */

export type AllowanceState = 'unknown' | 'available' | 'unavailable';

export interface AllowanceStatus {
  state: AllowanceState;
  /** A check is running. */
  checking: boolean;
}

/** Dispatched on window whenever the status changes. */
export const ALLOWANCE_STATUS_EVENT = 'allowanceStatusChanged';

/** How long an answer stands before a check runs again. */
const FRESH_MS: Record<Exclude<AllowanceState, 'unknown'>, number> = { available: 5 * 60_000, unavailable: 60_000 };
const RETRY_MS = 60_000;
/** Past the server's own waits (the gateway's token, then the inference server). */
const TIMEOUT_MS = 20_000;

let status: AllowanceStatus = { state: 'unknown', checking: false };
let checkedAt = 0;
let running: Promise<AllowanceState> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

export function allowanceStatus(): AllowanceStatus {
  return status;
}

/** Whether the allowance counts as connected: offered here, and not refused by the last check. */
export function allowanceUsable(): boolean {
  return freeAllowanceOffered() && status.state !== 'unavailable';
}

function update(next: AllowanceStatus): void {
  const before = status;
  status = next;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ALLOWANCE_STATUS_EVENT, { detail: next }));
  // Connectedness changed: readiness, the connect options and the model lists read it again.
  if ((before.state === 'unavailable') !== (next.state === 'unavailable')) {
    window.dispatchEvent(new CustomEvent('modelConfigChanged'));
  }
}

/** Run the check, unless a recent answer stands (`force` runs it anyway). Concurrent callers share one. */
export function checkAllowance(options: { force?: boolean } = {}): Promise<AllowanceState> {
  if (!freeAllowanceOffered()) return Promise.resolve(status.state);
  if (running) return running;
  const { state } = status;
  if (!options.force && state !== 'unknown' && Date.now() - checkedAt < FRESH_MS[state]) return Promise.resolve(state);

  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  update({ state, checking: true });
  running = (async () => {
    let next: AllowanceState = 'unavailable';
    try {
      const res = await fetch('/api/inference/status', { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const data = (await res.json().catch(() => null)) as { available?: unknown } | null;
      if (res.ok && data?.available === true) next = 'available';
    } catch {
      // Nothing answered in time: unavailable.
    }
    checkedAt = Date.now();
    update({ state: next, checking: false });
    if (next === 'unavailable') {
      retry = setTimeout(() => {
        retry = null;
        void checkAllowance({ force: true });
      }, RETRY_MS);
    }
    return next;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Back to never checked, with no retry pending. For tests. */
export function resetAllowanceStatus(): void {
  if (retry) clearTimeout(retry);
  retry = null;
  running = null;
  checkedAt = 0;
  status = { state: 'unknown', checking: false };
}
