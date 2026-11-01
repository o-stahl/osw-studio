import { translator } from '@/lib/i18n/runtime';
import { solveTurnstile } from './turnstile';

/**
 * The page's part of the demo's trial (lib/inference/trial, on the server): when the server asks for a
 * session, run the Turnstile check in this browser and hand the solve to the server, which answers with
 * a session cookie the page cannot read. The page never holds an inference token. Concurrent callers
 * share one check, which is called off once every one of them has stopped waiting.
 */

export type TrialCheckFailure =
  /** This network has had its sessions for the day. */
  | 'trial_limit'
  /** The bot check did not pass. */
  | 'check_failed'
  /** No trial here, or nothing answered. */
  | 'unavailable';

export class TrialCheckError extends Error {
  constructor(readonly failure: TrialCheckFailure, readonly resetAt?: number) {
    super(`OSW Studio inference: ${failure}`); // i18n-ignore: a code for logs; the provider adapter writes the message people see
    this.name = 'TrialCheckError';
  }
}

const ENDPOINT = '/api/inference/trial';

let running: { done: Promise<void>; stop: AbortController; waiting: number } | null = null;
let started = 0;

/** How many sessions this page has started. A request that sees it move since it was sent needs no new check. */
export function trialSessionsStarted(): number {
  return started;
}

/**
 * A new trial session for this browser. `signal` is the caller's: once it aborts, the caller stops
 * waiting (an `AbortError`), and the check stops when nobody else is waiting for it.
 */
export function startTrialSession(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!running) {
    const stop = new AbortController();
    const entry = { stop, waiting: 0, done: start(stop.signal) };
    entry.done.finally(() => { if (running === entry) running = null; }).catch(() => {});
    running = entry;
  }
  const entry = running;
  entry.waiting++;
  return new Promise<void>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return false;
      left = true;
      entry.waiting--;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (entry.waiting === 0) {
        // Nobody left: called off, and the next caller starts a check of its own.
        entry.stop.abort(signal!.reason);
        if (running === entry) running = null;
      }
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.done.then(() => { if (leave()) resolve(); }, (err) => { if (leave()) reject(err); });
  });
}

async function start(signal: AbortSignal): Promise<void> {
  let setup: { available?: unknown; siteKey?: unknown; action?: unknown };
  try {
    setup = await (await fetch(ENDPOINT, { cache: 'no-store', signal })).json();
  } catch {
    signal.throwIfAborted();
    throw new TrialCheckError('unavailable');
  }
  if (setup.available !== true || typeof setup.siteKey !== 'string') throw new TrialCheckError('unavailable');

  let solve: string;
  try {
    solve = await solveTurnstile(setup.siteKey, typeof setup.action === 'string' ? setup.action : 'trial', translator()('allowance.checking'), { signal });
  } catch {
    signal.throwIfAborted();
    throw new TrialCheckError('check_failed');
  }

  let status: number;
  let answer: { code?: unknown; resetAt?: unknown };
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: solve }),
      signal,
    });
    status = res.status;
    answer = await res.json();
  } catch {
    signal.throwIfAborted();
    throw new TrialCheckError('unavailable');
  }

  if (status === 200) {
    started++;
    return;
  }
  if (answer.code === 'trial_limit') {
    throw new TrialCheckError('trial_limit', typeof answer.resetAt === 'number' ? answer.resetAt : undefined);
  }
  throw new TrialCheckError(answer.code === 'bot_check_failed' ? 'check_failed' : 'unavailable');
}
