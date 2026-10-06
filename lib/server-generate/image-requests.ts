import type { ImageDelegationResult, ServerTask } from './types';

/**
 * Image generations a server-side run has handed to the browser, keyed by request id.
 *
 * A run can ask for several at once (sub-agents run in parallel), so each answer has to reach the
 * request it belongs to. The request also reaches every tab the account has open, and each would
 * otherwise generate (and pay for) its own image; the first tab to claim a request makes it.
 */
export interface PendingImageRequest {
  resolve: (result: ImageDelegationResult) => void;
  claimed: boolean;
}

export function addImageRequest(task: ServerTask, requestId: string, resolve: PendingImageRequest['resolve']): void {
  if (!task.pendingImages) task.pendingImages = new Map();
  task.pendingImages.set(requestId, { resolve, claimed: false });
}

export function dropImageRequest(task: ServerTask, requestId: string): void {
  task.pendingImages?.delete(requestId);
}

/** Take a request for this tab, if no tab has yet. */
export function claimImageRequest(task: ServerTask, requestId: string): boolean {
  const entry = task.pendingImages?.get(requestId);
  if (!entry || entry.claimed) return false;
  entry.claimed = true;
  return true;
}

/** Hand the browser's answer to the request it belongs to. */
export function settleImageRequest(task: ServerTask, requestId: string, result: ImageDelegationResult): boolean {
  const entry = task.pendingImages?.get(requestId);
  if (!entry) return false;
  task.pendingImages!.delete(requestId);
  entry.resolve(result);
  return true;
}
