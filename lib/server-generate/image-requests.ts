import type { ImageDelegationResult, ServerTask } from './types';
import type { SourceImage } from '@/lib/llm/image-gen';

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
  /** The image to start from, handed to the claiming tab rather than sent to every tab. */
  source?: SourceImage;
}

export function addImageRequest(task: ServerTask, requestId: string, resolve: PendingImageRequest['resolve'], source?: SourceImage): void {
  if (!task.pendingImages) task.pendingImages = new Map();
  task.pendingImages.set(requestId, { resolve, claimed: false, ...(source ? { source } : {}) });
}

export function dropImageRequest(task: ServerTask, requestId: string): void {
  task.pendingImages?.delete(requestId);
}

/** Take a request for this tab, if no tab has yet: false, or the request's source image if it has one. */
export function claimImageRequest(task: ServerTask, requestId: string): false | { source?: SourceImage } {
  const entry = task.pendingImages?.get(requestId);
  if (!entry || entry.claimed) return false;
  entry.claimed = true;
  return entry.source ? { source: entry.source } : {};
}

/** Hand the browser's answer to the request it belongs to. */
export function settleImageRequest(task: ServerTask, requestId: string, result: ImageDelegationResult): boolean {
  const entry = task.pendingImages?.get(requestId);
  if (!entry) return false;
  task.pendingImages!.delete(requestId);
  entry.resolve(result);
  return true;
}
