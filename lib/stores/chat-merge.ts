import type { DebugEvent } from './types';

/** What identifies an event the server sent again, whose local id is new each time it arrives. */
function replayKey(event: DebugEvent): string | null {
  const data = event.data;
  // The server's own id for the event, with its run, since ids start over when the server restarts.
  // The stored copy keeps it however this tab has changed the event since.
  if (data?.sourceTaskId && data?.sourceEventId !== undefined) return `sse:${data.sourceTaskId}:${data.sourceEventId}`;
  if (event.event === 'conversation_message' && data?.message?.role === 'user') {
    return `user:${JSON.stringify(data.message.content)}`;
  }
  if (event.event === 'waiting') return 'waiting';
  if (data?.sourceTaskId || data?.recovered) return `${event.event}:${JSON.stringify(data)}`;
  return null;
}

/**
 * The stored chat with newer events added: one with a stored id replaces it, one the server
 * replayed and the chat already has is dropped, and the rest follow in order.
 */
export function mergeChatEvents(stored: DebugEvent[], incoming: DebugEvent[], max: number): DebugEvent[] {
  const merged = [...stored];
  const at = new Map(stored.map((event, index) => [event.id, index]));
  const fresh = incoming.filter(event => {
    const index = at.get(event.id);
    if (index === undefined) return true;
    merged[index] = event;
    return false;
  });

  const available = new Map<string, number>();
  const matched = new Set(incoming.map(event => event.id));
  for (const event of stored) {
    const key = matched.has(event.id) ? null : replayKey(event);
    if (key) available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const event of fresh) {
    const key = replayKey(event);
    const left = key ? available.get(key) ?? 0 : 0;
    if (key && left > 0) available.set(key, left - 1);
    else merged.push(event);
  }
  return merged.slice(-max);
}
