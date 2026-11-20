/**
 * Holds a project's pushes to the server while something else is writing its server copy.
 *
 * A server run writes the project on the server and this tab mirrors those writes as they arrive.
 * A push in that window carries a revision the run has already moved past, and its file delta is
 * taken against a copy still changing. So the push waits, and goes out when the run's end has been
 * pulled. Who holds a project is asked of whoever knows (the store's running tasks), not recorded
 * here, so a hold cannot outlive its run.
 */

let held: (projectId: string) => boolean = () => false;
let push: ((projectId: string) => void) | null = null;
const waiting = new Set<string>();

/** Whether a project's server copy is being written by a run this tab follows. */
export function setPushGate(isHeld: (projectId: string) => boolean): void {
  held = isHeld;
}

/** What sends a project to the server once it may go. */
export function setHeldPushSender(send: (projectId: string) => void): void {
  push = send;
}

/** True when the push has to wait; it is remembered and sent by `releaseHeldPush`. */
export function holdPush(projectId: string): boolean {
  if (!held(projectId)) return false;
  waiting.add(projectId);
  return true;
}

/** Send the push that waited, if one did. */
export function releaseHeldPush(projectId: string): void {
  if (held(projectId) || !waiting.delete(projectId)) return;
  push?.(projectId);
}

/** Ask for a push: now, or when the project is released. */
export function requestPush(projectId: string): void {
  if (holdPush(projectId)) return;
  // This push carries whatever one that waited would have.
  waiting.delete(projectId);
  push?.(projectId);
}
