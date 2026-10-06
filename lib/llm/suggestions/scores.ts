import bundled from './bundled-scores.json';
import type { ScoreSnapshot } from './snapshot';

/**
 * The scores suggestions rank by: a live copy from the last day when there is one, else the copy
 * bundled with this build. Stored per viewer; losing it only means the bundled figures are used.
 */

const STORAGE_KEY = 'osw-model-scores';
const MAX_AGE_MS = 24 * 60 * 60_000;
/** After a failed refresh, wait this long before asking again; the Data API counts every request. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
const ATTEMPT_KEY = 'osw-model-scores-attempt';

interface StoredScores {
  fetchedAt: number;
  snapshot: ScoreSnapshot;
}

const BUNDLED_SCORES: ScoreSnapshot = bundled as ScoreSnapshot;

function readStored(): StoredScores | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredScores) : null;
    return parsed?.snapshot?.models && typeof parsed.fetchedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function getScores(): ScoreSnapshot {
  return readStored()?.snapshot ?? BUNDLED_SCORES;
}

let refreshing: Promise<void> | null = null;

/** Kept in memory as well, so a browser without storage still waits between failed attempts. */
let attemptedAt = 0;

/** When a refresh was last tried, successful or not. A success also leaves a fresh copy above. */
function lastAttempt(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(ATTEMPT_KEY));
    return Math.max(attemptedAt, Number.isFinite(stored) ? stored : 0);
  } catch {
    return attemptedAt;
  }
}

/**
 * Refresh from OpenRouter's Data API with the user's own key, at most once a day. The Data API
 * allows 500 requests a day per account, and this uses two.
 */
export function refreshScores(openRouterKey: string | null | undefined, now = Date.now()): Promise<void> {
  if (!openRouterKey) return Promise.resolve();
  const stored = readStored();
  if (stored && now - stored.fetchedAt < MAX_AGE_MS) return Promise.resolve();
  if (refreshing) return refreshing;
  const last = lastAttempt();
  if (last > 0 && now - last < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  refreshing = (async () => {
    attemptedAt = now;
    try {
      globalThis.localStorage?.setItem(ATTEMPT_KEY, String(now));
      const { apiFetch } = await import('@/lib/api/backend-status');
      const response = await apiFetch('/api/model-scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: openRouterKey }),
      });
      if (!response.ok) return;
      const snapshot = (await response.json()) as ScoreSnapshot;
      if (!snapshot?.models || Object.keys(snapshot.models).length === 0) return;
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt: now, snapshot } satisfies StoredScores));
    } catch {
      // Keep whatever we had; the bundled copy is always there.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
