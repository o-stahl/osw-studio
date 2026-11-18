import { parseCommand, toolCommand } from '@/lib/agent-activity/parse-command';
import { OVERRIDES_PATH } from '@/lib/direct-edit/overrides-css';
import { extractPartialCmd } from '@/components/chat-panel/event-processor';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * Which files a run is writing, read off its events, for Canvas's agent outline: the artboards of
 * pages that use one of them. Derived from the writes rather than announced by the agent, so the
 * outline cannot be left on by a run that forgot to clear it.
 *
 * A write counts while its command is still streaming in, while it runs, and for `HOLD_MS` after,
 * so a write that runs in a millisecond still shows, and a run of them reads as one stretch.
 */

export const HOLD_MS = 2000;

/** How far back to look: a run's last few tool calls are well within this. */
const WINDOW = 120;

/** Action kinds that change files. */
const WRITES = new Set(['write', 'edit', 'create', 'delete', 'move', 'copy']);

export interface AgentWrite {
  /** The files the command names. A `style` command names `/overrides.css` and its element's file. */
  paths: string[];
  /** A `style` command, which changes one element rather than everything its stylesheet styles. */
  style: boolean;
  /** For a `style @marker` command, the marker. */
  marker?: string;
}

function writeOf(command: string | null): AgentWrite | null {
  if (!command) return null;
  const action = parseCommand(command);
  if (!action || !WRITES.has(action.kind) || action.paths.length === 0) return null;
  const style = /^\s*style\b/.test(command);
  const marker = style ? command.match(/\s@([A-Za-z0-9_-]+)/)?.[1] : undefined;
  return { paths: action.paths, style, ...(marker ? { marker } : {}) };
}

/** The writes under way at `now` in a project's events. */
export function agentWrites(events: readonly DebugEvent[], now: number): AgentWrite[] {
  const out: AgentWrite[] = [];
  /** Tool calls whose latest status was seen, walking back: `true` while it still counts. */
  const settled = new Map<string, boolean>();
  const streamed = new Map<string, string>();
  for (let i = events.length - 1; i >= Math.max(0, events.length - WINDOW); i--) {
    const e = events[i];
    if (e.event === 'tool_status') {
      const id = e.data?.toolCallId as string | undefined;
      const status = e.data?.status as string | undefined;
      if (!id) continue;
      if (!settled.has(id)) {
        // The latest status of this call: running counts; finished counts for a moment.
        settled.set(id, status === 'executing' || ((status === 'completed' || status === 'failed') && now - e.timestamp <= HOLD_MS));
      }
      // The arguments are on the `executing` status, which comes before the one that ended it.
      if (status === 'executing' && settled.get(id)) {
        const write = writeOf(toolCommand(e.data?.args));
        if (write) out.push(write);
        settled.set(id, false);
      }
      continue;
    }
    if (e.event === 'tool_param_delta') {
      const fragments = (e.data?.all ?? [e.data]) as { toolId?: string; fragment?: string; partialArguments?: string }[];
      for (const f of fragments) {
        if (!f?.toolId) continue;
        streamed.set(f.toolId, (streamed.get(f.toolId) ?? '') + (f.fragment ?? f.partialArguments ?? ''));
      }
    }
  }
  // A call still being written by the model has arguments and no status yet.
  for (const [id, raw] of streamed) {
    if (settled.has(id)) continue;
    const write = writeOf(extractPartialCmd(raw));
    if (write) out.push(write);
  }
  return out;
}

/** The pages a set of writes affects, given each page's files and compiled HTML. */
export function pagesWritten(
  writes: readonly AgentWrite[],
  pages: ReadonlyMap<string, { html: string }>,
  deps: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const write of writes) {
    // A style change is to one element: its page or partial, or wherever its marker is, not every
    // page that links /overrides.css.
    const files = write.style ? write.paths.filter((path) => path !== OVERRIDES_PATH) : write.paths;
    for (const [page, compiled] of pages) {
      const uses = deps?.get(page);
      if (files.some((file) => file === page || uses?.has(file))) out.add(page);
      else if (write.marker && compiled.html.includes(`data-osw-id="${write.marker}"`)) out.add(page);
    }
  }
  return out;
}
