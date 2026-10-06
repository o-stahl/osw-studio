import type { InterviewItem } from './types';

export interface ItemCheckResult {
  itemId: string;
  passed: boolean;
  reason?: string;
}

export interface ItemSummary {
  id: string;
  elicit: string;
  passed: boolean;
  reason?: string;
}

/** Opening of the incomplete-feedback message — also used to skip rendering it twice in the UI. */
export const INCOMPLETE_PREFIX = "Not done yet —"; // i18n-ignore: opens feedback sent to the agent

/**
 * Rolls per-assertion results up to one verdict per required item. A required
 * item passes only if it has at least one result and all of its results passed
 * (no results = could not verify = fail closed). Optional items are excluded.
 */
export function summarizeCompletion(
  items: InterviewItem[],
  results: ItemCheckResult[]
): ItemSummary[] {
  const byItem = new Map<string, ItemCheckResult[]>();
  for (const r of results) {
    const arr = byItem.get(r.itemId) ?? [];
    arr.push(r);
    byItem.set(r.itemId, arr);
  }

  return items
    .filter(i => i.required !== false)
    .map(item => {
      const rs = byItem.get(item.id) ?? [];
      const passed = rs.length > 0 && rs.every(r => r.passed);
      const reason = rs.filter(r => !r.passed).map(r => r.reason).filter(Boolean).join('; ') || undefined;
      return { id: item.id, elicit: item.elicit, passed, reason };
    });
}

/**
 * Decides whether an interview is complete. Returns null when every required
 * item is satisfied, otherwise a feedback string naming the unmet items —
 * which the completion gate hands back to the agent so it keeps working.
 */
export function buildCompletionFeedback(
  items: InterviewItem[],
  results: ItemCheckResult[]
): string | null {
  const unmet = summarizeCompletion(items, results).filter(s => !s.passed);
  if (unmet.length === 0) return null;

  const lines = unmet.map(s => `- ${s.elicit}${s.reason ? ` (${s.reason})` : ''}`);
  return `${INCOMPLETE_PREFIX} these items aren't fully captured in the artifact:\n${lines.join('\n')}\n\nGather what's missing, record it into the artifact, then run status --complete again.`;
}
