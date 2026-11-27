import 'server-only';
import { randomUUID } from 'crypto';
import { eventBus } from '@/lib/server-generate/singleton';

/**
 * Starting an agent task from MCP, by asking the open workspace tab to do it.
 *
 * A provider API key lives in the browser's localStorage and is never stored server-side, so this
 * process cannot start a task on a cloud provider by itself. The tab can: it holds the key, and it
 * already runs `startServerGeneration`. So the server emits a request on the account's SSE channel
 * and waits for the tab to post back the task id, the same shape `build_requested` and
 * `search_requested` already use.
 *
 * With no tab attached there is nothing to ask, and the caller is told so rather than left waiting.
 */

/** How long a tab has to take a request. Nothing runs if none does. */
const CLAIM_TIMEOUT_MS = 15_000;
/**
 * How long the tab that took it has to report the task. Before the task exists the tab pushes the
 * project and takes a checkpoint, which on a large project runs past a minute; answering "nothing
 * answered" before then would be wrong, since the task still starts.
 */
const START_TIMEOUT_MS = 5 * 60_000;

export interface DelegatedRunResult {
  ok: boolean;
  taskId?: string;
  error?: string;
}

interface Pending {
  resolve: (result: DelegatedRunResult) => void;
  userId: string;
  /** Set once a tab has taken the request, so only one of them runs it. */
  claimedBy?: string;
  /** Moves the deadline on to the start window once a tab has taken the request. */
  onClaimed?: () => void;
}

/**
 * Pinned to globalThis, as `server-generate/singleton.ts` pins the task manager and event bus.
 * The tool that opens a request and the route that answers it are separate entry points, and each
 * can get its own instance of this module: a plain module-level Map left the answer landing in a
 * different copy, so the route replied 404 while the task it started ran to completion.
 */
const g = globalThis as unknown as { __mcpPendingRuns?: Map<string, Pending> };
g.__mcpPendingRuns ??= new Map<string, Pending>();
const pending = g.__mcpPendingRuns;

/** Whether a workspace tab for this account is listening, so a request has somewhere to land. */
export function hasAttachedClient(userId: string): boolean {
  return eventBus.hasListener(userId);
}

export async function requestRunFromClient(input: {
  userId: string;
  projectId: string;
  prompt: string;
  chatMode: boolean;
  clientLabel: string;
}): Promise<DelegatedRunResult> {
  if (!hasAttachedClient(input.userId)) {
    return { ok: false, error: 'No OSW Studio tab is open for this account. Open the workspace in a browser, then try again: the provider key that runs the task lives there, not on the server.' };
  }

  const requestId = randomUUID();
  const result = await new Promise<DelegatedRunResult>((resolve) => {
    let timer = setTimeout(() => {
      // Not taken: deleting the entry makes a late claim fail, so nothing starts after this answer.
      pending.delete(requestId);
      resolve({ ok: false, error: 'No open OSW Studio tab took the request within 15 seconds, so nothing was started. The tab may be busy or was closed.' });
    }, CLAIM_TIMEOUT_MS);

    pending.set(requestId, {
      userId: input.userId,
      resolve: (r) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(r);
      },
      onClaimed: () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          // Taken but not reported. The entry stays claimed, so no other tab starts a second run;
          // whether this one did, the task list says.
          resolve({ ok: false, error: 'An OSW Studio tab took the request but has not reported a task after 5 minutes. The task may still start: check agent_list for this project before asking again.' });
          // A tab that never reports (closed mid-start) would otherwise leave the entry for good.
          timer = setTimeout(() => pending.delete(requestId), 30 * 60_000);
        }, START_TIMEOUT_MS);
      },
    });

    // taskId doubles as the buffer key on the bus; a request has no task yet, so it carries its own id.
    eventBus.emit(requestId, input.projectId, 'mcp_run_requested', {
      requestId,
      projectId: input.projectId,
      prompt: input.prompt,
      chatMode: input.chatMode,
      clientLabel: input.clientLabel,
    }, input.userId);
  });

  eventBus.clearTask(requestId);
  return result;
}

/**
 * Take a request, if nobody has yet.
 *
 * The request goes to every tab the account has open, and each one would otherwise start its own
 * task: two tabs meant two agent runs on one project, two sets of edits racing, and one of them
 * orphaned because only the first answer is used. The first tab to claim runs it; the rest stop.
 */
export function claimRunRequest(requestId: string, userId: string, claimant: string): boolean {
  const entry = pending.get(requestId);
  if (!entry || entry.userId !== userId) return false;
  if (entry.claimedBy) return false;
  entry.claimedBy = claimant;
  entry.onClaimed?.();
  return true;
}

/** The tab's answer. Scoped to the account that asked, so another session cannot resolve it. */
export function settleRunRequest(requestId: string, userId: string, result: DelegatedRunResult): boolean {
  const entry = pending.get(requestId);
  if (!entry || entry.userId !== userId) return false;
  entry.resolve(result);
  return true;
}
