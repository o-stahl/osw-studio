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

type ModelOutcome = 'ok' | 'busy' | 'unavailable' | 'tool_failure';

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

export function recordModelOutcome(provider: string, model: string, outcome: ModelOutcome, now = Date.now()): void {
  const key = id(provider, model);
  if (outcome === 'busy' || outcome === 'unavailable') busyUntil.set(key, now + BUSY_COOLDOWN_MS);
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

export function getObserved(provider: string, model: string): ObservedModel | undefined {
  return read()[id(provider, model)];
}

export function isCoolingDown(provider: string, model: string, now = Date.now()): boolean {
  const until = busyUntil.get(id(provider, model));
  return until !== undefined && until > now;
}

/** Test seam: forget the in-memory cooldowns. */
export function resetCooldowns(): void {
  busyUntil.clear();
}
