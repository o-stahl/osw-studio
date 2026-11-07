import type { DebugEvent } from '@/lib/stores/types';
import { EventProcessor, type ToolCall, type TurnItem } from '@/components/chat-panel/event-processor';
import { buildTally, type TallyStep } from './tally';
import { describeCommand, type FormingStep } from './forming';

/**
 * One row of an opened group: a stretch of the model's reasoning, a step and the calls behind it, or
 * the call the model is writing now, before it runs.
 */
export type DetailRow =
  | { kind: 'reasoning'; key: string; text: string; complete: boolean }
  | { kind: 'step'; key: string; step: TallyStep; calls: ToolCall[] }
  | { kind: 'forming'; key: string; step: FormingStep; call: ToolCall };

/**
 * What an opened group shows: its reasoning and its steps, in the order they happened.
 *
 * Read from the group's own events when it opens, through the chat panel's `EventProcessor`, which
 * reads each call's command, output and status off those events. The steps are tallied
 * again between stretches of reasoning: a repeat on either side of a thought is two rows, each where
 * it happened, where the closed group's sentence counted it once.
 *
 * A group that is no longer `live` shows nothing as happening: its reasoning is finished and no call
 * is being written, whatever the run was in the middle of when it ended.
 */
export function stepDetail(events: DebugEvent[], live: boolean): DetailRow[] {
  const items = new EventProcessor().process(events).flatMap((turn) => turn.items);
  const thoughts = new Map<string, TurnItem>();
  const calls = new Map<string, ToolCall>();
  for (const item of items) {
    if (item.type === 'reasoning' && item.eventId) thoughts.set(item.eventId, item);
    if (item.type === 'tool') calls.set((item.data as ToolCall).id, item.data as ToolCall);
  }

  const rows: DetailRow[] = [];
  const emit = (part: DebugEvent[]) => {
    for (const step of buildTally(part).steps) {
      rows.push({
        kind: 'step',
        key: step.callIds[0] ?? `step-${rows.length}`,
        step,
        calls: step.callIds.map((id) => calls.get(id)).filter((call): call is ToolCall => call !== undefined),
      });
    }
  };

  let stretch: DebugEvent[] = [];
  /** Where the current response's events begin in `stretch`, and whether its reasoning was streamed. */
  let responseAt = 0;
  let thoughtStreamed = false;
  /** The calls the current response has opened. */
  let responseCalls = new Set<string>();
  for (const event of events) {
    if (event.event === 'iteration') {
      responseAt = stretch.length;
      thoughtStreamed = false;
      responseCalls = new Set();
    }
    if (event.event === 'toolCalls') {
      for (const call of (event.data as { toolCalls?: Array<{ id?: unknown }> } | undefined)?.toolCalls ?? []) {
        if (typeof call?.id === 'string') responseCalls.add(call.id);
      }
    }
    if (event.event === 'tool_param_delta') {
      const data = event.data as { all?: Array<{ toolId?: unknown }>; toolId?: unknown } | undefined;
      for (const fragment of data?.all ?? [data]) {
        if (typeof fragment?.toolId === 'string') responseCalls.add(fragment.toolId);
      }
    }
    const thought = event.event === 'reasoning_delta' ? thoughts.get(event.id) : undefined;
    if (thought) {
      emit(stretch);
      stretch = [];
      responseAt = 0;
      thoughtStreamed = true;
      rows.push({ kind: 'reasoning', key: event.id, text: String(thought.data ?? ''), complete: !live || thought.complete === true });
      continue;
    }
    // Reasoning that came only with the finished message, as on a replayed server run: it was
    // thought before the response's tools ran, so it goes where the response began.
    const message = event.event === 'conversation_message'
      ? (event.data as { message?: { role?: string; reasoning_details?: Array<{ text?: unknown }> } } | undefined)?.message
      : undefined;
    const details = message?.role === 'assistant' && !thoughtStreamed
      ? (message.reasoning_details ?? []).map((d) => (typeof d?.text === 'string' ? d.text.trim() : '')).filter(Boolean)
      : [];
    if (details.length > 0) {
      emit(stretch.slice(0, responseAt));
      stretch = stretch.slice(responseAt);
      responseAt = 0;
      thoughtStreamed = true;
      details.forEach((text, i) => rows.push({ kind: 'reasoning', key: `${event.id}-${i}`, text, complete: true }));
    }
    stretch.push(event);
  }
  emit(stretch);

  // The call being written: the newest of the current response's calls that has not started, while
  // none of them is running. One an earlier response left unrun, as the wrong-tool retry leaves one,
  // is not being written.
  const tools = items.filter((item) => item.type === 'tool').map((item) => item.data as ToolCall);
  const writing = !live || tools.some((tool) => tool.status === 'executing')
    ? undefined
    : tools.filter((tool) => tool.status === 'pending' && responseCalls.has(tool.id)).pop();
  if (writing) {
    const command = writing.parameters?.command ?? writing.parameters?.cmd;
    const step = (typeof command === 'string' ? describeCommand(command) : null) ?? { kind: 'other' as const, path: null, lines: 0 };
    rows.push({ kind: 'forming', key: writing.id, step, call: writing });
  }
  return rows;
}

/** Reasoning as a line of words: markdown's code marks dropped, whitespace run together. */
function plainReasoning(text: string): string {
  return text.replace(/```[\w-]*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/** A finished stretch of reasoning as its row shows it: its first paragraph, on one line. */
export function reasoningHead(text: string): string {
  return plainReasoning(text.trim().split(/\n\s*\n/)[0] ?? '');
}

/**
 * Reasoning still being written, as its row shows it: the newest words, starting at a word, with
 * "…" in front when anything came before them.
 */
export function reasoningTail(text: string, length = 80): string {
  const flat = plainReasoning(text);
  if (flat.length <= length) return flat;
  const from = flat.indexOf(' ', flat.length - length);
  return from === -1 ? `…${flat.slice(-length)}` : `…${flat.slice(from + 1)}`;
}
