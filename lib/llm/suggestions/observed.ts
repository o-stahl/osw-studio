/**
 * How models have actually done in this browser: the one signal that is about OSWS rather than
 * someone else's benchmark.
 *
 * Kept per viewer in localStorage. It is a convenience, not a record anyone else reads, so a private
 * window or cleared storage only means suggestions fall back to the benchmark order. A busy model is
 * also remembered in memory for a few minutes, so the next suggestion skips it instead of walking
 * straight back into the same wall.
 */

const STORAGE_KEY = 'osw-model-observed';
/** How long a model that just said "busy" is passed over. */
export const BUSY_COOLDOWN_MS = 10 * 60_000;
/**
 * How long a model that refused the request is passed over. OpenRouter refuses some free models to
 * every app not on its list ("only available on agentic harnesses"), which a few minutes do not
 * change, so this one is kept in storage and outlives a reload.
 */
export const REFUSED_COOLDOWN_MS = 24 * 60 * 60_000;
const REFUSED_KEY = 'osw-model-refused';

type ModelOutcome = 'ok' | 'busy' | 'unavailable' | 'refused' | 'tool_failure';

export interface ObservedModel {
  ok: number;
  fail: number;
}

const busyUntil = new Map<string, number>();

const id = (provider: string, model: string) => `${provider}|${model}`;

function read(): Record<string, ObservedModel> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, ObservedModel>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: suggestions still work from the benchmark order.
  }
}

function readRefused(now: number): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(REFUSED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, number>).filter(([, until]) => typeof until === 'number' && until > now));
  } catch {
    return {};
  }
}

export function recordModelOutcome(provider: string, model: string, outcome: ModelOutcome, now = Date.now()): void {
  const key = id(provider, model);
  if (outcome === 'busy' || outcome === 'unavailable') busyUntil.set(key, now + BUSY_COOLDOWN_MS);
  if (outcome === 'refused') {
    // Says nothing about how well the model works, only that it will not take this app's requests.
    try {
      globalThis.localStorage?.setItem(REFUSED_KEY, JSON.stringify({ ...readRefused(now), [key]: now + REFUSED_COOLDOWN_MS }));
    } catch { /* storage unavailable: the in-memory cooldown below still holds for this page */ }
    busyUntil.set(key, now + REFUSED_COOLDOWN_MS);
    return;
  }
  // Busy says nothing about the model's ability. A working turn counts for it; a failed tool call,
  // or a model that is not there to answer, counts against it.
  if (outcome === 'busy') return;
  const all = read();
  const entry = all[key] ?? { ok: 0, fail: 0 };
  if (outcome === 'ok') entry.ok += 1;
  else entry.fail += 1;
  all[key] = entry;
  write(all);
}

/** What a stopped task says about the model it stopped on, from the stop's category. */
export function outcomeForStop(category: string): 'busy' | 'unavailable' | 'refused' | null {
  if (category === 'model_busy') return 'busy';
  if (category === 'model_not_found') return 'unavailable';
  if (category === 'blocked') return 'refused';
  return null;
}

export function getObserved(provider: string, model: string): ObservedModel | undefined {
  return read()[id(provider, model)];
}

export function isCoolingDown(provider: string, model: string, now = Date.now()): boolean {
  const key = id(provider, model);
  const until = busyUntil.get(key);
  return (until !== undefined && until > now) || key in readRefused(now);
}

/** Test seam: forget the in-memory cooldowns. */
export function resetCooldowns(): void {
  busyUntil.clear();
}
